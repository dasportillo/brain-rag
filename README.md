# brain-rag

A local, private **"second brain"** over your Claude Code conversations. It indexes every chat
transcript on your machine into a searchable vector store and exposes it back to Claude Code as an
MCP server, so any future session can recover the exact context of what you were working on — across
every project.

Everything runs **locally**: local embedding model, on-disk SQLite, zero external APIs. Your
transcripts (which contain secrets) never leave the machine.

---

## Why

Work gets scattered across chats. You lose the thread of what you decided, what's in flight, and why.
Claude Code already stores every session as a `.jsonl` transcript under `~/.claude/projects/`, so the
raw material already exists — `brain-rag` turns those hundreds of sessions into recallable memory.

## What it does

- **Ingests** all `~/.claude/projects/**/*.jsonl` transcripts (across all your projects).
- **Chunks + embeds** the useful turns (user prompts + assistant text) with a local model.
- **Stores** them in a single on-disk SQLite database with cosine search.
- **Serves** three tools over MCP so Claude Code can query your history from any project:
  - `search_context({query, project?, k?, since?})` — semantic search over past conversations.
  - `list_projects()` — indexed projects with session/chunk counts and last activity.
  - `get_state({project?})` — curated "current state" note for a project (the precise layer).
- **Updates incrementally** — a `SessionEnd` hook re-indexes only the session you just closed.

## Architecture

```
~/.claude/projects/**/*.jsonl          (all Claude Code transcripts, all projects)
        │  ingest.mjs   (walk → parse → redact → chunk → embed → upsert)
        ▼
  brain.db  (node:sqlite, embeddings as BLOB, brute-force cosine search)
        ▲
        │  MCP tools
  server.mjs  (MCP server) ── search_context · list_projects · get_state
        ▲
        │  registered globally (claude mcp add --scope user)
   Claude Code (in ANY repo) ── queries your second brain
```

### Design decisions (and why)

| Choice | Why |
|---|---|
| **Local embeddings** (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim) — not a cloud API | Transcripts contain secrets (JWTs, AWS keys, DB passwords). Local = private, free, offline. Multilingual because the corpus mixes languages (see Evaluation). |
| **`node:sqlite`** (Node's built-in SQLite) | Zero native compilation. Ships with Node 22.5+. |
| **Brute-force cosine in JS** — no `pgvector`, no vector DB | At this scale (tens of thousands of chunks) it's sub-100 ms. No server, no Docker to keep running. |
| **Embedded store, always-on** | A personal brain must answer from any project at any time, even if no daemon is up. |
| **Redaction at ingest** | JWTs / `AKIA…` / private keys / tokens are scrubbed before anything is stored. |

### Why hybrid (RAG + structured state)

RAG is **fuzzy recall**: great for *"what did we decide about X weeks ago?"*, but risky for *"what's
the current state?"* — it can resurface a reverted decision as if it were live. So `get_state`
provides a **precise, curated** layer (`state/<project>.md`) that complements the fuzzy vector search.

| Question | Tool | Precision |
|---|---|---|
| "what am I working on **today** in X?" | `get_state(X)` | exact (curated) |
| "what did we ever discuss about X?" | `search_context` | fuzzy (high recall) |

---

## Install

Requires **Node 22.5+** (built-in `node:sqlite`). Tested on Node 25.

```bash
git clone git@github.com:dasportillo/brain-rag.git
cd brain-rag
./install.sh
```

`install.sh` will:
1. `npm install` (embedding model + MCP SDK).
2. Copy the runtime into `~/.claude/brain/` (the location the MCP server and hook point to).
3. Register the MCP server globally (`claude mcp add brain --scope user`).
4. Optionally install the `SessionEnd` auto-update hook.
5. Run the initial backfill.

> The runtime lives at `~/.claude/brain/`; this repo is the source of truth. Re-run `./install.sh`
> after pulling changes.

## Usage

### From Claude Code (MCP)
Once registered, in any project the model can call:
- `search_context({ query: "how the users↔documents bridge works" })`
- `search_context({ query: "audit hash chain", project: "my-project" })`
- `list_projects()`
- `get_state({ project: "my-project" })`

### From the CLI
```bash
node search.mjs "how does the incremental index work"
node search.mjs --project my-project "role-based access"
node ingest.mjs --stats
node eval.mjs        # run the recall eval (see Evaluation)
```

## Evaluation

Retrieval quality is measured, not eyeballed. `eval.mjs` runs a labeled set of **known-item**
queries (`eval-cases.json`) — each a natural-language paraphrase of something known to be in the
corpus — and checks whether the correct content appears in the top-K, reporting **Recall@K** and
**MRR** (mean reciprocal rank).

```bash
node eval.mjs 5      # K=5
```

This is the loop that turns "a RAG that runs" into "a RAG that works": measure → diagnose → fix →
re-measure. A concrete example from this project: the first eval (English `all-MiniLM-L6-v2`) scored
80% Recall@5, and the two misses were both **cross-lingual** — the corpus is bilingual
(Spanish/English) and the English-only model couldn't bridge an English query to Spanish content
(scores jumped from ~0.60 to ~0.82 when the same query was asked in Spanish). Switching to a
**multilingual** model addressed exactly that failure mode. Add cases to `eval-cases.json` as you
find gaps.

## How updating works (incremental)

Each session is one `.jsonl` file. The `sessions` table stores its `(mtime, bytes)`. On every run,
`ingest.mjs` re-indexes **only** files that are new or have grown (active sessions); everything else
is skipped:

```
1st run:  479 processed, 0 skipped        ← indexes everything
2nd run:    1 processed, 478 skipped      ← the live session grew; only it was re-indexed
```

The `SessionEnd` hook fires this automatically (detached, non-blocking) when you close a session, so
the brain stays current with no manual step.

### Ingest flags
| Flag | Effect |
|---|---|
| *(none)* | incremental, with embeddings |
| `--no-embed` | parse/chunk/store only, fast, no model load |
| `--limit N` | process at most N sessions (for testing) |
| `--force` | re-process everything (e.g. to re-embed after a chunking change) |
| `--stats` | print index status and exit |

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `BRAIN_DIR` | `~/.claude/brain` | where the DB and `state/` live |
| `BRAIN_DB` | `$BRAIN_DIR/brain.db` | SQLite path |
| `BRAIN_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | local embedding model |

## Roadmap

- `state/<project>.md` curation flow for `get_state` (the precise layer).
- Grow `eval-cases.json` and track Recall@K over time as chunking/model change.
- Hybrid retrieval (lexical BM25 + vector) for exact-term queries like error codes / IDs.
- Optional connectors (Slack, other chat exports) as additional corpora.

## Files

| File | Responsibility |
|---|---|
| `transcripts.mjs` | parse `.jsonl`, chunk, redact secrets |
| `embed.mjs` | local embeddings (transformers.js) |
| `store.mjs` | `node:sqlite` schema, cosine search, stats |
| `ingest.mjs` | incremental ingestion CLI |
| `search.mjs` | CLI search |
| `eval.mjs` + `eval-cases.json` | recall eval harness + labeled cases |
| `server.mjs` | MCP server |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deep dive.
