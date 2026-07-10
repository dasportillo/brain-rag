// INCREMENTAL ingestion of OPTED-IN transcripts into the store (opt-in via keep.list).
//
// How it updates (the key part):
//   - Each session = one .jsonl file. We store its (mtime, bytes) in the `sessions` table.
//   - On every run, per file:
//       * if unchanged (same mtime and bytes) -> SKIP (nothing is re-embedded).
//       * if new or grown (active session) -> delete its old chunks and re-index ONLY that one.
//   - Result: the first run indexes everything; later runs only touch what's new/changed.
//
// Usage:
//   node ingest.mjs               # incremental, with embeddings
//   node ingest.mjs --no-embed    # only parse/chunk/store (fast, no model)
//   node ingest.mjs --limit 5     # process up to 5 sessions (for testing)
//   node ingest.mjs --stats       # print index status and exit
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, vecToBlob, stats } from './store.mjs';
import { parseTranscript, projectFromPath, chunkText, redact } from './transcripts.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');

// OPT-IN: by default NOTHING is indexed. Only sessions whose transcript is listed in
// keep.list get indexed. Entries are added by `BRAIN=1 claude` (the mark-keep.mjs
// SessionStart hook) or by the /brain slash command mid-session (mark-current-keep.mjs).
const KEEP_FILE = join(homedir(), '.claude', 'brain', 'keep.list');
const KEPT = new Set(
  existsSync(KEEP_FILE)
    ? readFileSync(KEEP_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : []
);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
const LIMIT = Number(val('--limit', Infinity));
const NO_EMBED = has('--no-embed');
const FORCE = has('--force'); // re-process even if unchanged (e.g. to backfill embeddings)

function findTranscripts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findTranscripts(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const db = openDb();

if (has('--stats')) {
  console.log(stats(db));
  process.exit(0);
}

// The embedder is imported lazily: without --no-embed we don't load the model.
let embed = null;
if (!NO_EMBED) ({ embed } = await import('./embed.mjs'));

const files = findTranscripts(PROJECTS);
const getSession    = db.prepare('SELECT mtime, bytes FROM sessions WHERE path = ?');
const delChunks     = db.prepare('DELETE FROM chunks WHERE path = ?');
const insChunk      = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
const upsertSession = db.prepare(`
  INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at,title) VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    project=excluded.project, session=excluded.session, mtime=excluded.mtime,
    bytes=excluded.bytes, chunks=excluded.chunks, indexed_at=excluded.indexed_at, title=excluded.title`);

let processed = 0, skipped = 0, totalChunks = 0;

for (const file of files) {
  if (processed >= LIMIT) break;
  if (!KEPT.has(file)) { skipped++; continue; } // opt-in: only index what is marked in keep.list
  const st = statSync(file);
  const mtime = Math.floor(st.mtimeMs);
  const prev = getSession.get(file);
  if (!FORCE && prev && prev.mtime === mtime && prev.bytes === st.size) { skipped++; continue; }

  const project = projectFromPath(file);
  const { turns, title } = parseTranscript(file);
  // compaction summaries are progressive (each recaps everything so far); keep only the LAST,
  // the most complete one, so several near-duplicate summaries don't flood retrieval.
  const lastSummaryIdx = turns.map(t => t.role).lastIndexOf('summary');
  const records = [];
  for (const [idx, turn] of turns.entries()) {
    if (turn.role === 'summary' && idx !== lastSummaryIdx) continue; // drop superseded summaries
    const clean = redact(turn.text);
    if (turn.role === 'summary') {
      // keep the summary WHOLE (a coherent recap) instead of shredding it into 1800-char chunks;
      // embed a representative head slice (the model window truncates long text anyway).
      records.push({ session: turn.session, ts: turn.ts, role: 'summary', text: clean, embedText: clean.slice(0, 2000) });
      continue;
    }
    for (const piece of chunkText(clean)) {
      // drop tiny chunks (narration like "Let me check X" before a tool call)
      if (piece.trim().length < 80) continue;
      records.push({ session: turn.session, ts: turn.ts, role: turn.role, text: piece });
    }
  }

  let embeddings = [];
  if (embed && records.length) embeddings = await embed(records.map(r => r.embedText ?? r.text));

  db.exec('BEGIN');
  delChunks.run(file);
  records.forEach((r, i) => {
    const blob = embeddings[i] ? vecToBlob(embeddings[i]) : null;
    insChunk.run(file, project, r.session ?? null, r.ts ?? null, r.role, r.text, blob);
  });
  upsertSession.run(file, project, records[0]?.session ?? null, mtime, st.size, records.length, new Date().toISOString(), title ?? null);
  db.exec('COMMIT');

  processed++;
  totalChunks += records.length;
  if (processed % 10 === 0 || records.length > 200) {
    console.log(`  [${processed}] ${project} — ${records.length} chunks`);
  }
}

console.log(`\n✔ ingest: ${processed} processed, ${skipped} unchanged (skip), ${totalChunks} new chunks${NO_EMBED ? ' (no embeddings)' : ''}`);
console.log(stats(db));
