// Wire the published package into Claude Code (and Codex, when present) — npx-native: no code is
// copied anywhere, the MCP server and hooks run straight from the npm package. Only DATA (the
// index + state notes) lives under BRAIN_DIR (~/.claude/brain).
// Run with: npx -y <pkg> install  (or `brain-rag install`).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const NAME = pkg.name;                 // e.g. brain-rag
const NPX = `npx -y ${NAME}`;
const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const CMD_DIR = join(homedir(), '.claude', 'commands');
const CODEX_HOME = join(homedir(), '.codex');

console.log(`▸ ${NAME} install (npx-native)\n  data dir: ${BRAIN_DIR}`);
mkdirSync(BRAIN_DIR, { recursive: true });

// 1. Register the MCP server globally (idempotent).
try {
  const list = execSync('claude mcp list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (/^brain\b/m.test(list)) {
    console.log("▸ MCP 'brain' already registered — skipping");
  } else {
    execSync(`claude mcp add brain --scope user -- ${NPX} serve`, { stdio: 'inherit' });
    console.log("▸ registered MCP 'brain'");
  }
} catch {
  console.log(`▸ 'claude' CLI not found — register manually:\n    claude mcp add brain --scope user -- ${NPX} serve`);
}

// 1b. Codex — same brain, second host (only when ~/.codex exists). Codex sessions are also
// ingested into the index; registering the server + prompts gives Codex the same tools.
if (existsSync(CODEX_HOME)) {
  try {
    const list = execSync('codex mcp list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (/\bbrain\b/.test(list)) {
      console.log("▸ Codex MCP 'brain' already registered — skipping");
    } else {
      execSync(`codex mcp add brain -- ${NPX} serve`, { stdio: 'inherit' });
      console.log("▸ registered MCP 'brain' in Codex");
    }
  } catch {
    console.log(`▸ 'codex' CLI not found — register manually in ~/.codex/config.toml:\n    [mcp_servers.brain]\n    command = "npx"\n    args = ["-y", "${NAME}", "serve"]`);
  }

  // Custom prompts = Codex's slash commands. MCP-tool-first (the server runs unsandboxed,
  // so no shell escalation prompts inside the Codex sandbox).
  const PROMPTS = join(CODEX_HOME, 'prompts');
  mkdirSync(PROMPTS, { recursive: true });
  writeFileSync(join(PROMPTS, 'brain.md'), `Call the \`keep_session\` tool from the \`brain\` MCP server and report its one-line result verbatim. Do nothing else.
(The brain is OFF by default; this opts THIS session in so it does get indexed, in full.)
`);
  writeFileSync(join(PROMPTS, 'state.md'), `Build and persist the curated CURRENT-STATE note for the project \`$ARGUMENTS\` (if empty, infer it from the current working directory), using the \`brain\` MCP server.

1. Call \`get_state\` for that project — it returns the curated note, or recent activity when none exists. If it finds nothing, call \`list_projects\` and retry with the exact name.
2. Synthesize a concise note: **Now**, **In flight**, **Decisions**, **Blockers**, **Next**. Omit anything reverted or superseded.
3. Call \`save_state\` with that Markdown (same project if one was given).
4. Report the saved path on a single line.
`);
  console.log(`▸ installed Codex /brain and /state prompts → ${PROMPTS}`);

  console.log(`
▸ Codex tip — Codex doesn't surface MCP instructions as prominently as Claude Code; add a short
  section to ~/.codex/AGENTS.md so the model uses the brain proactively, e.g.:

    ## Second brain (MCP 'brain')
    Persistent memory of all my work across Claude Code and Codex.
    - "where did I leave off?", "state of X" -> get_state(project); search_context(query) for past decisions.
    - Call search_context BEFORE assuming there is no prior context on a project/decision.
    - When a session produced something worth remembering, call keep_session (opt-in; un-kept chats are lost).

  Codex has no session-end hook: sessions marked with /brain are indexed by the next ingest run
  (the Claude Code SessionEnd hook, or run '${NPX} ingest' manually / on a schedule).`);
}

// 2. Slash commands — generated so they always point at THIS package (rename-safe).
mkdirSync(CMD_DIR, { recursive: true });
writeFileSync(join(CMD_DIR, 'brain.md'), `---
description: Save THIS conversation to the "second brain" (off by default — nothing is saved)
allowed-tools: Bash(npx:*)
---
Run exactly this command with the Bash tool and report its output on a single line:

\`${NPX} mark-current\`

Do nothing else. (The brain is OFF by default; this opts THIS session in so it does get indexed, in full.)
`);
writeFileSync(join(CMD_DIR, 'state.md'), `---
description: Synthesize and save the curated current-state note for a project (state/<project>.md)
allowed-tools: Bash(npx:*), mcp__brain__save_state
---
Build and persist the curated CURRENT-STATE note for the project \`$ARGUMENTS\` (if empty, infer it from the current working directory).

1. Run \`${NPX} state $ARGUMENTS\` to gather the project's recent activity. (No argument: run \`${NPX} state --list\` first and pick the project matching the cwd.)
2. Synthesize a concise note: **Now**, **In flight**, **Decisions**, **Blockers**, **Next**. Omit anything reverted or superseded.
3. Call the \`save_state\` tool with that Markdown (same project if one was given).
4. Report the saved path on a single line.
`);
console.log(`▸ installed /brain and /state → ${CMD_DIR}`);

// 3. Hook wiring (printed — we don't edit settings.json for you). The brain is OPT-IN.
console.log(`
▸ OPT-IN wiring — add these to ~/.claude/settings.json (keep any existing entries).
  Nothing is indexed unless you opt a session in.

  "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command",
    "command": "${NPX} mark-keep", "timeout": 20 }] }]

  "SessionEnd":   [{ "matcher": "", "hooks": [{ "type": "command",
    "command": "nohup ${NPX} ingest >> \\"${BRAIN_DIR}/ingest.log\\" 2>&1 &", "timeout": 30 }] }]

  Optional shell wrapper — start an opted-in session with 'claude --brain':
    claude() { local b=0 a=(); for x in "$@"; do [ "$x" = --brain ] && b=1 || a+=("$x"); done;
      if (( b )); then BRAIN=1 command claude "\${a[@]}"; else command claude "\${a[@]}"; fi; }

  Mid-session: /brain opts the current conversation in · /state writes the current-state note.

  Tip: for zero npx overhead on every hook, 'npm i -g ${NAME}' and replace '${NPX}' with 'brain-rag'.
`);
console.log('✔ done. Opt a session in (claude --brain or /brain), then ask Claude to search your brain.');
