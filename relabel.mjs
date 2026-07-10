// One-shot: re-derive every indexed session's project name from its transcript's real cwd (git repo)
// and rewrite the stored label — WITHOUT re-embedding. Run it once after upgrading the naming scheme
// (folder-path → git-repo) so already-indexed data lines up with newly-ingested data. Idempotent.
//   node relabel.mjs         # apply
//   node relabel.mjs --dry   # show what would change, touch nothing
import { existsSync } from 'node:fs';
import { openDb } from './store.mjs';
import { parseTranscript, projectFromPath, gitRootName } from './transcripts.mjs';

const DRY = process.argv.includes('--dry');
const db = openDb();

const sessions = db.prepare('SELECT path, project FROM sessions').all();
const updSession = db.prepare('UPDATE sessions SET project = ? WHERE path = ?');
const updChunks  = db.prepare('UPDATE chunks   SET project = ? WHERE path = ?');

let changed = 0, missing = 0;
const moves = new Map(); // "old → new" -> session count

for (const { path, project } of sessions) {
  if (!existsSync(path)) { missing++; continue; } // transcript gone; leave as-is (ingest prunes it)
  const { cwd } = parseTranscript(path);
  const next = (cwd && gitRootName(cwd)) || projectFromPath(path);
  if (!next || next === project) continue;
  const key = `${project}  →  ${next}`;
  moves.set(key, (moves.get(key) || 0) + 1);
  changed++;
  if (!DRY) { db.exec('BEGIN'); updSession.run(next, path); updChunks.run(next, path); db.exec('COMMIT'); }
}

for (const [move, n] of [...moves].sort((a, b) => b[1] - a[1]))
  console.log(`  ${move}   (${n} session${n > 1 ? 's' : ''})`);
console.log(`\n${DRY ? '[dry] would relabel' : '✔ relabeled'} ${changed} session${changed === 1 ? '' : 's'}${missing ? `, ${missing} transcript(s) missing (left as-is)` : ''}.`);
