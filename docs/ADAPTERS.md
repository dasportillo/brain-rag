# Adapters — indexing another agent's transcripts

`brain-rag` indexes session transcripts through a small **adapter registry**
(`transcripts.mjs::ADAPTERS`). Everything generic — format dispatch (`parseSession`), discovery
(`ingest`/`import` walking session stores), and current-session lookup (`findCurrentTranscript`,
behind `keep_session` and `/brain`) — iterates the registry. So supporting another agent is one
`registerAdapter()` call plus a parser; no dispatch code changes anywhere.

Three adapters ship today, because those are the formats we can verify against real data:

| name | root | format marker |
|---|---|---|
| `opencode` | `~/.local/share/opencode/opencode.db` (SQLite) | virtual path `<db>#ses_<id>` |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | first line is a `session_meta` object |
| `claude-code` | `~/.claude/projects/**/*.jsonl` | per-line `sessionId`/`parentUuid` fields |

There is deliberately **no** Cursor/Windsurf/etc. adapter yet: a parser written from format
descriptions instead of real session files silently mis-indexes (wrong roles, un-dropped harness
noise, duplicated turns), and a corrupt memory is worse than no memory. If you use one of those
agents, you have the fixtures — the recipe below is everything needed.

## The adapter contract

```js
import { registerAdapter } from './transcripts.mjs';

registerAdapter({
  name: 'my-agent',                       // stable id
  root: join(homedir(), '.my-agent', 'sessions'),  // absolute dir the agent writes sessions under
  detect(filePath) { /* cheap: path or file-head sniff — NEVER a full parse */ },
  parse(filePath)  { /* → { turns, title, cwd } */ },
  currentSessionCwdMatch(filePath, cwd, root) { /* does this file belong to a session from cwd? */ },
  probeCap: 200,                          // only if the cwd match reads the file (I/O) — see below
  // Optional — only for a store that is NOT one .jsonl file per session (see the opencode adapter):
  list(root)   { /* every session path in the store (default: walk root for .jsonl) */ },
  stat(path)   { /* { mtimeMs, size } (default: fs.statSync) */ },
  exists(path) { /* still in the store? (default: fs.existsSync) — gone ones stay indexed as "archived" */ },
  cwdOf(path)  { /* cwd without a full parse (default: read it from the file head) */ },
});
```

What each piece must do:

- **`detect(filePath)`** — decide "is this file mine?" from the path or the first bytes
  (`ingest` probes every `.jsonl` under every root, so this runs a lot). Registration order is
  specificity order: adapters with a definitive marker go first; anything no adapter detects falls
  back to the `claude-code` parser (the historical default — harmless on foreign files, it just
  yields no turns).
- **`parse(filePath)`** — read the file once and normalize to `{ turns, title, cwd }`:
  - `turns`: array of `{ role, text, ts, session }`. Roles are a fixed vocabulary the whole
    retrieval side keys on: `user` / `assistant` (the conversation), `summary` (a compaction
    recap, kept whole at ingest), `actions` (one per-session trace of tool calls — build it with
    the same `ToolName: <command|file|…>` style the built-ins use, deduped and capped at 100).
  - `title`: the session's human-meaningful title, or `null`.
  - `cwd`: the directory the session was launched from — this is how the session gets its
    project name (`gitRootName(cwd)`), so recover it if the format records it at all.
  - Do **not** redact or chunk — ingest does that downstream, identically for every adapter.
- **`currentSessionCwdMatch(filePath, cwd, root)`** — used by `findCurrentTranscript` to prefer
  "the transcript being written right now **in this project**" over a busy parallel session
  elsewhere. `root` is passed so tests can re-root the adapter. If the check must read the file
  (like codex's head probe), set `probeCap` so only the newest N files pay that I/O; a pure
  path-string check needs no cap.

Then: add the file to `keep.list` (the brain is opt-in) or run `brain-rag import <filter>`, and
`ingest` picks it up like any other session.

## Worked example: the Codex adapter

The `codex` adapter is the reference implementation — every problem a new adapter must solve
shows up in it (`transcripts.mjs::parseCodexRollout` and the registry entry next to it).

**Detect: first-line `session_meta`.** A rollout's first line is its session metadata, so
detection is a 256-byte head read: `fileHead(filePath).includes('"type":"session_meta"')`. Find
the equivalent cheap marker for your format — a stable field name in the first line, or a
distinctive filename/directory shape. Never parse the whole file to answer "is this mine?".

**Normalize to `{ turns, title, cwd }`.** Rollouts interleave several line types; the parser
reads only `response_item` lines and maps them onto the shared vocabulary:

- `message` items with role `user`/`assistant` → conversation turns (text extracted from
  `input_text`/`output_text` content blocks).
- `function_call` / `custom_tool_call` items → distilled into ONE `role: "actions"` turn per
  session ("what was done": commands run, files touched), instead of indexing full tool inputs.
- `compacted` recaps → `role: "summary"` turns, so dense session overviews are retrievable.
- `cwd` comes from the `session_meta` first line — the real launch dir, not a derived path.

**Filter the noise — the part that decides index quality.** Agent transcripts are full of
harness-injected material that *looks* like conversation but isn't, and it poisons retrieval if
indexed. For Codex that means dropping: `event_msg` lines (UI duplicates of `response_item` —
indexing both double-counts every turn), `role: "developer"` items (harness config),
harness-injected user items (`<environment_context>`, `<turn_aborted>`, `<permissions…>`,
AGENTS.md and IDE-context dumps), and raw reasoning items. Expect an equivalent list in any
agent's format; finding it is precisely why an adapter needs real session files.

**Titles live where the agent puts them.** Codex rollouts carry no in-file title;
`~/.codex/session_index.jsonl` maps session id → `thread_name`, so the parser loads that index
lazily once per process and looks the title up. Claude Code, by contrast, embeds `ai-title`
lines in the transcript itself. Return `null` when there is no title — everything downstream
tolerates it.

**Current-session match.** The rollout's cwd sits on its first line, so
`currentSessionCwdMatch` is `codexHeadCwd(filePath) === cwd` — a head read, hence
`probeCap: 200` (only the 200 newest rollouts are probed).

**Prove it with a fixture test.** `test/transcripts.test.mjs::codexFixtureLines` is a minimal
but realistic rollout (meta line, harness noise, real turns, UI duplicates, tool calls, a
compaction recap) taken from real sessions. Build the same for your format and assert the
parsed roles/noise-drops — the suite is dependency-free (`npm test`, no model download).

## Worked example: the opencode adapter — a store that isn't files

opencode (1.x) keeps every session in ONE SQLite database (`session`, `message`, `part` tables),
so there is no per-session file for keep.list, `sessions.path` or ingest's change check to key on.
The adapter gives each session a **virtual path**, `<opencode.db>#<session id>`, and implements
the optional `list` / `stat` / `exists` / `cwdOf` hooks so every generic caller (ingest, import,
onboard, relabel, forget, `findCurrentTranscript`) keeps working by path, unchanged.

- **Detect** is a pure string match on that path, and the adapter is registered FIRST so no file
  adapter ever tries to open `"<db>#<id>"`.
- **stat** = (newest `time_updated` across the session, its messages and parts; total payload
  bytes) — the (mtime, bytes) pair ingest compares to skip unchanged sessions.
- **Parse**: user `text` parts minus `synthetic`/`ignored` ones (the post-compaction "Continue if
  you have next steps…" nudge, user-run tool echoes); assistant `text` parts; assistant messages
  with `summary: true` / `mode: "compaction"` → `role: "summary"`; `tool` parts → the actions trace
  (tool names capitalized: `bash` → `Bash: …`). `reasoning`, `step-*`, `patch` and `file` parts are
  dropped. Placeholder titles (`New session - <iso>`) become `null`.
- **Current session**: child sessions (`parent_id`, opencode's subagent runs) never match. The
  database is opened read-only; opencode keeps writing to it (WAL) while we read.

**Which agent is asking?** `findCurrentTranscript` prefers the store of the agent that launched
the MCP server, so `keep_session` from opencode never marks a parallel Claude Code session in the
same repo (and vice versa). opencode exports `OPENCODE_PID` to its MCP servers — trusted only when
that pid is an ancestor of the server process; Claude Code exports `CLAUDECODE=1`. Codex exports
nothing identifying, so it keeps the cwd-scoped recency rule.

Out of scope: opencode's pre-SQLite layout (`storage/` with one JSON file per message) and the
`session_message` table, which was empty in every database we could inspect.

## Any MCP client (Cursor, Windsurf, VS Code, …)

The two halves of brain-rag are independent, and only one of them needs an adapter:

- **Reading and writing the brain over MCP works from any client today.** The server is plain
  stdio MCP; every tool — `search_context`, `get_state`, `save_state`, `save_memories`,
  `list_projects` — behaves identically regardless of which editor is asking. Your Cursor
  session can search the history of your Claude Code, Codex and opencode work right now.
- **Indexing that agent's own transcripts needs an adapter.** Without one, ingest never sees the
  agent's session files, and `keep_session` / `/brain` (which mark "the transcript being written
  right now") can only match Claude Code/Codex/opencode sessions — so conversations held *in* that
  client aren't remembered until its adapter exists.

Generic config, pointing at the published package (no install step — `npx` fetches it):

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "brain-rag", "serve"]
    }
  }
}
```

Where it goes (same JSON shape unless noted — check your client's MCP docs for the current
location):

- **Cursor**: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project).
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`.
- **VS Code**: `.vscode/mcp.json`, under a `"servers"` key with `"type": "stdio"`:

  ```json
  { "servers": { "brain": { "type": "stdio", "command": "npx", "args": ["-y", "brain-rag", "serve"] } } }
  ```

One machine, one brain: every client talks to the same local index under `~/.claude/brain`, so
context recovered in one editor reflects work done in all of them.
