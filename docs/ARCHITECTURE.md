# Architecture

This document explains how `brain-rag` works end to end, and the reasoning behind each stage. It is
the deep dive behind the overview in the [README](../README.md).

## Overview

`brain-rag` is a five-stage pipeline plus a retrieval surface:

```
ingest:  discover → opt-in filter → parse → redact → chunk → embed → store (+ FTS index via triggers)
serve:   query → embed → [vector scan ∥ FTS5/BM25] → RRF fuse (+recency) → top-k → return
```

Nothing leaves the machine. Embeddings are computed locally, the store is a local SQLite file, and
the MCP server talks to Claude Code / Codex over stdio.

## The corpus

Two sources, one index. Claude Code writes one `.jsonl` file per session under:

```
~/.claude/projects/<dashified-cwd>/<sessionId>.jsonl
```

`<dashified-cwd>` is the working directory with `/` replaced by `-`, e.g.
`-Users-you-project-my-project`. The **project name** is derived from it by
stripping the `-Users-<user>-project-` prefix (`transcripts.mjs::projectFromPath`).

Each line is a JSON object. The fields we rely on:

| Field | Use |
|---|---|
| `type` | `user` / `assistant` / (ignored: `attachment`, `mode`, `system`, …) |
| `sessionId` | groups turns into a conversation |
| `timestamp` | ISO8601, used for recency boost and `since` filtering |
| `message.role` | `user` \| `assistant` |
| `message.content` | **string** on user turns; **array of blocks** on assistant turns |

Assistant content is an array of blocks (`thinking`, `text`, `tool_use`, …). We keep `text` blocks
and distil `tool_use` blocks into a compact per-session **actions trace** (role `actions`); `thinking`
is dropped as verbose/low-signal. User content that is an array (tool results) is skipped — that
filters out most tool noise automatically.

Codex writes one **rollout** per session under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — a
different line schema (`session_meta` first line with the real `cwd`, then `response_item` lines for
messages/`function_call`s, `event_msg` lines duplicating them for the UI, and `compacted` recaps).
`transcripts.mjs::parseSession` sniffs the first line (`"type":"session_meta"` → rollout) and
dispatches to the right parser; both normalize to the same `{ turns, title, cwd }`, so every stage
below is host-agnostic. Codex-specific notes: `event_msg` lines and `role: "developer"` items are
skipped (duplicates / harness config), harness-injected user items (`<environment_context>`,
`<turn_aborted>`, AGENTS.md and IDE-context dumps) are dropped as noise, non-empty `compacted`
messages become `role: "summary"` turns, and titles come from `~/.codex/session_index.jsonl`
(`thread_name`, only present for named threads).

## Stage 1 — Parse (`transcripts.mjs::parseTranscript` / `parseCodexRollout`)

Reads the file once and returns `{ turns, title }`. Each turn is normalized to
`{ role, text, ts, session }`; command wrappers and harness reminders (`<command-name>`,
`<local-command…>`, `<system-reminder>`, …) are dropped as noise. Two special cases:

- **Context-compaction summaries** (`isCompactSummary` entries) are system-written recaps, not the
  user's words, so they are tagged `role: "summary"` — kept **whole** (see Stage 3), and only the
  latest (most complete) summary per session is retained.
- **`ai-title`** (Claude Code's auto-generated session title) is surfaced as `title`, stored on the
  `sessions` row, and attached to every search hit so results show which session they came from.
- **`tool_use`** blocks are distilled into one `role: "actions"` turn per session — a deduped, capped
  (≤100) trace of `ToolName: <command|file|pattern|url>` lines, so "what did we do" (which files,
  which commands) is searchable without indexing full, secret-bearing tool inputs.

## Stage 2 — Redact (`transcripts.mjs::redact`)

Before storing, obvious secrets are replaced with placeholders:

- JWTs (`eyJ….….…`) → `[JWT_REDACTED]`
- AWS access keys (`AKIA…`) → `[AWS_KEY_REDACTED]`
- Google API keys (`AIza…`) → `[GOOGLE_KEY_REDACTED]`
- OpenAI / Anthropic-style keys (`sk-…`, `sk-proj-…`, `sk-ant-…`) → `[API_KEY_REDACTED]`
- Slack tokens (`xox…`) → `[SLACK_TOKEN_REDACTED]`
- GitHub tokens (`ghp_/gho_/ghu_/ghs_/ghr_…`) → `[GH_TOKEN_REDACTED]`
- PEM private keys → `[PRIVATE_KEY_REDACTED]`
- Passwords in URLs (`user:pass@host`) and `KEY=value` / `KEY: value` env-style secrets (`password`, `secret`, `token`, `api_key`, …) → `[SECRET_REDACTED]`

This is a best-effort scrub, not a guarantee. It exists because the corpus demonstrably contains
credentials from past sessions. The store is local, so this is defense in depth.

## Stage 3 — Chunk (`transcripts.mjs::chunkText`)

Each turn is split into ~1800-character windows with 200-character overlap. Turns shorter than the
window become a single chunk. **Chunks under 80 characters are dropped** at ingest time — these are
low-signal narration lines ("Let me check the config…") that would otherwise pollute retrieval.
**Summaries are the exception**: they are stored whole (one row) so the coherent recap survives; their
embedding is computed over a representative head slice (the model window truncates long text anyway).

Chunk size is a recall/precision tradeoff: smaller chunks localize a fact better but lose surrounding
context; larger chunks preserve context but dilute the embedding. ~1800 chars (~450 tokens) is a
reasonable middle for conversational text.

## Stage 4 — Embed (`embed.mjs`)

Uses `@huggingface/transformers` (transformers.js) with `Xenova/multilingual-e5-small` — an e5
**retrieval** model that needs asymmetric prefixes (`query: ` / `passage: `) so queries and documents
land in the same space (`embed.mjs::withPrefix`):

- 384-dimensional, mean-pooled, L2-normalized vectors.
- The model downloads once and is cached; subsequent runs are offline.
- Batched (default 32) to bound memory.

**Why multilingual.** The corpus is bilingual (Spanish work chats + English tooling). An
English-only model (`all-MiniLM-L6-v2`) fails cross-lingual retrieval: an English query scored ~0.60
against Spanish content that a Spanish query scored ~0.82 on — a measured 80%→ gap surfaced by the
eval (see below). The multilingual model keeps 384 dims, so it is a drop-in swap with no store change.

Because vectors are normalized, **cosine similarity reduces to a dot product**, which keeps search
trivial and fast.

Swap the model via `BRAIN_MODEL`. If you change the embedding model or the chunking rules, re-embed
with `node ingest.mjs --force` (existing vectors are only comparable to vectors from the same model).

## Stage 5 — Store (`store.mjs`)

Two tables in a single SQLite database (`node:sqlite`, WAL mode, `busy_timeout` so concurrent writers
wait instead of erroring):

```sql
sessions(path PK, project, session, mtime, bytes, chunks, indexed_at)  -- incremental bookkeeping
chunks(id PK, path, project, session, ts, role, text, embedding BLOB)  -- the index
```

Embeddings are stored as a `Float32Array` BLOB (`vecToBlob` / `blobToVec`). There is no ANN index:
`searchChunks` loads candidate rows and computes cosine in JS. At tens of thousands of chunks this is
sub-100 ms and removes an entire dependency (pgvector/FAISS/a vector DB). If the corpus grows past a
few hundred thousand chunks, this is the first thing to revisit (add an ANN index or move to
`sqlite-vec`).

### Ranking

Pure-vector mode scores each candidate as `cosine + recencyBoost` (boost `0.05 * exp(-ageDays/45)`),
a small nudge toward recent conversations without letting recency dominate.

**Hybrid mode** (when `queryText` is passed — the MCP server and CLI always do) fuses rankings with
Reciprocal Rank Fusion (RRF): the vector ranking, a lexical ranking (rarity/idf-weighted term overlap
over the candidate set), and a **recency** ranking at half weight (a gentle nudge worth ~half a vector
rank, so recent conversations surface without dominating). RRF (`score = Σ w/(60 + rank)`) needs no
score normalization and is robust to signals living on different scales. This is what recovers exact-term queries (error codes, `groups-claim`,
`SKIP_KEYS`) that a pure embedding buries under long, semantically-broad chunks — it took the
eval from 60% to 80% Recall@5.

## Opt-in + incremental ingestion (`ingest.mjs`)

The brain is **opt-in**: by default nothing is indexed. `ingest.mjs` loads `keep.list` (one
transcript path per line) into a `KEPT` set and skips any file not in it. A session is added to
`keep.list` by `mark-keep.mjs` (the `SessionStart` hook, when started with `BRAIN=1`) or by
`mark-current-keep.mjs` (the `/brain` slash command, mid-session).

Among opted-in files the core property is that **re-running is cheap**. For each transcript file:

1. If it is not in `keep.list` → **skip** (opt-in gate).
2. `stat` it → `(mtime, bytes)`.
3. If the `sessions` row matches (unchanged) and `--force` is not set → **skip**.
4. Otherwise: delete the file's old chunks, re-parse/redact/chunk, embed, insert, and upsert the
   `sessions` row inside a transaction.

So a run indexes the opted-in sessions; later runs only touch new files and active sessions that
grew. This is what makes the `SessionEnd` hook viable — closing a session re-indexes just that one
file (if it was opted in).

## Retrieval surface (`server.mjs`)

An MCP server (`@modelcontextprotocol/sdk`, stdio transport) exposing:

- **`search_context`** — embeds the query, runs `searchChunks`, returns the top-k chunks formatted
  with project/date/role/score. `project` filters to one project; omit it to search everything.
- **`list_projects`** — aggregates the `chunks` table by project.
- **`get_state`** — reads `state/<project>.md` (the curated, precise layer). Defaults to the project
  derived from the current working directory.
- **`save_state`** — writes/overwrites `state/<project>.md`. The in-session model (via the `/state`
  command) gathers recent activity with `state.mjs`, synthesizes the note, and calls this to persist
  it — no external API, the LLM is already in the loop. Overwriting is deliberate: it removes stale
  decisions instead of letting them resurface.

Registered globally with `claude mcp add brain --scope user -- node ~/.claude/brain/server.mjs`, so
the tools are available in every project's sessions.

## Opt-in and auto-update hooks

Two hooks in `~/.claude/settings.json`, added alongside any existing entries:

- **`SessionStart` → `mark-keep.mjs`**: if the session started with `BRAIN=1` (e.g. `claude --brain`),
  it appends the session's `transcript_path` to `keep.list`. Without `BRAIN` it does nothing.
- **`SessionEnd` → `ingest.mjs`**, run **detached**:

  ```
  nohup node "~/.claude/brain/ingest.mjs" >> "~/.claude/brain/ingest.log" 2>&1 &
  ```

  Detaching means it never blocks session close; the opt-in gate + incremental logic mean it only
  processes the session that just ended, and only if it was opted in.

Mid-session, the `/brain` slash command (`commands/brain.md` → `mark-current-keep.mjs`) opts the
current conversation in after the fact.

## Evaluation (`eval.mjs`)

Retrieval quality is measured with a known-item recall eval. `eval-cases.json` holds labeled cases —
each a natural-language paraphrase of something known to be in the corpus, plus `expectAny` regexes
that a correct chunk should match. `eval.mjs` embeds every query, runs `searchChunks`, and reports
**Recall@K** (fraction of queries whose top-K contains a matching chunk) and **MRR**. It doubles as a
regression guard: change chunking or the model, re-run, and see whether recall moved. Grow the case
set whenever a real query misses.

## Known limitations / next steps

- **Chunking is char-based**, not token-aware or semantic-boundary-aware.
- **`get_state` notes refresh on demand** — `/state` (→ `save_state`) regenerates `state/<project>.md`; there is no automatic cadence yet.
- **Brute-force search.** No ANN index yet; revisit (`sqlite-vec` / FAISS) past a few hundred thousand chunks.
