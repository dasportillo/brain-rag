// SessionStart hook (OPT-IN): record this session's transcript in keep.list so ingest.mjs DOES
// index it. TWO triggers, both explicit user choices:
//   - BRAIN=1 in the environment (per session:  BRAIN=1 claude  /  the `claude --brain` wrapper)
//   - the session's cwd is inside a repo listed in always.list (standing per-project opt-in,
//     managed with `brain-rag always add|remove|list`)
// By default (neither trigger) it does nothing: the session stays out of the brain.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAlwaysKept, readAlwaysList } from './always.mjs';

// The hook payload is needed even without BRAIN: its cwd decides the always.list trigger.
let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }

const flag = process.env.BRAIN;
const byEnv = flag && flag !== '0' && flag !== 'false';
const byAlways = !byEnv && isAlwaysKept(data.cwd, readAlwaysList());
if (!byEnv && !byAlways) process.exit(0); // default: do NOT save

const tp = data.transcript_path;
if (!tp) process.exit(0);

const KEEP = join(homedir(), '.claude', 'brain', 'keep.list');
const existing = existsSync(KEEP)
  ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim())
  : [];

if (!existing.includes(tp)) {
  appendFileSync(KEEP, tp + '\n');
  console.error(`[brain] OPT-IN session enabled${byAlways ? ' (always.list)' : ''}, it will be indexed: ${tp}`);
}
process.exit(0);
