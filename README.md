# brain-rag

A local, private **"second brain"** over your Claude Code conversations. It indexes the chat
transcripts you **opt in** into a searchable vector store and exposes it back to Claude Code as an
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

- **Ingests** only the transcripts you **opt in** (from `~/.claude/projects/**/*.jsonl`) — the brain is OFF by default.
- **Chunks + embeds** the useful turns (user prompts + assistant text) with a local model; context-compaction **summaries** are kept whole (tagged `summary`) and each session's **title** is attached to every hit.
- **Stores** them in a single on-disk SQLite database with cosine search.
- **Serves** three tools over MCP so Claude Code can query your history from any project:
  - `search_context({query, project?, k?, since?})` — semantic search over past conversations.
  - `list_projects()` — indexed projects with session/chunk counts and last activity.
  - `get_state({project?})` — curated "current state" note for a project (the precise layer).
  - `save_state({content, project?})` — write/refresh that curated note (overwrites; drops stale decisions).
- **Opt-in by default** — a session is saved only via `claude --brain`, the `/brain` command, or being listed in `keep.list`; a `SessionEnd` hook then incrementally re-indexes the sessions you opted in.

## Architecture

```
~/.claude/projects/**/*.jsonl          (Claude Code transcripts — only the ones you opt in)
        │  ingest.mjs   (opt-in filter via keep.list → parse → redact → chunk → embed → upsert)
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
| **Local embeddings** (`Xenova/multilingual-e5-small`, 384-dim) — not a cloud API | Transcripts contain secrets (JWTs, AWS keys, DB passwords). Local = private, free, offline. Multilingual because the corpus mixes languages (see Evaluation). |
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

### Via npm (recommended)

```bash
npx -y brain-rag install
```

Registers the MCP server, installs the `/brain` and `/state` slash commands, and prints the opt-in
hook wiring for `~/.claude/settings.json`. It is **npx-native** — the code runs straight from the npm
package, nothing is copied; only the index and state notes live under `~/.claude/brain/`.

Just the search side (no ingestion/hooks) — point Claude Code straight at the server:

```bash
claude mcp add brain --scope user -- npx -y brain-rag serve
```

The `brain-rag` CLI also exposes `import` (backfill past conversations), `forget` (remove sessions
from the index), `relabel` (re-derive project names by git repo after upgrading), `ingest`,
`search`, `stats`, and `state` (`brain-rag help`).

**Import your existing conversations.** The brain is opt-in, so past chats aren't indexed until you
bring them in:

```bash
brain-rag import           # all previous conversations
brain-rag import myproj    # only projects matching "myproj"
brain-rag import --dry     # preview — writes nothing, embeds nothing
```

To uninstall: `npx -y brain-rag uninstall` (unregisters the MCP + removes the slash commands; add
`--purge` to also delete the index and state notes).

### From source

```bash
git clone git@github.com:dasportillo/brain-rag.git
cd brain-rag
./install.sh
```

`install.sh` will:
1. Copy the runtime into `~/.claude/brain/` and the `/brain` command into `~/.claude/commands/`.
2. `npm install` (embedding model + MCP SDK).
3. Register the MCP server globally (`claude mcp add brain --scope user`).
4. Print the **opt-in wiring** to add to `~/.claude/settings.json` (the `SessionStart` mark hook + the `SessionEnd` ingest hook) and the optional `claude --brain` shell wrapper.

The brain is **opt-in**: nothing is indexed until you opt a session in, so there is no bulk backfill.

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

### Temporal version signal in search

Search preserves **recall** — nothing is dropped — but a raw list of hits can't tell you *"is this
the current version of the plan, or an old draft?"*. So after ranking, `search_context` (and
`search.mjs`) compare the returned results pairwise: when two hits are near-duplicate in **topic**
(embedding cosine ≥ **0.92**) but carry **different dates**, they're the same thing at two points in
time, and the results are annotated accordingly:

- the older hit is marked **⚠️ SUPERSEDED**, pointing at the newer date;
- the newest hit is marked **✅ latest of N versions**, listing the older dates it supersedes.

This is a **signal only** — every version stays in the results — so you can distinguish the live
version of a decision from an earlier revision without losing the history that led to it.

### Cross-project facet in search

When one query's results blend several projects, search says so up front — `📂 Results span N
projects: a (4) · b (3) …` — because the same term can mean different things per project (a
financial event *audit-log* vs medical-claims *"auditoría"*) and an inline blend goes unnoticed.
Counts only, ranking untouched. It deliberately does **not** try to flag which project is
"off-topic": measured on a live corpus, centroid and query-residual similarities between
false-friend project pairs (0.78–0.83) overlap same-product pairs (0.68–0.84), so no threshold
separates them — a flag would be wrong too often to trust. The reader (usually the model) sees the
blend and scopes with `project:` when needed.

### Current state layer (`get_state` / `save_state`)

`get_state` serves a curated `state/<project>.md` — the precise "where am I parked today" note that
complements the fuzzy recall of `search_context`. Refresh it with the **`/state`** command, which
drives the in-session model to gather recent activity, synthesize the note, and persist it via
`save_state` — **no external API**, the LLM is already in the loop:

```bash
node state.mjs --list         # projects with activity
node state.mjs my-notes        # dump a project's recent material (what /state feeds on)
```

`/state [project]` then writes `state/<project>.md` (Now / In flight / Decisions / Blockers / Next).
Overwriting is deliberate: it removes stale/reverted decisions instead of letting them resurface. The
notes are gitignored — they contain your work details.

When **no curated note exists**, `get_state` no longer dead-ends: it falls back to the project's
recent indexed activity (last 30 days, deduped, clearly marked *NOT curated*) so the caller gets raw
material to work from — and a nudge to synthesize and `save_state` the real note.

### Project aliases (`aliases.json`)

A project is named by its **git repo** (the repo the session's cwd lives in), so the same repo is one
project no matter which subdirectory Claude was launched in. That removes most fragmentation on its
own. What it deliberately does *not* do is merge **separate repos** that you think of as one product
(e.g. an `efy3` workspace of 15 independent service repos) — no heuristic gets that right for
everyone, so it's left as opt-in. An **optional** `~/.claude/brain/aliases.json`
merges those repos into one **canonical** project:

```json
{ "efy3": ["efy3-users", "efy3-bff", "ledger-core", "efy-transactions"] }
```

Each key is the canonical name; its array lists the repo names (as shown by `list_projects` /
`brain-rag list`) that fold into it. With this in place:

- **`list_projects`** collapses the fragments into a single row (summed counts, newest activity);
- **search filtering** — a `--project` / `project` filter on the canonical name matches **all**
  members, so one query spans every fragment;
- **`get_state` / `save_state`** read and write a single `state/<canonical>.md`.

An **absent or malformed** file means identity — zero behavior change, so it's safe to skip. One
caveat: don't merge in a project whose sessions are actually off-topic (e.g. a tool built inside
another repo's workspace) — that folds unrelated chatter into the canonical project and
re-introduces the contamination search-time de-dup was added to remove.

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

### LLM-as-judge (the trustworthy instrument)

Keyword matching (`eval.mjs`) is fast but **overcounts** — a chunk can contain the marker token yet
be irrelevant, and a relevant chunk in another language contains no English marker at all. So the
authoritative eval is `eval-judge.mjs`, which decouples retrieval from judging:

```bash
node eval-judge.mjs --emit                 # retrieve top-K per query -> eval-bundle.json
# an LLM judges which results are actually relevant -> verdicts.json
node eval-judge.mjs --score verdicts.json  # Recall@K / MRR / P@K from judged relevance
```

The judge decides relevance by **meaning**, language- and keyword-agnostic. On this corpus the
keyword eval reported 50–80% Recall@5 while the LLM-judged eval reported **30%** — the gap *is* the
overcounting. 30% became the honest baseline to improve against.

Acting on the misses **doubled it to 60% Recall@5** (MRR 0.18 → 0.47) with four changes, each
re-measured on the same judge: a real retrieval model (`multilingual-e5-small` with `query:`/`passage:`
prefixes) instead of a paraphrase model, **search-time de-duplication** of identical chunks that
appear under two project paths, purging harness noise (`clean.mjs` removes task/tool notifications
that polluted retrieval), and toning down the recency boost that was over-promoting today's sessions.
Then adding **hybrid retrieval** (vector + lexical fused with Reciprocal Rank Fusion — pass
`queryText` to `searchChunks`) took it to **80% Recall@5** (MRR 0.63): the exact-term queries that
pure vectors missed (`groups-claim`, `SKIP_KEYS`) came back into the top-5. The two
remaining misses need smaller chunks for very long multi-topic reports (a re-embed) — clear
diminishing returns. `eval-bundle.json` / `verdicts.json` are gitignored (they contain transcript
text).

## How updating works (opt-in + incremental)

The brain is **opt-in**: `ingest.mjs` only considers transcripts listed in `keep.list`. You add a
session to it by starting with `claude --brain` (the `mark-keep.mjs` `SessionStart` hook) or by
running `/brain` mid-conversation (`mark-current-keep.mjs`).

Among opted-in sessions it is **incremental**: each session is one `.jsonl` file and the `sessions`
table stores its `(mtime, bytes)`, so on every run only new or grown files are re-indexed:

```
run:  1 processed, N skipped      ← only the opted-in session that grew was re-indexed
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
| `BRAIN_MODEL` | `Xenova/multilingual-e5-small` | local embedding model |

## Roadmap

- Grow `eval-cases.json` well beyond 10 cases and exclude eval sessions from the corpus (avoid
  overfitting and the RAG indexing its own eval runs).
- Auto-refresh `state/<project>.md` on a cadence instead of on demand.
- A stronger retrieval model (e.g. bge-m3) — measure only once the eval set is larger.
- Optional connectors (Slack, other chat exports) as additional corpora.

## Files

| File | Responsibility |
|---|---|
| `transcripts.mjs` | parse `.jsonl`, chunk, redact secrets |
| `embed.mjs` | local embeddings (transformers.js) |
| `store.mjs` | `node:sqlite` schema, cosine search, stats |
| `ingest.mjs` | opt-in + incremental ingestion CLI |
| `search.mjs` | CLI search |
| `mark-keep.mjs` | `SessionStart` opt-in hook (`BRAIN=1` → `keep.list`) |
| `mark-current-keep.mjs` | `/brain` backend — opt the current session in |
| `commands/brain.md` | the `/brain` slash command (opt a session in) |
| `commands/state.md` | the `/state` slash command (write the curated state note) |
| `eval.mjs` + `eval-cases.json` | recall eval harness + labeled cases |
| `server.mjs` | MCP server |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deep dive.
