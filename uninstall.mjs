// Reverse of install.mjs — unregister the MCP server and remove the slash commands. Prints which
// hooks to remove from settings.json / .zshrc (we don't edit those, to avoid clobbering unrelated
// entries). Your DATA (index + state notes under BRAIN_DIR) is KEPT unless you pass --purge.
//   brain-rag uninstall            # remove MCP + commands, keep data
//   brain-rag uninstall --purge    # also delete the index + state notes
import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { opencodeConfigDir, opencodeConfigFile, removeBrainMcp, editOpencodeConfig, editAgentsFile, removeAgentsBlock } from './opencode.mjs';
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

// 1b. Codex: unregister + remove the custom prompts (idempotent).
try {
  execSync('codex mcp remove brain', { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log("▸ removed Codex MCP server 'brain'");
} catch {
  console.log("▸ Codex MCP 'brain' not registered (or 'codex' CLI unavailable) — nothing to remove");
}

// 1c. opencode: drop the 'brain' entry from its global config (comments preserved, backup kept).
const OPENCODE_DIR = opencodeConfigDir();
if (existsSync(OPENCODE_DIR)) {
  const file = opencodeConfigFile(OPENCODE_DIR);
  try {
    const r = editOpencodeConfig(file, removeBrainMcp);
    console.log(r.changed ? `▸ removed opencode MCP server 'brain' from ${file}` : "▸ opencode MCP 'brain' not registered — nothing to remove");
  } catch (e) {
    console.log(`▸ could not edit ${file} (${e.message}) — remove "mcp" → "brain" yourself`);
  }
}

// 1d. opencode AGENTS.md: drop only brain-rag's marked section (the rest of the file is yours).
if (existsSync(OPENCODE_DIR)) {
  const agents = join(OPENCODE_DIR, 'AGENTS.md');
  try {
    const r = editAgentsFile(agents, removeAgentsBlock);
    if (r.changed) console.log(`▸ removed the brain section from ${agents}${r.removed ? ' (file was otherwise empty — deleted)' : ''}`);
  } catch (e) {
    console.log(`▸ could not edit ${agents} (${e.message}) — remove the brain-rag:agents block yourself`);
  }
}

// 2. Remove the slash commands / custom prompts we installed. A `<file>.bak` left by a prompt
// refresh is NOT removed: that copy exists because the text was yours, not ours.
for (const p of [
  join(CMD_DIR, 'brain.md'), join(CMD_DIR, 'state.md'), join(CMD_DIR, 'distill.md'),
  join(homedir(), '.codex', 'prompts', 'brain.md'), join(homedir(), '.codex', 'prompts', 'state.md'),
  join(homedir(), '.codex', 'prompts', 'distill.md'),
  join(OPENCODE_DIR, 'commands', 'brain.md'), join(OPENCODE_DIR, 'commands', 'state.md'),
  join(OPENCODE_DIR, 'commands', 'distill.md'), join(OPENCODE_DIR, 'plugins', 'brain-rag.js'),
]) {
  if (existsSync(p)) { rmSync(p); console.log(`▸ removed ${p}`); }
  if (existsSync(p + '.bak')) console.log(`▸ kept your ${p}.bak (delete it yourself if you don't want it)`);
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
