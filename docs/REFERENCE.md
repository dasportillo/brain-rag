# Reference

Operational reference moved out of the product README. The conceptual deep dive is in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the measured quality history is in
[`EVAL-BASELINE.md`](EVAL-BASELINE.md).

## CLI

```
npx -y brain-rag <command>

  install         Register the MCP server (Claude Code + Codex) + /brain, /state, /distill; print hook wiring
  uninstall       Reverse of install (--purge also deletes the index + state notes)
  serve           Run the MCP server (stdio) — what 'claude mcp add' / 'codex mcp add' launches
  ingest          Index opted-in transcripts (incremental)
  import [filter] Backfill EXISTING conversations (both agents' stores; --dry to preview)
  forget <filter> Remove matching sessions from the index + keep.list (--all, --dry)
  relabel         Re-derive project names from each session's git repo (no re-embed; --dry)
  stats           Print index status
  search "query"  Search from the CLI
  state [project] Dump a project's recent activity (raw material for /state)
  mark-keep       SessionStart hook backend (BRAIN=1 → keep.list)
  mark-current    Opt the CURRENT session in (the /brain command backend)
```

## MCP tools

| Tool | Purpose |
|---|---|
| `search_context(query, project?, k?, since?, role?, layer?)` | Hybrid search over the whole history. `role`: `summary` (compaction recaps) / `actions` (commands & files) / `user` / `assistant`. `layer`: `both` (default) / `memories` / `raw`. |
| `get_state(project?)` | Curated "where I am today" note; falls back to recent activity (marked NOT curated). |
| `save_state(content, project?)` | Write/overwrite the curated state note. |
| `save_memories(memories[])` | Write distilled Layer-2 memories (typed, self-contained, with provenance). Same title refreshes; `supersedes:<id>` retires the predecessor; similar existing memories are warned, never auto-retired. |
| `keep_session()` | Opt THIS session into indexing (works from Claude Code and Codex). |
| `list_projects()` | Indexed projects with counts and freshness. |

## Memory types & statuses

Types (one table, controlled vocabulary): `decision fact architecture bug solution todo question
meeting preference workflow code_pattern aws_resource database deployment incident learning`.
Statuses: `active superseded deprecated experimental obsolete` — search returns `active` by default.

## Ingest flags

| Flag | Effect |
|---|---|
| *(none)* | incremental, with embeddings |
| `--no-embed` | parse/chunk/store only (fast, no model load) |
| `--limit N` | process at most N sessions |
| `--force` | re-process everything (e.g. re-embed after a model change) |
| `--stats` | print index status and exit |

Incrementality: each session is one `.jsonl` file; the `sessions` table stores `(mtime, bytes)`, so
only new or grown files are re-indexed, and within a file only new/changed chunks are re-embedded.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `BRAIN_DIR` | `~/.claude/brain` | data dir (DB, `state/`, `keep.list`, `aliases.json`) |
| `BRAIN_DB` | `$BRAIN_DIR/brain.db` | SQLite path |
| `BRAIN_MODEL` | `Xenova/multilingual-e5-small` | local embedding model |
| `BRAIN_ALIASES` | `$BRAIN_DIR/aliases.json` | project alias map |
| `BRAIN` | *(unset)* | `BRAIN=1` opts the session in via the SessionStart hook |

## Project aliases (`aliases.json`)

Merges fragmented project names into one canonical project for `list_projects`, search filtering
and `get_state`/`save_state`:

```json
{ "efy3": ["efy3-workspace", "efy3-users"] }
```

An absent or malformed file means identity (zero behavior change). Don't merge projects whose
sessions are actually off-topic — that re-introduces the cross-project contamination the search
de-dup removed.

## Evaluation

`node eval.mjs 8` runs the labeled known-item eval (prefers your gitignored
`eval-cases.local.json`); `--json` emits the metrics row for `EVAL-BASELINE.md`; `--semantic` runs
the vector-only ablation. Case format:

```json
{ "query": "natural-language paraphrase", "expectAny": ["regex", "…"],
  "kind": "solution|decision|exact-term|entity|state", "lang": "en|es" }
```

Chunks containing the literal query are ignored at scoring time (self-echo guard), so an indexed
eval session can't grade itself. An LLM-as-judge harness (`eval-judge.mjs`) complements the regex
hit-rule when relevance is subtler than a pattern match.

## Files

| File | Responsibility |
|---|---|
| `transcripts.mjs` | parse both transcript formats (Claude Code + Codex rollouts), chunk, redact, find the current session |
| `embed.mjs` | local embeddings (transformers.js) |
| `store.mjs` | SQLite schema + migrations, hybrid search (chunks + memories), memory store, stats |
| `ingest.mjs` / `import.mjs` / `forget.mjs` / `relabel.mjs` | index lifecycle |
| `search.mjs` / `state.mjs` | CLI search / state dump |
| `mark-keep.mjs` / `mark-current-keep.mjs` | opt-in backends (hook / command) |
| `server.mjs` | the MCP server |
| `eval.mjs` + `eval-metrics.mjs` | recall eval harness + pure metric layer |
| `install.mjs` / `uninstall.mjs` | wiring for Claude Code + Codex |
