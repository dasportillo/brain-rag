// Mark the CURRENT session to be SAVED to the brain (opt-in): appends its transcript
// to keep.list so ingest.mjs will index it. Saves the full session.
//
// Used by the /brain slash command. It identifies the current session as the most
// recently modified .jsonl (the one being written right now); it prefers the project
// directory derived from the cwd and, if that does not exist, searches all of them.
//
// Usage:
//   node mark-current-keep.mjs         # mark to save
//   node mark-current-keep.mjs --dry   # show what it would mark, without writing
import { readdirSync, statSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRY = process.argv.includes('--dry');
const PROJECTS = join(homedir(), '.claude', 'projects');

function allTranscripts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allTranscripts(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const dashified = process.cwd().replace(/[/_]/g, '-');
const projDir = join(PROJECTS, dashified);
const pool = existsSync(projDir) ? allTranscripts(projDir) : (existsSync(PROJECTS) ? allTranscripts(PROJECTS) : []);

if (!pool.length) { console.log('[brain] no transcripts found.'); process.exit(0); }

let newest = pool[0], newestM = -1;
for (const f of pool) {
  const m = statSync(f).mtimeMs;
  if (m > newestM) { newestM = m; newest = f; }
}

const KEEP = join(homedir(), '.claude', 'brain', 'keep.list');
const existing = existsSync(KEEP)
  ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim())
  : [];

if (DRY) {
  console.log(`[brain] (dry) would mark to SAVE: ${newest}`);
  process.exit(0);
}
if (existing.includes(newest)) {
  console.log(`[brain] this session was ALREADY marked to be saved.`);
} else {
  appendFileSync(KEEP, newest + '\n');
  console.log(`[brain] ✔ session marked to be SAVED — it will be indexed in the brain.`);
}
