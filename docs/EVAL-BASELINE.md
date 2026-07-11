# Eval baseline

Scores only — the cases and corpus stay local (`eval-cases.local.json` is gitignored).
Update this table in every retrieval-touching PR (`node eval.mjs 8 --json`).

| Date | Version | Cases | Corpus (sessions / chunks) | R@1 | R@5 | R@8 | MRR | nDCG@8 | search p50/p95 | ctx p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-07-10 | 0.5.0 + v0.6 instrument | 10 | 470 / 18,701 | 0.70 | 0.90 | 0.90 | 0.758 | 0.793 | 258 / 307 ms | 8.5 kB |
| 2026-07-11 | 0.5.0 + 30 cases, Codex corpus | 30 | 560 / 30,792 | 0.77 | 0.93 | 0.97 | 0.819 | 0.854 | 435 / 527 ms | 8.4 kB |
| 2026-07-11 | 0.7.0 hybrid: FTS5/BM25 + RRF | 30 | 560 / 30,792 | 0.73 | 0.97 | 0.97 | 0.828 | 0.863 | 91 / 102 ms | 6.9 kB |

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
