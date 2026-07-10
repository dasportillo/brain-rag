// SessionStart hook (OPT-IN): if the session started with BRAIN=1, record its transcript
// in keep.list so ingest.mjs DOES index it.
// By default (no BRAIN) it does nothing: the session stays out of the brain.
//
// Usage:  BRAIN=1 claude   (or `claude --brain` via the .zshrc wrapper)
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const flag = process.env.BRAIN;
if (!flag || flag === '0' || flag === 'false') process.exit(0); // default: do NOT save

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }

const tp = data.transcript_path;
if (!tp) process.exit(0);

const KEEP = join(homedir(), '.claude', 'brain', 'keep.list');
const existing = existsSync(KEEP)
  ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim())
  : [];

if (!existing.includes(tp)) {
  appendFileSync(KEEP, tp + '\n');
  console.error(`[brain] OPT-IN session enabled, it will be indexed: ${tp}`);
}
process.exit(0);
