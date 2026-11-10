// INCREMENTAL ingestion of OPTED-IN transcripts into the store (opt-in via keep.list).
//
// How it updates (the key part):
//   - Each session = one transcript path (a .jsonl file, or an opencode virtual path
//     <opencode.db>#<session id>). We store its (mtime, bytes) in the `sessions` table.
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
//   node ingest.mjs --prune       # ALSO drop indexed sessions whose transcript is gone (see below)
//
// The index is the ARCHIVE: once a session is indexed, its text lives in brain.db and no longer
// depends on the agent keeping the transcript. Claude Code deletes transcripts older than
// cleanupPeriodDays (30 by default), so pruning "gone" sessions on every run quietly erased the
// archive — 353 sessions in one run on 2026-11-06 (issue #47). They are now only COUNTED
// ("archived"); removing indexed sessions is always explicit: `brain-rag forget` or --prune.
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, vecToBlob, stats, diffChunks, linkEntities } from './store.mjs';
import { parseSession, projectFromPath, gitRootName, chunkText, redact, listSessions, sessionStat, sessionExists, resolveKept } from './transcripts.mjs';

// OPT-IN: by default NOTHING is indexed. Only sessions whose transcript is listed in
// keep.list get indexed. Entries are added by `BRAIN=1 claude` (the mark-keep.mjs
// SessionStart hook) or by the /brain slash command mid-session (mark-current-keep.mjs).
const KEEP_FILE = join(homedir(), '.claude', 'brain', 'keep.list');
const readKeep = () => (existsSync(KEEP_FILE) ? readFileSync(KEEP_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
const LIMIT = Number(val('--limit', Infinity));
const NO_EMBED = has('--no-embed');
const FORCE = has('--force'); // re-process even if unchanged (e.g. to backfill embeddings)
const PRUNE = has('--prune'); // explicit: drop indexed sessions whose transcript is gone

const db = openDb();

if (has('--stats')) {
  console.log(stats(db));
  process.exit(0);
}

// The embedder is imported lazily: without --no-embed we don't load the model.
let embed = null;
if (!NO_EMBED) ({ embed } = await import('./embed.mjs'));

// Every registered adapter's session store; any may be absent (it contributes nothing then).
const files = listSessions();
// Kept sessions are matched by path, then by session id (issue #62): a transcript that changed
// folder is still indexed, and keep.list is rewritten to point at where it lives now.
const { kept: KEPT, moved, missing } = resolveKept(readKeep(), files);
const isIndexed = db.prepare('SELECT 1 FROM sessions WHERE path = ?');
if (moved.size) {
  // Re-read right before writing so an entry a hook appended meanwhile is not lost; atomic swap.
  const fresh = [...new Set(readKeep().map(e => moved.get(e) ?? e))];
  const tmp = `${KEEP_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, fresh.join('\n') + '\n');
  renameSync(tmp, KEEP_FILE);
  // A session indexed under its old path keeps its chunks (and embeddings): move them to the new
  // path so the append-only diff below re-embeds nothing, instead of indexing it a second time.
  const movSession = db.prepare('UPDATE sessions SET path = ? WHERE path = ?');
  const movChunks = db.prepare('UPDATE chunks SET path = ? WHERE path = ?');
  for (const [from, to] of moved) {
    if (!isIndexed.get(from) || isIndexed.get(to)) continue;
    db.exec('BEGIN'); movSession.run(to, from); movChunks.run(to, from); db.exec('COMMIT');
  }
  console.log(`  ↪ relinked ${moved.size} kept session(s) whose transcript changed folder (keep.list updated)`);
}
// Marked but never indexed, and no transcript anywhere: lost unless recovered by hand. Counted so
// it shows in the log (sessions already indexed whose transcript was deleted are "archived").
const keptLost = missing.filter(p => !isIndexed.get(p)).length;
const getSession    = db.prepare('SELECT mtime, bytes FROM sessions WHERE path = ?');
const delChunks     = db.prepare('DELETE FROM chunks WHERE path = ?');
const delChunkById  = db.prepare('DELETE FROM chunks WHERE id = ?');
const insChunk      = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
const upsertSession = db.prepare(`
  INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at,title) VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    project=excluded.project, session=excluded.session, mtime=excluded.mtime,
    bytes=excluded.bytes, chunks=excluded.chunks, indexed_at=excluded.indexed_at, title=excluded.title`);

let processed = 0, skipped = 0, notKept = 0, failed = 0, totalChunks = 0;

for (const file of files) {
  if (processed >= LIMIT) break;
  if (!KEPT.has(file)) { notKept++; continue; } // opt-in: only index what is marked in keep.list
  // One transcript failing (unreadable, malformed, too big) must never stop the others: before
  // issue #45 a single 594 MB transcript aborted every run, so nothing was indexed for weeks.
  try {
    const st = sessionStat(file);
    const mtime = Math.floor(st.mtimeMs);
    const prev = getSession.get(file);
    if (!FORCE && prev && prev.mtime === mtime && prev.bytes === st.size) { skipped++; continue; }

    const { turns, title, cwd } = parseSession(file);
    // Project = the git repo the session ran in (stable across subdirs / OS / folder layout).
    // Fall back to the dashified path only when the transcript has no cwd (older transcripts).
    const project = (cwd && gitRootName(cwd)) || projectFromPath(file);
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

    // Append-only: embed only new/changed chunks (matched by text), keep unchanged ones (they already
    // have embeddings), delete stale ones. --force re-embeds the whole file (e.g. after a model swap).
    const existingRows = FORCE ? [] : db.prepare('SELECT id, text FROM chunks WHERE path = ?').all(file);
    const { toEmbed, staleIds } = diffChunks(existingRows, records);

    let embeddings = [];
    if (embed && toEmbed.length) embeddings = await embed(toEmbed.map(r => r.embedText ?? r.text));

    db.exec('BEGIN');
    if (FORCE) delChunks.run(file);
    else for (const id of staleIds) delChunkById.run(id);
    toEmbed.forEach((r, i) => {
      const blob = embeddings[i] ? vecToBlob(embeddings[i]) : null;
      const info = insChunk.run(file, project, r.session ?? null, r.ts ?? null, r.role, r.text, blob);
      // entity graph: link only NEW chunks (regex-cheap vs the embedding we just paid for).
      // Stale chunks deleted above may orphan old mentions — accepted, see store.mjs migration v3.
      linkEntities(db, { chunkId: Number(info.lastInsertRowid), project, ts: r.ts ?? null, text: r.text });
    });
    upsertSession.run(file, project, records[0]?.session ?? null, mtime, st.size, records.length, new Date().toISOString(), title ?? null);
    db.exec('COMMIT');

    processed++;
    totalChunks += toEmbed.length;
    if (processed % 10 === 0 || records.length > 200) {
      console.log(`  [${processed}] ${project} — ${records.length} chunks`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    failed++;
    console.error(`  ✗ skipped ${file}: ${e.code ?? ''} ${e.message}`.replace(/\s+/g, ' '));
  }
}

// Sessions whose transcript is gone from its store: kept in the index (the archive) and counted —
// or, only with an explicit --prune, removed. Skipped on partial --limit runs either way.
let pruned = 0, archived = 0;
if (LIMIT === Infinity) {
  const delSession = db.prepare('DELETE FROM sessions WHERE path = ?');
  for (const { path } of db.prepare('SELECT path FROM sessions').all()) {
    if (sessionExists(path)) continue;
    if (!PRUNE) { archived++; continue; }
    db.exec('BEGIN'); delChunks.run(path); delSession.run(path); db.exec('COMMIT');
    pruned++;
  }
}

console.log(`\n✔ ingest: ${processed} processed, ${skipped} unchanged, ${notKept} not kept, ${totalChunks} new chunks${moved.size ? `, ${moved.size} relinked (transcript moved)` : ''}${keptLost ? `, ${keptLost} kept without transcript (never indexed)` : ''}${pruned ? `, ${pruned} pruned (--prune)` : ''}${archived ? `, ${archived} archived (transcript gone, still searchable)` : ''}${failed ? `, ${failed} FAILED (see ✗ lines above)` : ''}${NO_EMBED ? ' (no embeddings)' : ''}`);
console.log(stats(db));
