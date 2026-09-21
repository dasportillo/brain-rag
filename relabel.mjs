// One-shot: re-derive every indexed session's project name from its transcript's real cwd (git repo)
// and rewrite the stored label — WITHOUT re-embedding. Run it once after upgrading the naming scheme
// (folder-path → git-repo) so already-indexed data lines up with newly-ingested data. Idempotent.
//   node relabel.mjs         # apply
//   node relabel.mjs --dry   # show what would change, touch nothing
// Layer 2 follows: memories distilled from a relabeled session move with it (matched by
// source_session = session id or transcript basename, the two keys distill/MCP write), so
// get_context(<repo>) and consolidate --project <repo> see them. Entity mentions are left as-is
// (joins drop the project mismatch naturally; only bare counts drift).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb } from './store.mjs';
import { parseSession, projectFromPath, gitRootName } from './transcripts.mjs';

const DRY = process.argv.includes('--dry');
const db = openDb();

const sessions = db.prepare('SELECT path, project, session FROM sessions').all();
const updSession  = db.prepare('UPDATE sessions SET project = ? WHERE path = ?');
const updChunks   = db.prepare('UPDATE chunks   SET project = ? WHERE path = ?');
const updMemories = db.prepare('UPDATE memories SET project = ?, updated_at = ? WHERE source_session IN (?, ?) AND project = ?');
const cntMemories = db.prepare('SELECT COUNT(*) n FROM memories WHERE source_session IN (?, ?) AND project = ?');

let changed = 0, missing = 0, movedMemories = 0;
const moves = new Map(); // "old → new" -> session count

for (const { path, project, session } of sessions) {
  if (!existsSync(path)) { missing++; continue; } // transcript gone; leave as-is (ingest prunes it)
  const { cwd } = parseSession(path);
  const next = (cwd && gitRootName(cwd)) || projectFromPath(path);
  if (!next || next === project) continue;
  const key = `${project}  →  ${next}`;
  moves.set(key, (moves.get(key) || 0) + 1);
  changed++;
  const refs = [session ?? basename(path, '.jsonl'), basename(path, '.jsonl')];
  movedMemories += cntMemories.get(...refs, project).n;
  if (!DRY) {
    db.exec('BEGIN');
    updSession.run(next, path); updChunks.run(next, path);
    updMemories.run(next, new Date().toISOString(), ...refs, project);
    db.exec('COMMIT');
  }
}

for (const [move, n] of [...moves].sort((a, b) => b[1] - a[1]))
  console.log(`  ${move}   (${n} session${n > 1 ? 's' : ''})`);
console.log(`\n${DRY ? '[dry] would relabel' : '✔ relabeled'} ${changed} session${changed === 1 ? '' : 's'}${movedMemories ? ` and ${movedMemories} distilled memor${movedMemories === 1 ? 'y' : 'ies'}` : ''}${missing ? `, ${missing} transcript(s) missing (left as-is)` : ''}.`);
