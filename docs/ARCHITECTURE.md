# Architecture

This document explains how `brain-rag` works end to end, and the reasoning behind each stage. It is
the deep dive behind the overview in the [README](../README.md).

## Overview

`brain-rag` is a five-stage pipeline plus a retrieval surface:

```
ingest:  discover → parse → redact → chunk → embed → store
serve:   query → embed → cosine top-k → return
```

Nothing leaves the machine. Embeddings are computed locally, the store is a local SQLite file, and
the MCP server talks to Claude Code over stdio.

## The corpus

Claude Code writes one `.jsonl` file per session under:

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

Assistant content is an array of blocks (`thinking`, `text`, `tool_use`, …). We keep only `text`
blocks. User content that is an array (tool results) is skipped — that filters out most tool noise
automatically.

## Stage 1 — Parse (`transcripts.mjs::parseTurns`)

Streams the file line by line, `JSON.parse` per line (malformed lines are skipped), and yields
normalized turns `{ role, text, ts, session }`. Command wrappers and harness reminders
(`<command-name>`, `<local-command…>`, `<system-reminder>`, …) are dropped as noise.

## Stage 2 — Redact (`transcripts.mjs::redact`)

Before storing, obvious secrets are replaced with placeholders:

- JWTs (`eyJ….….…`) → `[JWT_REDACTED]`
- AWS access keys (`AKIA…`) → `[AWS_KEY_REDACTED]`
- Slack tokens (`xox…`) → `[SLACK_TOKEN_REDACTED]`
- PEM private keys → `[PRIVATE_KEY_REDACTED]`
- GitHub tokens (`ghp_…`) → `[GH_TOKEN_REDACTED]`

This is a best-effort scrub, not a guarantee. It exists because the corpus demonstrably contains
credentials from past sessions. The store is local, so this is defense in depth.

## Stage 3 — Chunk (`transcripts.mjs::chunkText`)

Each turn is split into ~1800-character windows with 200-character overlap. Turns shorter than the
window become a single chunk. **Chunks under 80 characters are dropped** at ingest time — these are
low-signal narration lines ("Let me check the config…") that would otherwise pollute retrieval.

Chunk size is a recall/precision tradeoff: smaller chunks localize a fact better but lose surrounding
context; larger chunks preserve context but dilute the embedding. ~1800 chars (~450 tokens) is a
reasonable middle for conversational text.

## Stage 4 — Embed (`embed.mjs`)

Uses `@huggingface/transformers` (transformers.js) with `Xenova/all-MiniLM-L6-v2`:

- 384-dimensional, mean-pooled, L2-normalized vectors.
- The model (~23 MB quantized) downloads once and is cached; subsequent runs are offline.
- Batched (default 32) to bound memory.

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

`searchChunks` scores each candidate as `cosine + recencyBoost`, where the boost decays exponentially
with age (`0.15 * exp(-ageDays/45)`). This nudges recent conversations up without letting recency
dominate similarity — a mitigation for the "stale decision resurfaces" failure mode.

## Incremental ingestion (`ingest.mjs`)

The core property: **re-running is cheap**. For each transcript file:

1. `stat` it → `(mtime, bytes)`.
2. If the `sessions` row matches (unchanged) and `--force` is not set → **skip**.
3. Otherwise: delete the file's old chunks, re-parse/redact/chunk, embed, insert, and upsert the
   `sessions` row inside a transaction.

So the first run indexes everything; later runs only touch new files and active sessions that grew.
This is what makes the `SessionEnd` hook viable — closing a session re-indexes just that one file.

## Retrieval surface (`server.mjs`)

An MCP server (`@modelcontextprotocol/sdk`, stdio transport) exposing:

- **`search_context`** — embeds the query, runs `searchChunks`, returns the top-k chunks formatted
  with project/date/role/score. `project` filters to one project; omit it to search everything.
- **`list_projects`** — aggregates the `chunks` table by project.
- **`get_state`** — reads `state/<project>.md` (the curated, precise layer). Defaults to the project
  derived from the current working directory.

Registered globally with `claude mcp add brain --scope user -- node ~/.claude/brain/server.mjs`, so
the tools are available in every project's sessions.

## Auto-update hook

A second `SessionEnd` entry in `~/.claude/settings.json` runs the ingest **detached**:

```
nohup node "~/.claude/brain/ingest.mjs" >> "~/.claude/brain/ingest.log" 2>&1 &
```

Detaching means it never blocks session close; the incremental logic means it only processes the
session that just ended. It is added alongside any existing `SessionEnd` hooks, not in place of them.

## Known limitations / next steps

- **No eval.** Retrieval quality is currently judged by eye. A labeled recall set (query → expected
  chunk) is the next real step.
- **Chunking is char-based**, not token-aware or semantic-boundary-aware.
- **`get_state` notes are manual** — there is no flow yet to generate/update `state/<project>.md`.
- **Single embedding model.** No hybrid lexical+vector (BM25) fallback for exact-term queries.
