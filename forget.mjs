// Remove sessions from the brain: delete their chunks + drop them from keep.list. The inverse of
// import/opt-in — the missing half of the privacy model.
//   brain-rag forget <filter>     # sessions whose transcript path matches <filter> (substring)
//   brain-rag forget --all        # every session
//   brain-rag forget <...> --dry  # preview; delete nothing
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './store.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const filter = args.find(a => !a.startsWith('--')) || null;

if (!filter && !ALL) {
  console.error('usage: brain-rag forget <filter> | --all   [--dry]');
  process.exit(1);
}

const db = openDb();
const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const KEEP = join(BRAIN_DIR, 'keep.list');

const match = (p) => ALL || p.includes(filter);
const paths = db.prepare('SELECT DISTINCT path FROM chunks').all().map(r => r.path).filter(match);
const countStmt = db.prepare('SELECT COUNT(*) c FROM chunks WHERE path = ?');
let chunks = 0; for (const p of paths) chunks += countStmt.get(p).c;

console.log(`forget${ALL ? ' (ALL)' : ` "${filter}"`}: ${paths.length} indexed session(s) · ${chunks} chunks`);
if (DRY) {
  for (const p of paths.slice(0, 25)) console.log('  ' + p);
  console.log('\n(dry run — nothing deleted)');
  process.exit(0);
}

db.exec('BEGIN');
const delC = db.prepare('DELETE FROM chunks WHERE path = ?');
const delS = db.prepare('DELETE FROM sessions WHERE path = ?');
for (const p of paths) { delC.run(p); delS.run(p); }
db.exec('COMMIT');

// also drop matching entries from keep.list (covers sessions marked but not yet indexed)
let unmarked = 0;
if (existsSync(KEEP)) {
  const kept = readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const remaining = kept.filter(p => !match(p));
  unmarked = kept.length - remaining.length;
  writeFileSync(KEEP, remaining.length ? remaining.join('\n') + '\n' : '');
}
console.log(`✔ forgot ${paths.length} session(s), ${chunks} chunks; un-marked ${unmarked} keep.list entr${unmarked === 1 ? 'y' : 'ies'}.`);
