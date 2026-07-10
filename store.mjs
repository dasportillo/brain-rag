// Storage: Node's built-in SQLite (node:sqlite, no native compilation).
// Embeddings are stored as a BLOB (Float32Array) and search is brute-force cosine
// in JS — at this scale (tens of thousands of chunks) it's instant and dependency-free.
import './quiet.mjs'; // silence node:sqlite's ExperimentalWarning — must run before node:sqlite loads
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
// Loaded dynamically (after quiet.mjs) so the experimental warning is suppressed for every entry point.
const { DatabaseSync } = await import('node:sqlite');

export const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const DB_PATH = process.env.BRAIN_DB || join(BRAIN_DIR, 'brain.db');

// PROJECT ALIASES (optional): merge fragmented project names into one canonical project so
// list_projects / search / get_state treat e.g. efy3, efy3-efy-experience, efy3-efy3-users as ONE.
// Format of ~/.claude/brain/aliases.json:  { "<canonical>": ["<memberFragment>", ...] }
// Absent or malformed file => identity mapping (zero behavior change). See aliases.example.json.
const ALIAS_PATH = process.env.BRAIN_ALIASES || join(BRAIN_DIR, 'aliases.json');
let ALIASES = {};
try { if (existsSync(ALIAS_PATH)) ALIASES = JSON.parse(readFileSync(ALIAS_PATH, 'utf8')); }
catch (e) { ALIASES = {}; console.error(`brain: ignoring malformed ${ALIAS_PATH} (${e.message})`); } // stderr: safe for MCP stdio + CLI
const _memberToCanon = new Map();
for (const [canon, members] of Object.entries(ALIASES)) {
  _memberToCanon.set(canon, canon);
  if (Array.isArray(members)) for (const m of members) _memberToCanon.set(m, canon);
}
// Raw project name -> its canonical name (itself if not aliased).
export function canonicalProject(name) {
  return name ? (_memberToCanon.get(name) || name) : name;
}
// Every raw project name that shares `name`'s canonical (incl. itself) — for expanding a filter.
export function aliasMembers(name) {
  if (!name) return []; // never feed an empty/undefined name into an `IN (...)` expansion
  const canon = canonicalProject(name);
  const out = new Set([name, canon]);
  if (Array.isArray(ALIASES[canon])) for (const m of ALIASES[canon]) out.add(m);
  return [...out];
}

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
  // migration: per-session title (Claude Code's ai-title). Ignore if the column already exists.
  try { db.exec('ALTER TABLE sessions ADD COLUMN title TEXT'); } catch { /* already present */ }
  return db;
}

// Float32Array -> BLOB and back
export function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}
function blobToVec(u8) {
  return new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
}

// Cosine = dot product (vectors come normalized from the embedder).
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Top-k search. project optional (exact filter), since optional (min ISO date).
// recencyBoost: mixes similarity with recency so recent items weigh a bit more.
// Common English stopwords; tokenizes keeping ':' and '_' (groups-claim, snake_case).
const STOP = new Set('the and for are with that this its you our from into not but has have was were will can'.split(/\s+/));
function tokenize(q) {
  return [...new Set((q.toLowerCase().match(/[a-z0-9_:]{3,}/g) || []).filter(t => !STOP.has(t)))];
}

// Top-k search. With `queryText` it goes HYBRID (vector + lexical fused via RRF); without it, pure vector.
export function searchChunks(db, qvec, { project = null, k = 8, since = null, recencyBoost = 0.05, queryText = null } = {}) {
  let sql = 'SELECT project, session, ts, role, text, embedding FROM chunks WHERE embedding IS NOT NULL';
  const params = [];
  if (project) {
    // expand the filter to every raw project name sharing this project's canonical (alias-aware)
    const members = aliasMembers(project);
    sql += ` AND project IN (${members.map(() => '?').join(',')})`;
    params.push(...members);
  }
  if (since)   { sql += ' AND ts >= ?';     params.push(since); }
  const rows = db.prepare(sql).all(...params);

  const now = Date.now();
  const recency = (ts) => (recencyBoost && ts) ? recencyBoost * Math.exp(-((now - Date.parse(ts)) / 86400000) / 45) : 0;
  const cand = rows.map((r, i) => { const vec = blobToVec(r.embedding); return { i, r, vec, sim: dot(qvec, vec), lc: r.text.toLowerCase() }; });

  const terms = queryText ? tokenize(queryText) : [];
  let scored;
  if (terms.length) {
    // lexical: term overlap weighted by rarity (idf over the candidate set)
    const N = cand.length, idf = {};
    for (const t of terms) {
      let df = 0; for (const c of cand) if (c.lc.includes(t)) df++;
      idf[t] = Math.log(1 + N / (df + 1));
    }
    for (const c of cand) c.lex = terms.reduce((s, t) => s + (c.lc.includes(t) ? idf[t] : 0), 0);
    // RRF: fuses vector + lexical (+ a gentle recency signal), robust with no scale normalization.
    const RRF = 60, REC_W = 0.5, rrf = new Map();
    const fuse = (list, w = 1) => list.forEach((c, idx) => rrf.set(c.i, (rrf.get(c.i) || 0) + w / (RRF + idx + 1)));
    fuse([...cand].sort((a, b) => b.sim - a.sim));                      // vector ranking
    fuse(cand.filter(c => c.lex > 0).sort((a, b) => b.lex - a.lex));    // lexical ranking
    // recency as a third signal (half weight ⇒ worth at most ~half a vector rank; never dominates)
    if (recencyBoost) fuse(cand.filter(c => c.r.ts).sort((a, b) => Date.parse(b.r.ts) - Date.parse(a.r.ts)), REC_W);
    scored = cand.map(c => ({ project: c.r.project, session: c.r.session, ts: c.r.ts, role: c.r.role, text: c.r.text, score: rrf.get(c.i) || 0, sim: c.sim, _vec: c.vec }));
  } else {
    scored = cand.map(c => ({ project: c.r.project, session: c.r.session, ts: c.r.ts, role: c.r.role, text: c.r.text, score: c.sim + recency(c.r.ts), sim: c.sim, _vec: c.vec }));
  }

  scored.sort((a, b) => b.score - a.score);
  // dedup: the same text appears under several paths/projects and wastes top-k slots.
  const seen = new Set(), out = [];
  for (const s of scored) {
    const key = s.text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= k) break;
  }
  // TEMPORAL VERSION SIGNAL: within the returned set, flag results that are near-duplicate in TOPIC
  // (mutual cosine ≥ VSIM) but from DIFFERENT dates — i.e. the same thing at different points in time,
  // which is exactly the "old plan vs final plan" ambiguity. We never drop a result (recall is
  // preserved); we only annotate, so the reader knows a newer version exists instead of inferring it.
  const VSIM = 0.92, day = (ts) => (ts ? ts.slice(0, 10) : null);
  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      const A = out[a], B = out[b];
      if (!A._vec || !B._vec || !A.ts || !B.ts || day(A.ts) === day(B.ts)) continue;
      if (dot(A._vec, B._vec) < VSIM) continue;
      const [older, newer] = Date.parse(A.ts) <= Date.parse(B.ts) ? [A, B] : [B, A];
      if (!older.outdatedBy || day(newer.ts) > older.outdatedBy) older.outdatedBy = day(newer.ts);
      const od = day(older.ts);
      newer.supersedes ||= [];
      if (!newer.supersedes.includes(od)) newer.supersedes.push(od); // dedup: two older chunks can share a date
    }
  }
  // attach the session title (ai-title) to each hit — cheap, only for the k results.
  const titleQ = db.prepare('SELECT title FROM sessions WHERE session = ? AND title IS NOT NULL LIMIT 1');
  for (const s of out) {
    const row = s.session ? titleQ.get(s.session) : null;
    if (row?.title) s.title = row.title;
    delete s._vec; // internal only — don't leak the embedding array to callers
  }
  return out;
}

// Diff a file's existing chunk rows against freshly-computed records (matched by text), so ingest
// only embeds new/changed chunks and deletes stale ones — instead of re-embedding the whole file
// every time an active session grows.
export function diffChunks(existingRows, records) {
  const existing = new Map(existingRows.map(r => [r.text, r.id]));
  const nextTexts = new Set(records.map(r => r.text));
  const toEmbed = records.filter(r => !existing.has(r.text));                       // new/changed → embed
  const staleIds = existingRows.filter(r => !nextTexts.has(r.text)).map(r => r.id); // vanished → delete
  return { toEmbed, staleIds };
}

export function listProjects(db) {
  const rows = db.prepare(`
    SELECT project,
           COUNT(DISTINCT session) AS sessions,
           COUNT(*)                AS chunks,
           MAX(ts)                 AS last_activity
    FROM chunks GROUP BY project
  `).all();
  // Merge alias members into their canonical project. With no aliases this is a 1:1 pass-through,
  // so the output is identical to the plain GROUP BY (each project is its own canonical).
  const merged = new Map();
  for (const r of rows) {
    const canon = canonicalProject(r.project);
    const cur = merged.get(canon) || { project: canon, sessions: 0, chunks: 0, last_activity: null };
    cur.sessions += r.sessions;
    cur.chunks += r.chunks;
    if (r.last_activity && (!cur.last_activity || r.last_activity > cur.last_activity)) cur.last_activity = r.last_activity;
    merged.set(canon, cur);
  }
  return [...merged.values()].sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
}

export function stats(db) {
  const s = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT project) p FROM sessions').get();
  const c = db.prepare('SELECT COUNT(*) n, SUM(embedding IS NOT NULL) e FROM chunks').get();
  return { sessions: s.n, projects: s.p, chunks: c.n, embedded: c.e ?? 0 };
}
