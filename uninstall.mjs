// Reverse of install.mjs — unregister the MCP server and remove the slash commands. Prints which
// hooks to remove from settings.json / .zshrc (we don't edit those, to avoid clobbering unrelated
// entries). Your DATA (index + state notes under BRAIN_DIR) is KEPT unless you pass --purge.
//   brain-rag uninstall            # remove MCP + commands, keep data
//   brain-rag uninstall --purge    # also delete the index + state notes
import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PURGE = process.argv.includes('--purge');
const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const CMD_DIR = join(homedir(), '.claude', 'commands');

console.log('▸ brain-rag uninstall');

// 1. Unregister the MCP server (idempotent — fine if it was never registered).
try {
  execSync('claude mcp remove brain', { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log("▸ removed MCP server 'brain'");
} catch {
  console.log("▸ MCP 'brain' not registered (or 'claude' CLI unavailable) — nothing to remove");
}

// 2. Remove the slash commands we installed.
for (const f of ['brain.md', 'state.md']) {
  const p = join(CMD_DIR, f);
  if (existsSync(p)) { rmSync(p); console.log(`▸ removed ${p}`); }
}

// 3. Data dir — opt-in destructive.
if (PURGE) {
  if (existsSync(BRAIN_DIR)) { rmSync(BRAIN_DIR, { recursive: true, force: true }); console.log(`▸ purged data dir ${BRAIN_DIR}`); }
  else console.log(`▸ no data dir at ${BRAIN_DIR}`);
} else {
  console.log(`▸ kept your data at ${BRAIN_DIR} (index + state notes).\n  delete it with:  rm -rf "${BRAIN_DIR}"   (or re-run: brain-rag uninstall --purge)`);
}

// 4. Hooks + shell wrapper are manual (we never edit settings.json / .zshrc for you).
console.log(`
▸ MANUAL steps to finish:
  - ~/.claude/settings.json → remove the two brain hooks:
      SessionStart → the "… mark-keep" entry
      SessionEnd   → the "nohup … ingest …" entry
  - ~/.zshrc → remove the claude() { … --brain … } wrapper, if you added it.
`);
console.log('✔ uninstalled.');
