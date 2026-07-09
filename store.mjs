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
// Stopwords ES/EN comunes; tokeniza conservando ':' y '_' (groups-claim, snake_case).
const STOP = new Set('the and for are with that this its you our from into not but has have was were will can los las una unos unas del que con por para como más pero sus este esta esto son ser una the'.split(/\s+/));
function tokenize(q) {
  return [...new Set((q.toLowerCase().match(/[a-z0-9_:]{3,}/g) || []).filter(t => !STOP.has(t)))];
}

// Búsqueda top-k. Con `queryText` hace HÍBRIDA (vector + léxico fusionados por RRF); sin él, vector puro.
export function searchChunks(db, qvec, { project = null, k = 8, since = null, recencyBoost = 0.05, queryText = null } = {}) {
  let sql = 'SELECT project, session, ts, role, text, embedding FROM chunks WHERE embedding IS NOT NULL';
  const params = [];
  if (project) { sql += ' AND project = ?'; params.push(project); }
  if (since)   { sql += ' AND ts >= ?';     params.push(since); }
  const rows = db.prepare(sql).all(...params);

  const now = Date.now();
  const recency = (ts) => (recencyBoost && ts) ? recencyBoost * Math.exp(-((now - Date.parse(ts)) / 86400000) / 45) : 0;
  const cand = rows.map((r, i) => ({ i, r, sim: dot(qvec, blobToVec(r.embedding)), lc: r.text.toLowerCase() }));

  const terms = queryText ? tokenize(queryText) : [];
  let scored;
  if (terms.length) {
    // léxico: solapamiento de términos ponderado por rareza (idf sobre el set candidato)
    const N = cand.length, idf = {};
    for (const t of terms) {
      let df = 0; for (const c of cand) if (c.lc.includes(t)) df++;
      idf[t] = Math.log(1 + N / (df + 1));
    }
    for (const c of cand) c.lex = terms.reduce((s, t) => s + (c.lc.includes(t) ? idf[t] : 0), 0);
    // RRF: fusiona el ranking por vector y el ranking por léxico (robusto, sin normalizar escalas)
    const byVec = [...cand].sort((a, b) => b.sim - a.sim);
    const byLex = cand.filter(c => c.lex > 0).sort((a, b) => b.lex - a.lex);
    const RRF = 60, rrf = new Map();
    byVec.forEach((c, idx) => rrf.set(c.i, (rrf.get(c.i) || 0) + 1 / (RRF + idx + 1)));
    byLex.forEach((c, idx) => rrf.set(c.i, (rrf.get(c.i) || 0) + 1 / (RRF + idx + 1)));
    scored = cand.map(c => ({ project: c.r.project, session: c.r.session, ts: c.r.ts, role: c.r.role, text: c.r.text, score: rrf.get(c.i) || 0, sim: c.sim }));
  } else {
    scored = cand.map(c => ({ project: c.r.project, session: c.r.session, ts: c.r.ts, role: c.r.role, text: c.r.text, score: c.sim + recency(c.r.ts), sim: c.sim }));
  }

  scored.sort((a, b) => b.score - a.score);
  // dedup: el mismo texto aparece bajo varios paths/proyectos y desperdicia slots del top-k.
  const seen = new Set(), out = [];
  for (const s of scored) {
    const key = s.text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= k) break;
  }
  return out;
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
