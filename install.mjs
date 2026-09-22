// Wire the published package into Claude Code (and Codex, when present) — npx-native: no code is
// copied anywhere, the MCP server and hooks run straight from the npm package. Only DATA (the
// index + state notes) lives under BRAIN_DIR (~/.claude/brain).
// Run with: npx -y <pkg> install  (or `brain-rag install`).
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// The prompt FILES live in prompts.mjs (single source of truth — install writes them, and the
// same module refreshes them from `serve` / the SessionStart hook when a later version changes
// them, so /distill can never keep running last year's rules).
import { syncPrompts } from './prompts.mjs';

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

  // Custom prompts = Codex's slash commands, written below by syncPrompts (MCP-tool-first: the
  // server runs unsandboxed, so no shell escalation prompts inside the Codex sandbox).
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

// 2. Slash commands + Codex prompts — generated from prompts.mjs so they always point at THIS
// package (rename-safe) and always carry the CURRENT extraction rules. Each file is stamped with
// a hash of what we wrote, which is what lets `serve` and the SessionStart hook refresh it later
// without ever clobbering a file you made your own (that one is backed up and reported).
const synced = syncPrompts({ mode: 'install' });
for (const p of synced.backedUp) console.log(`▸ your previous version was kept at ${p}`);
console.log(`▸ installed /brain, /state and /distill → ${CMD_DIR}`);
if (existsSync(CODEX_HOME)) console.log(`▸ installed Codex /brain, /state and /distill prompts → ${join(CODEX_HOME, 'prompts')}`);
console.log(`▸ these files are refreshed automatically on upgrade — by the MCP server and by the
  SessionStart hook, both of which run through '${NPX}'. If you use NEITHER (no 'brain' MCP server
  registered and no mark-keep hook), re-run '${NPX} install' after upgrading or /distill will keep
  extracting with the rules of the version that wrote it.`);

// 3. Hook wiring (printed — we don't edit settings.json for you). The brain is OPT-IN.
console.log(`
▸ OPT-IN wiring — add these to ~/.claude/settings.json (keep any existing entries).
  Nothing is indexed unless you opt a session in.

  "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command",
    "command": "${NPX} mark-keep", "timeout": 20 }] }]

  "SessionEnd":   [{ "matcher": "", "hooks": [{ "type": "command",
    "command": "nohup ${NPX} ingest >> \\"${BRAIN_DIR}/ingest.log\\" 2>&1 &", "timeout": 30 }] }]

  OPTIONAL session-start context — injects your project's brain context at session start
  (only for repos with brain data; prints nothing elsewhere, so unknown repos stay silent).
  Model-free and instant. Append to the SessionStart hooks array above:

    { "type": "command", "command": "${NPX} context --hook", "timeout": 10 }

  OPTIONAL auto-extraction — distill each opted-in session into durable memories (Layer 2)
  when it ends, and (if 'cloud login' ran) push them to the team store in the same step. It runs
  a headless 'claude -p' PER kept session, so it COSTS TOKENS; the in-session /distill command
  works without it. Append to the SessionEnd hooks array above:

    { "type": "command",
      "command": "nohup ${NPX} distill --hook >> \\"${BRAIN_DIR}/distill.log\\" 2>&1 &", "timeout": 30 }

  Optional shell wrapper — start an opted-in session with 'claude --brain':
    claude() { local b=0 a=(); for x in "$@"; do [ "$x" = --brain ] && b=1 || a+=("$x"); done;
      if (( b )); then BRAIN=1 command claude "\${a[@]}"; else command claude "\${a[@]}"; fi; }

  Joining a team that uses Brain-RAG Teams? '${NPX} onboard' picks which of your existing projects
  to bring over, imports + distills their history and syncs the memories to the team in one run.

  Standing opt-in: '${NPX} always add' inside a repo keeps EVERY session started there (no BRAIN=1).
  Mid-session: /brain opts the current conversation in · /state writes the current-state note.

  Opt-OUT mode (capture-all): '${NPX} default on' keeps EVERY session everywhere; exclude a repo
  with '${NPX} never add' inside it. Precedence: BRAIN=1/0 > never.list > always.list > default.

  Tip: for zero npx overhead on every hook, 'npm i -g ${NAME}' and replace '${NPX}' with 'brain-rag'.
`);
console.log('✔ done. Opt a session in (claude --brain or /brain), then ask Claude to search your brain.');
