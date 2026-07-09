// LOCAL embeddings (transformers.js). The model downloads once and is cached.
// Nothing leaves the machine -> private, free, offline. Normalized 384-dim vector.
//
// Multilingual RETRIEVAL model: multilingual-e5-small (384 dims, drop-in). e5 is a model
// trained for retrieval (not paraphrase) and needs asymmetric prefixes "query: " / "passage: "
// so the query and the document land in the same space — that's why embed() takes `kind`.
// Swap via BRAIN_MODEL.
import { pipeline, env } from '@huggingface/transformers';

export const DIM = 384;
const MODEL = process.env.BRAIN_MODEL || 'Xenova/multilingual-e5-small';
const isE5 = /e5/i.test(MODEL);

function withPrefix(texts, kind) {
  if (!isE5) return texts;
  const p = kind === 'query' ? 'query: ' : 'passage: ';
  return texts.map(t => p + t);
}

env.allowRemoteModels = true; // allow downloading the model on the first run

let extractorP = null;
function getExtractor() {
  if (!extractorP) extractorP = pipeline('feature-extraction', MODEL);
  return extractorP;
}

// Embeds an array of texts in batches; returns an array of arrays (normalized Float32).
export async function embed(texts, { batch = 32, kind = 'passage' } = {}) {
  const ex = await getExtractor();
  const input = withPrefix(texts, kind);
  const out = [];
  for (let i = 0; i < input.length; i += batch) {
    const slice = input.slice(i, i + batch);
    const res = await ex(slice, { pooling: 'mean', normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

export async function embedOne(text, kind = 'query') {
  const [v] = await embed([text], { kind });
  return v;
}
