// Almacenamiento: SQLite integrado de Node (node:sqlite, sin compilación nativa).
// Los embeddings se guardan como BLOB (Float32Array) y la búsqueda es coseno por fuerza
// bruta en JS — a esta escala (decenas de miles de chunks) es instantáneo y sin dependencias.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const DB_PATH = process.env.BRAIN_DB || join(BRAIN_DIR, 'brain.db');

export function openDb() {
  mkdirSync(BRAIN_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 8000;
    CREATE TABLE IF NOT EXISTS sessions (
      path       TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      session    TEXT,
      mtime      INTEGER NOT NULL,
      bytes      INTEGER NOT NULL,
      chunks     INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      path      TEXT NOT NULL,
      project   TEXT NOT NULL,
      session   TEXT,
      ts        TEXT,
      role      TEXT,
      text      TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path    ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project);
  `);
  return db;
}

// Float32Array -> BLOB y viceversa
export function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}
function blobToVec(u8) {
  return new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
}

// Coseno = producto punto (los vectores vienen normalizados del embedder).
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Búsqueda top-k. project opcional (filtro exacto), since opcional (ISO date mínima).
// recencyBoost: mezcla similitud con recencia para que lo reciente pese un poco más.
export function searchChunks(db, qvec, { project = null, k = 8, since = null, recencyBoost = 0.15 } = {}) {
  let sql = 'SELECT project, session, ts, role, text, embedding FROM chunks WHERE embedding IS NOT NULL';
  const params = [];
  if (project) { sql += ' AND project = ?'; params.push(project); }
  if (since)   { sql += ' AND ts >= ?';     params.push(since); }
  const rows = db.prepare(sql).all(...params);

  const now = Date.now();
  const scored = rows.map(r => {
    const sim = dot(qvec, blobToVec(r.embedding));
    let boost = 0;
    if (recencyBoost && r.ts) {
      const ageDays = (now - Date.parse(r.ts)) / 86400000;
      boost = recencyBoost * Math.exp(-ageDays / 45); // decae ~1.5 meses
    }
    return { project: r.project, session: r.session, ts: r.ts, role: r.role, text: r.text, score: sim + boost, sim };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function listProjects(db) {
  return db.prepare(`
    SELECT project,
           COUNT(DISTINCT session) AS sessions,
           COUNT(*)                AS chunks,
           MAX(ts)                 AS last_activity
    FROM chunks GROUP BY project ORDER BY last_activity DESC
  `).all();
}

export function stats(db) {
  const s = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT project) p FROM sessions').get();
  const c = db.prepare('SELECT COUNT(*) n, SUM(embedding IS NOT NULL) e FROM chunks').get();
  return { sessions: s.n, projects: s.p, chunks: c.n, embedded: c.e ?? 0 };
}
