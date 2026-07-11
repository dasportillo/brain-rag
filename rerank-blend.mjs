// Pure blend logic for the cross-encoder reranker — kept separate from rerank.mjs so it is
// unit-testable without pulling in @huggingface/transformers (the test suite stays model-free).
//
// blendScores(ceScores, ranks) -> blended score per candidate, in input order.
//
// - CE leg: sigmoid(logit) ∈ (0,1). Sigmoid (not pool min-max) on purpose: min-max amplifies
//   noise when the pool's CE scores are near-ties (a 0.01-logit spread would stretch to the
//   full [0,1] range), while sigmoid preserves the model's absolute confidence — a pool where
//   nothing is relevant stays uniformly low instead of being force-ranked.
// - Rank leg: RRF-style prior 60/(60+rank) ∈ (0,1] over the INCOMING hybrid (RRF) order —
//   rank 0 → 1.0, rank 29 → ~0.67. Normalized to the CE's scale so that with the default
//   0.7/0.3 split the CE needs a clear confidence margin (~0.14 in sigmoid space) to overturn
//   a whole-pool rank gap: it can RESCUE a buried hit but cannot fully scramble a confident
//   hybrid ordering, and near-tie CE scores leave the hybrid order essentially intact.
export const RRF_K = 60;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function blendScores(ceScores, ranks, { wCe = 0.7, wRank = 0.3 } = {}) {
  const n = Math.min(ceScores.length, ranks.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = wCe * sigmoid(ceScores[i]) + wRank * (RRF_K / (RRF_K + ranks[i]));
  }
  return out;
}
