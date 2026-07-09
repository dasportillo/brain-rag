// Embeddings LOCALES (transformers.js). El modelo se descarga una vez y queda cacheado.
// Nada sale de la máquina -> privado, gratis, offline. Vector normalizado de 384 dims.
import { pipeline, env } from '@huggingface/transformers';

export const DIM = 384;
const MODEL = process.env.BRAIN_MODEL || 'Xenova/all-MiniLM-L6-v2';

env.allowRemoteModels = true; // permitir bajar el modelo la primera vez

let extractorP = null;
function getExtractor() {
  if (!extractorP) extractorP = pipeline('feature-extraction', MODEL);
  return extractorP;
}

// Embebe un array de textos en batches; devuelve array de arrays (Float32 normalizados).
export async function embed(texts, { batch = 32 } = {}) {
  const ex = await getExtractor();
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const res = await ex(slice, { pooling: 'mean', normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

export async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}
