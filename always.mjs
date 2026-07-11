// Standing PER-PROJECT opt-in (always.list): every session started inside a listed repo is kept,
// without BRAIN=1 — the per-repo complement to the per-session flag. One ABSOLUTE repo-root path
// per line in BRAIN_DIR/always.list; mark-keep.mjs consults it on SessionStart.
//
//   brain-rag always add [path]      # default: the cwd's git root
//   brain-rag always remove [path]
//   brain-rag always list
//
// NO top-level side effects: cli.mjs calls main(); mark-keep.mjs and tests import the helpers.
// Deliberately store-free (no node:sqlite): this sits on the SessionStart hook path, keep it light.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { gitRoot } from './transcripts.mjs';

const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
export const ALWAYS_FILE = join(BRAIN_DIR, 'always.list');

export function readAlwaysList(file = ALWAYS_FILE) {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : [];
}

// PURE matcher: is `cwd` at or under one of the always-kept roots? Boundary-aware — the root
// itself, or anything under `root + '/'`. A plain prefix test would wrongly capture siblings
// that share a prefix (/a/repo must NOT match /a/repo-2), which is exactly the silent-keep
// bug we can't afford in an opt-in system.
export function isAlwaysKept(cwd, roots) {
  if (!cwd) return false;
  const clean = String(cwd).replace(/\/+$/, '');
  for (const r of roots || []) {
    const root = String(r).trim().replace(/\/+$/, '');
    if (root && (clean === root || clean.startsWith(root + '/'))) return true;
  }
  return false;
}

export async function main() {
  const [action, pathArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const roots = readAlwaysList();

  if (!action || action === 'list') {
    if (!roots.length) console.log('always.list is empty — run `brain-rag always add` inside a repo to keep all its sessions.');
    for (const r of roots) console.log(`${r}${existsSync(r) ? '' : '  (missing)'}`);
    return;
  }
  if (action !== 'add' && action !== 'remove') {
    console.error('usage: brain-rag always add [path] | remove [path] | list');
    process.exit(1);
  }
  // Normalize to the repo ROOT (same walk that names projects at ingest): a subdir argument or
  // cwd collapses to ONE canonical entry per repo. Outside a repo, the absolute path itself.
  const abs = resolve(pathArg || process.cwd());
  const root = gitRoot(abs) ?? abs;

  if (action === 'add') {
    if (roots.includes(root)) { console.log(`already in always.list: ${root}`); return; }
    mkdirSync(dirname(ALWAYS_FILE), { recursive: true });
    writeFileSync(ALWAYS_FILE, [...roots, root].join('\n') + '\n');
    console.log(`✔ always keep: ${root}\n  Every session started in this repo will be indexed (no BRAIN=1 needed). Undo: brain-rag always remove`);
  } else {
    const remaining = roots.filter(r => r !== root);
    if (remaining.length === roots.length) { console.log(`not in always.list: ${root}`); return; }
    writeFileSync(ALWAYS_FILE, remaining.length ? remaining.join('\n') + '\n' : '');
    console.log(`✔ removed from always.list: ${root}`);
  }
}
