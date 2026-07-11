// Mark the CURRENT session to be SAVED to the brain (opt-in): appends its transcript
// to keep.list so ingest.mjs will index it. Saves the full session.
//
// Used by the /brain slash command (Claude Code) and the /brain custom prompt (Codex).
// The current session = the most recently modified transcript across BOTH hosts' stores,
// preferring the ones that belong to this cwd (see findCurrentTranscript).
//
// Usage:
//   node mark-current-keep.mjs         # mark to save
//   node mark-current-keep.mjs --dry   # show what it would mark, without writing
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { findCurrentTranscript } from './transcripts.mjs';

const DRY = process.argv.includes('--dry');

const newest = findCurrentTranscript(process.cwd());
if (!newest) { console.log('[brain] no transcripts found.'); process.exit(0); }

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
  mkdirSync(dirname(KEEP), { recursive: true });
  appendFileSync(KEEP, newest + '\n');
  console.log(`[brain] ✔ session marked to be SAVED — it will be indexed in the brain.`);
}
