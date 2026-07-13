// Global brain-rag settings (BRAIN_DIR/config.json) — user toggles that live OUTSIDE any single
// repo. Store-free and light: captureByDefault is read on the SessionStart hook path.
//
//   brain-rag default on|off|status   # capture-by-default: keep EVERY session unless excluded
//
// captureByDefault flips the keep policy from opt-in (default: sessions ignored) to opt-out
// (default: sessions kept, minus never.list). See mark-keep.mjs for the full precedence.
//
// NO top-level side effects: cli.mjs calls main(); mark-keep.mjs and tests import the helpers.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
export const CONFIG_FILE = join(BRAIN_DIR, 'config.json');

export function readConfig(file = CONFIG_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

// Default OFF: an absent/blank config preserves the historic opt-in behavior. `default on` flips it.
export function captureByDefault(cfg = readConfig()) {
  return cfg.captureByDefault === true;
}

function writeConfig(cfg, file = CONFIG_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

export async function main() {
  const [action] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const cfg = readConfig();

  if (!action || action === 'status') {
    const on = captureByDefault(cfg);
    console.log(`capture-by-default: ${on ? 'on' : 'off'}`);
    console.log(on
      ? '  every session is kept unless its repo is in never.list (brain-rag never add <path>)'
      : '  sessions are kept only with BRAIN=1 or a repo in always.list (opt-in)');
    return;
  }
  if (action !== 'on' && action !== 'off') {
    console.error('usage: brain-rag default on | off | status');
    process.exit(1);
  }
  writeConfig({ ...cfg, captureByDefault: action === 'on' });
  console.log(action === 'on'
    ? '✔ capture-by-default ON — every session is kept, except repos in never.list (brain-rag never add <path>)'
    : '✔ capture-by-default OFF — back to opt-in (BRAIN=1 or always.list)');
}
