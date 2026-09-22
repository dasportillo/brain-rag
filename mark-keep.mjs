// SessionStart hook: decide whether to record this session's transcript in keep.list so ingest.mjs
// (and the distill hook) process it. Precedence, most specific first:
//   1. BRAIN=1 / BRAIN=0 in the environment   → per-session override (keep / skip)
//   2. cwd inside a never.list repo            → skip (standing per-repo opt-OUT)
//   3. cwd inside an always.list repo          → keep (standing per-repo opt-in)
//   4. capture-by-default (brain-rag default)  → keep everything / keep nothing
// Historic default (capture-by-default off, empty lists): opt-in — a session is kept only with
// BRAIN=1 or an always.list repo.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAlwaysKept, readAlwaysList } from './always.mjs';
import { isNeverKept, readNeverList } from './never.mjs';
import { captureByDefault } from './config.mjs';
import { refreshQuietly } from './prompts.mjs';

// PURE policy: { keep, reason } from the four inputs. No I/O — tests import this directly (the
// script's side effects run only when mark-keep.mjs is executed directly, see the guard below).
export function decideKeep({ cwd, env, always = [], never = [], defaultOn = false }) {
  const envSet = env !== undefined && env !== null && env !== '';
  if (envSet && env !== '0' && env !== 'false') return { keep: true, reason: 'BRAIN' };
  if (envSet) return { keep: false, reason: 'BRAIN=0' };
  if (isNeverKept(cwd, never)) return { keep: false, reason: 'never.list' };
  if (isAlwaysKept(cwd, always)) return { keep: true, reason: 'always.list' };
  if (defaultOn) return { keep: true, reason: 'default' };
  return { keep: false, reason: 'opt-in' };
}

export function main() {
  // Upgrade repair, first and unconditional (it is not about THIS session being kept): the
  // /distill slash command and the Codex prompt are FILES written once by install, so a package
  // upgrade never reaches them and /distill keeps extracting with the old rules. This is one of
  // the two places that run on every session through `npx -y brain-rag`, so it is where they get
  // brought up to date. It only writes when a file is provably out of date, and it can neither
  // throw nor change this hook's exit code — a prompt file is never worth failing a session start.
  refreshQuietly();

  // The hook payload's cwd decides the never/always/default triggers even without BRAIN.
  let data = {};
  try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }

  const { keep, reason } = decideKeep({
    cwd: data.cwd,
    env: process.env.BRAIN,
    always: readAlwaysList(),
    never: readNeverList(),
    defaultOn: captureByDefault(),
  });
  if (!keep) process.exit(0); // not captured

  const tp = data.transcript_path;
  if (!tp) process.exit(0);

  const KEEP = join(homedir(), '.claude', 'brain', 'keep.list');
  const existing = existsSync(KEEP)
    ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim())
    : [];

  if (!existing.includes(tp)) {
    appendFileSync(KEEP, tp + '\n');
    console.error(`[brain] session kept (${reason}), it will be indexed: ${tp}`);
  }
  process.exit(0);
}

// Run only when invoked directly (the SessionStart hook runs `node mark-keep.mjs`). cli.mjs and
// tests import main()/decideKeep without triggering the side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
