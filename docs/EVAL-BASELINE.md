# Eval baseline

Scores only — the cases and corpus stay local (`eval-cases.local.json` is gitignored).
Update this table in every retrieval-touching PR (`node eval.mjs 8 --json`).

| Date | Version | Cases | Corpus (sessions / chunks) | R@1 | R@5 | R@8 | MRR | nDCG@8 | search p50/p95 | ctx p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-07-10 | 0.5.0 + v0.6 instrument | 10 | 470 / 18,701 | 0.70 | 0.90 | 0.90 | 0.758 | 0.793 | 258 / 307 ms | 8.5 kB |

Notes on the 2026-07-10 baseline:

- **Search p50 is already ~260 ms** against the 300 ms budget — brute-force cosine over 18.7k
  chunks. v0.7 (FTS5/BM25 + RRF) must watch this; the lexical leg is cheap but the fusion adds work.
- Per-`kind`/`lang` slices are empty: the local cases predate the metadata schema. The v0.6 case
  expansion (10 → 100+) should tag every case with `{kind, lang, project?}` so misses can be
  sliced by class.
- The self-echo guard (chunks containing the literal query are ignored) is active from this
  baseline on, so scores are not inflated by indexed eval sessions.
