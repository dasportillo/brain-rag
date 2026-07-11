// LOCAL cross-encoder reranker (docs/ROADMAP.md v1.0) — second-pass rescoring of the hybrid
// top candidates. Slower but sharper than RRF alone; its reason to exist is the measured weak
// slices of the eval: cross-lingual queries (EN query over ES content) and near-tie pools where
// the bi-encoder + BM25 can't separate the true hit from generic neighbors.
//
// Everything is LAZY: importing this module costs nothing (quiet.mjs + pure blend only);
// @huggingface/transformers and the model load on the FIRST rerank call and are cached for
// the process lifetime — a server that never gets rerank:true never pays for the model.
//
// Default model: jinaai/jina-reranker-v2-base-multilingual (ONNX, q8). Chosen because it is
// (a) genuinely multilingual (EN↔ES verified: a relevant ES passage for an EN query scores
// +0.98 vs -3.5/-3.7 for ES/EN distractors) and (b) shipped as ONNX on the hub. The candidates
// Xenova/bge-reranker-base (zh/en only) and mixedbread-ai/mxbai-rerank-xsmall-v1 (EN-trained)
// don't cover the cross-lingual gate; BAAI/bge-reranker-v2-m3 has no ONNX export. Quirk: jina's
// config.json carries no model_type (custom remote-code arch), so we patch in 'xlm-roberta'
// (the underlying architecture) before transformers.js resolves the class. Swap via
// BRAIN_RERANK_MODEL (any single-logit sequence-classification reranker with ONNX weights).
import './quiet.mjs'; // must run before anything that might touch node:sqlite downstream
import { blendScores } from './rerank-blend.mjs';

export { blendScores };

export const RERANK_MODEL = process.env.BRAIN_RERANK_MODEL || 'jinaai/jina-reranker-v2-base-multilingual';

const MAX_TOKENS = 256; // per-pair token cap: 512 costs ~3.4s / 30 pairs on CPU, 256 stays ~1s
const CLIP_CHARS = 1200; // pre-tokenizer clip — 256 tokens ≈ ≤1000 chars, so nothing scored is lost
const BATCH = 10; // scored in length-sorted sub-batches so short pairs don't pad to the longest

let rerankerP = null;
function getReranker() {
  if (!rerankerP) {
    rerankerP = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification, AutoConfig, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = true; // allow downloading the model on the first run
      const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
      const config = await AutoConfig.from_pretrained(RERANK_MODEL);
      if (!config.model_type) config.model_type = 'xlm-roberta'; // see module comment (jina quirk)
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8', config });
      return { tokenizer, model };
    })();
  }
  return rerankerP;
}

// Raw cross-encoder logit for each (query, text) pair, returned in input order.
// Length-sorted sub-batches: within a batch every pair pads to the longest member, so mixing a
// 100-token chunk with a 256-token one wastes 2.5x compute — sorting first keeps batches tight.
async function scorePairs(query, texts) {
  const { tokenizer, model } = await getReranker();
  const clipped = texts.map(t => String(t).slice(0, CLIP_CHARS));
  const order = clipped.map((_, i) => i).sort((a, b) => clipped[a].length - clipped[b].length);
  const out = new Array(clipped.length);
  for (let i = 0; i < order.length; i += BATCH) {
    const idx = order.slice(i, i + BATCH);
    const enc = tokenizer(new Array(idx.length).fill(query),
      { text_pair: idx.map(j => clipped[j]), padding: true, truncation: true, max_length: MAX_TOKENS });
    const { logits } = await model(enc);
    const rows = logits.tolist();
    // single-logit head (num_labels=1) is the standard reranker shape; for a 2-class head the
    // positive class is last by convention — either way the LAST value is the relevance logit.
    idx.forEach((j, r) => { out[j] = Array.isArray(rows[r]) ? rows[r][rows[r].length - 1] : rows[r]; });
  }
  return out;
}

// Rescores `results` (objects with .text, ordered best-first by the caller's ranking) against
// `query` and returns NEW objects reordered by the blended score: cross-encoder confidence
// blended with the incoming rank (see rerank-blend.mjs — the CE can rescue a buried hit but
// not fully scramble a confident ordering). `.score` becomes the blended value (kept for
// display); the raw logit is exposed as `.ceScore` for debugging/eval.
export async function rerankResults(query, results, { topK = results.length } = {}) {
  if (results.length < 2) return results.slice(0, topK);
  const ce = await scorePairs(query, results.map(r => r.text));
  const blended = blendScores(ce, results.map((_, i) => i));
  return results
    .map((r, i) => ({ ...r, score: blended[i], ceScore: ce[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
