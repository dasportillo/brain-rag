# Eval baseline

Scores only — the cases and corpus stay local (`eval-cases.local.json` is gitignored).
Update this table in every retrieval-touching PR (`node eval.mjs 8 --json`).

| Date | Version | Cases | Corpus (sessions / chunks) | R@1 | R@5 | R@8 | MRR | nDCG@8 | search p50/p95 | ctx p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-07-10 | 0.5.0 + v0.6 instrument | 10 | 470 / 18,701 | 0.70 | 0.90 | 0.90 | 0.758 | 0.793 | 258 / 307 ms | 8.5 kB |
| 2026-07-11 | 0.5.0 + 30 cases, Codex corpus | 30 | 560 / 30,792 | 0.77 | 0.93 | 0.97 | 0.819 | 0.854 | 435 / 527 ms | 8.4 kB |
| 2026-07-11 | 0.7.0 hybrid: FTS5/BM25 + RRF | 30 | 560 / 30,792 | 0.73 | 0.97 | 0.97 | 0.828 | 0.863 | 91 / 102 ms | 6.9 kB |
| 2026-07-11 | 0.8.1 + 123-case eval | 123 | 560 / 30,802 | 0.59 | 0.79 | 0.85 | 0.674 | 0.715 | 90 / 105 ms | 6.2 kB |

Notes on the 0.8.1 row (case set 30 → 123):

- **Case set expanded 30 → 123**, mined from actual chunk text (not titles) across **44 of 46
  projects**, all five kinds (solution 37 / exact-term 33 / decision 25 / state 17 / entity 11),
  ES 75 / EN 48. Every `expectAny` pattern was verified to match ≥1 in-project chunk before
  inclusion (dead or out-of-project patterns rejected). **38 cases target content that exists
  only in imported Codex rollouts** — cross-host recall is now a first-class slice.
- **Scores dropped vs the 30-case row** (R@8 0.97 → 0.85, MRR 0.828 → 0.674). This is the case
  set getting harder and more representative — single-session long-tail projects, cross-lingual
  EN-query→ES-content cases, exact long-tail identifiers — not a retrieval regression: latency
  is unchanged (p50 90 ms) and the original 30 cases behave as before.
- **Ablation** (`node eval.mjs 8 --semantic`, vector-only): R@8 0.60, MRR 0.406 — the lexical
  leg is worth **~25 pp of R@8** here (was ~10 pp at 30 cases) because the new cases lean on
  exact identifiers where BM25 dominates. Vector-only is NOT a viable fallback on this corpus.
- Misses concentrate in `state` (13/17) and `entity` (8/11) and in EN queries over ES content
  (en 38/48 vs es 66/75) — the reranker work should be gated on exactly these slices.
- The long-standing stacked-PR miss was re-diagnosed: patterns tightened (fixed that case only;
  "gh pr merge" was false-hit-prone, "tip branch" matched nothing corpus-wide) but it remains a
  **genuine ranking gap** — the true chunk (Spanish, short) never appears even at K=50 in either
  mode: a cross-lingual query with zero lexical overlap in a flat-similarity neighborhood crowded
  by hundreds of generic PR/merge chunks. Rescue needs a cross-lingual reranker or query-side ES
  expansion — exactly what the v1.0 reranker gate is for; threshold tweaks won't fix it.

Notes on the 0.7.0 row (hybrid retrieval rework):

- The lexical leg moved from a JS substring scan (which lowercased every chunk text on every
  query) to **FTS5/BM25** (unicode61, diacritics-normalized), and the vector scan stopped
  loading chunk texts (fetched only for the final pool, with an in-memory candidate cache
  guarded by `data_version` + rowcount). Net: **p50 435 ms → 91 ms** with equal-or-better
  recall (R@5 0.93 → 0.97, MRR 0.819 → 0.828).
- **Ablation** (`node eval.mjs 8 --semantic`, vector-only): R@8 0.87, MRR 0.714 — the lexical
  leg is worth ~10 pp of R@8 on this case set.
- The previous miss (502 upload) is now a hit; the remaining miss is the stacked-PR case.
- Schema migrations introduced (`PRAGMA user_version`, v1 = FTS index + sync triggers).

Notes on the 2026-07-11 row (30 cases, post-Codex-backfill):

- Case set expanded 10 → 30: mined from session titles, mixed ES (17) / EN (13), all four kinds,
  10 projects, every case verified to have in-project pattern matches before inclusion. One case
  targets content that only exists via imported Codex rollouts (cross-host recall) — it hits.
- All 17 Spanish cases hit @8; the single miss is an English `solution` case (the 502 upload).
- **Latency regression: p50 435 ms / p95 527 ms** (was 258/307) after the corpus grew 60%
  (18.7k → 30.8k chunks, Codex backfill). Brute-force cosine scales linearly — the v0.7 hybrid
  work is now also a performance fix, not just a recall one.

Notes on the 2026-07-10 baseline:

- **Search p50 is already ~260 ms** against the 300 ms budget — brute-force cosine over 18.7k
  chunks. v0.7 (FTS5/BM25 + RRF) must watch this; the lexical leg is cheap but the fusion adds work.
- Per-`kind`/`lang` slices are empty: the local cases predate the metadata schema. The v0.6 case
  expansion (10 → 100+) should tag every case with `{kind, lang, project?}` so misses can be
  sliced by class.
- The self-echo guard (chunks containing the literal query are ignored) is active from this
  baseline on, so scores are not inflated by indexed eval sessions.
