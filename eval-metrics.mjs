// Pure metric helpers for the eval harness — separate module so they are unit-testable
// without loading the embedding model or a corpus. All ranks are 1-based; 0 = miss.

// Rank of the first result matching any expected pattern. Results that contain the
// literal query text are skipped entirely (they don't count as hits NOR occupy a rank):
// they are the eval's own echo — an indexed session where the eval was run/discussed —
// not evidence of recall.
export function firstHitRank(results, patterns, queryText = null) {
  let rank = 0;
  for (const r of results) {
    if (queryText && r.text.includes(queryText)) continue; // self-echo: pretend it wasn't returned
    rank++;
    if (patterns.some(re => re.test(r.text))) return rank;
  }
  return 0;
}

export function recallAtK(ranks, k) {
  if (!ranks.length) return 0;
  return ranks.filter(r => r > 0 && r <= k).length / ranks.length;
}

export function mrr(ranks) {
  if (!ranks.length) return 0;
  return ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length;
}

// Known-item nDCG: one relevant document per query, so IDCG = 1 and
// per-query DCG = 1/log2(rank+1) when the item lands within K.
export function ndcgAtK(ranks, k) {
  if (!ranks.length) return 0;
  return ranks.reduce((s, r) => s + (r > 0 && r <= k ? 1 / Math.log2(r + 1) : 0), 0) / ranks.length;
}

// Nearest-rank percentile (p in [0,100]) — good enough at eval-suite sizes.
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// hit/total per value of a case field (kind, lang, project…) so misses can be
// sliced by class instead of just counted. Cases without the field group under '—'.
export function sliceBy(cases, ranks, field, k) {
  const groups = new Map();
  cases.forEach((c, i) => {
    const key = c[field] ?? '—';
    const g = groups.get(key) ?? { hits: 0, total: 0 };
    g.total++;
    if (ranks[i] > 0 && ranks[i] <= k) g.hits++;
    groups.set(key, g);
  });
  return Object.fromEntries([...groups.entries()].sort((a, b) => b[1].total - a[1].total));
}
