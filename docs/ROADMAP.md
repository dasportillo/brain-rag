# Roadmap

Brain-RAG set out to turn *searchable history* into **long-term memory**: raw transcripts stay
the immutable source of truth (Layer 1), and on top of them sits a distilled, traceable, temporal
**memory store** (Layer 2), hybrid retrieval, and automatic learning. That plan (v0.6 → v1.0) is
done. This page records what shipped, the principles that still frame every change, and what
comes next.

## Principles

1. **The calling agent supplies the intelligence; the server stays deterministic and local.**
   Extraction, synthesis and query understanding are done by the LLM that is already running
   (Claude Code / Codex / opencode), never by the server calling external APIs. The server's job:
   store, index, filter, rank, assemble.
2. **Local by default.** Local embedding model, local database, no telemetry. The one exception is
   the opt-in **Brain Teams** sync (`brain-rag cloud login`), which sends distilled Layer-2
   memories only — never raw transcripts — and honours `private: true`.
3. **Opt-in capture.** Nothing is kept unless you ask: per-session `BRAIN=1` / `/brain`, per-repo
   `always`, or capture-all `default on` with a `never` denylist.
4. **Measured, not eyeballed.** Retrieval changes ship only if they beat the eval baseline
   ([`EVAL-BASELINE.md`](EVAL-BASELINE.md)).

## Scope

Three agents are first-class — their transcripts are ingested and distilled: **Claude Code,
Codex and opencode**. That is the scope for now. Any other MCP client (Cursor, Windsurf, VS Code)
can still *read and write* the same brain through the server ([`ADAPTERS.md`](ADAPTERS.md)),
but transcript adapters for more agents are **not planned**.

---

## Shipped

### v0.6 → v1.0 — from vector search to long-term memory (July 2026)

| Version | What it added |
|---|---|
| v0.6 | The instrument: 123-case labeled eval (Recall@k, MRR, nDCG, latency) + results wrapped as historical evidence (prompt-injection guard) |
| v0.7 | Hybrid retrieval: FTS5/BM25 + semantic, fused with RRF; schema migrations (`user_version`) |
| v0.8 | Layer 2: one `memories` table with 16 types, provenance to transcript lines, write-time dedup/supersede, `save_memories`, session-end extraction, `distill --project` backfill |
| v0.9 | `get_context` briefing, conflict detection, SessionStart injection (`context --hook`), TODO lifecycle |
| v1.0 | Opt-in cross-encoder reranker (gate passed: R@1 +17 pp), heuristic entity graph + `explore_entity`, Codex extraction parity, any-MCP-client docs |

### 1.x — teams and a third agent

| Version | Date | What it added |
|---|---|---|
| 1.1.0 | 2026-07-12 | **Brain Teams client**: `cloud login / sync / status`, `private` flag, `layer: 'team'` search |
| 1.2.0 | 2026-07-13 | Opt-out capture mode (`default on` + `never`), auto team-sync on distill |
| 1.3.0 | 2026-09-21 | `brain-rag onboard`: pick projects, see the token cost, import + distill + sync existing history |
| 1.4.0 | 2026-09-21 | `brain-rag consolidate`: judge for post-distillation near-duplicates (merge / supersede / close TODOs — nothing deleted) |
| 1.4.1 | 2026-09-21 | Worktree sessions named after the main repo |
| 1.5.0 | 2026-09-22 | Memories written for a reader (one claim each, conclusion first) + generated prompts that refresh themselves |
| 1.5.1 | 2026-09-22 | `brain-rag retitle` |
| 1.6.0 | 2026-11-06 | **opencode** support: MCP server, commands, ingest |
| 1.7.0 | 2026-11-06 | opencode runs on its own: plugin that keeps, ingests and distills (with opencode's own model) |
| 1.7.1–1.7.2 | 2026-11-06 | opencode on Windows (no console windows); README and reference brought up to date |
| 1.7.3 | 2026-11-10 | Ingest matches kept sessions by session id: a transcript that changed folder (worktree → main repo) is indexed again and `keep.list` heals itself |

---

## Next

Nothing below is scheduled; it is the honest list of what is known to be missing.

### Bugs and loose ends (open issues)

- [ ] [#33](https://github.com/dasportillo/brain-rag/issues/33) — auto-sync's 4 s timeout loses
      the first save after inactivity against a paused Aurora (~15 s to wake).
- [ ] [#29](https://github.com/dasportillo/brain-rag/issues/29) — headless extraction behind a
      proxy (LiteLLM): warn when `ANTHROPIC_BASE_URL` is set and the model alias may fall through.
- [ ] [#35](https://github.com/dasportillo/brain-rag/issues/35) — the rewrite is **parked** on
      three data-destroying failures in the split path; it does not resume until those are fixed.

### Measurement debt (carried over from v0.6–v0.9)

- [ ] Re-run the eval on today's corpus — the published baseline dates from 2026-07-11
      (560 sessions); every number since then is unmeasured.
- [ ] Exclude eval sessions from the corpus, so the brain doesn't index its own eval runs.
- [ ] Memory-targeted eval cases: "what did we decide about X?" must hit the decision memory at
      rank 1, not a raw chunk.
- [ ] `get_context` eval: faithfulness (LLM-judge — is every claim backed by a cited source?) and
      freshness (does it prefer the current decision over the reverted one?).

### Unfinished design

- [ ] Full temporal status vocabulary end-to-end (`active, superseded, deprecated, experimental,
      obsolete`) with a rank boost for `active` in both layers — today only `active` /
      `superseded` are enforced.

### Cross-cutting (every change)

- **Secrets**: redaction at ingest; extraction prompts never place secrets in memories.
- **Migrations**: every schema change is a `user_version` migration; `brain-rag stats` reports it.
- **Performance budget**: search p95 < 300 ms, incremental ingest, startup injection < 1 s.
- **`node:sqlite` is experimental**: pin known-good Node versions in `engines`.
