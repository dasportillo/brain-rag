// Standing PER-PROJECT opt-OUT (never.list): sessions started inside a listed repo are NEVER kept,
// even when capture-by-default is on (brain-rag default on). The denylist complement of always.list.
// One ABSOLUTE repo-root path per line in BRAIN_DIR/never.list; mark-keep.mjs consults it on
// SessionStart, and it takes precedence over always.list and the global default.
//
//   brain-rag never add [path]       # default: the cwd's git root
//   brain-rag never remove [path]
//   brain-rag never list
//
// NO top-level side effects: cli.mjs calls main(); mark-keep.mjs and tests import the helpers.
// Store-free and light (SessionStart hook path). isNeverKept reuses always.mjs's boundary-aware
// matcher verbatim — same "a root, or anything under root + '/'" semantics, read as a denylist.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isAlwaysKept } from './always.mjs';
import { gitRoot } from './transcripts.mjs';

const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
export const NEVER_FILE = join(BRAIN_DIR, 'never.list');

export function readNeverList(file = NEVER_FILE) {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : [];
}

// Same boundary-aware matcher as always.mjs, read as "is cwd at or under a denied root?"
export const isNeverKept = (cwd, roots) => isAlwaysKept(cwd, roots);

export async function main() {
  const [action, pathArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const roots = readNeverList();

  if (!action || action === 'list') {
    if (!roots.length) console.log('never.list is empty — run `brain-rag never add` inside a repo to exclude it from capture.');
    for (const r of roots) console.log(`${r}${existsSync(r) ? '' : '  (missing)'}`);
    return;
  }
  if (action !== 'add' && action !== 'remove') {
    console.error('usage: brain-rag never add [path] | remove [path] | list');
    process.exit(1);
  }
  // Normalize to the repo ROOT (same walk as always.mjs): a subdir argument or cwd collapses to ONE
  // canonical entry per repo. Outside a repo, the absolute path itself.
  const abs = resolve(pathArg || process.cwd());
  const root = gitRoot(abs) ?? abs;

  if (action === 'add') {
    if (roots.includes(root)) { console.log(`already in never.list: ${root}`); return; }
    mkdirSync(dirname(NEVER_FILE), { recursive: true });
    writeFileSync(NEVER_FILE, [...roots, root].join('\n') + '\n');
    console.log(`✔ never keep: ${root}\n  Sessions in this repo are excluded from capture even with capture-by-default on. Undo: brain-rag never remove`);
  } else {
    const remaining = roots.filter(r => r !== root);
    if (remaining.length === roots.length) { console.log(`not in never.list: ${root}`); return; }
    writeFileSync(NEVER_FILE, remaining.length ? remaining.join('\n') + '\n' : '');
    console.log(`✔ removed from never.list: ${root}`);
  }
}
