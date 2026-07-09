// Embeddings LOCALES (transformers.js). El modelo se descarga una vez y queda cacheado.
// Nada sale de la máquina -> privado, gratis, offline. Vector normalizado de 384 dims.
//
// Modelo de RETRIEVAL multilingüe: multilingual-e5-small (384 dims, drop-in). e5 es un modelo
// entrenado para retrieval (no paráfrasis) y requiere prefijos asimétricos "query: " / "passage: "
// para que la consulta y el documento caigan en el mismo espacio — por eso embed() toma `kind`.
// Cambiá con BRAIN_MODEL.
import { pipeline, env } from '@huggingface/transformers';

export const DIM = 384;
const MODEL = process.env.BRAIN_MODEL || 'Xenova/multilingual-e5-small';
const isE5 = /e5/i.test(MODEL);

function withPrefix(texts, kind) {
  if (!isE5) return texts;
  const p = kind === 'query' ? 'query: ' : 'passage: ';
  return texts.map(t => p + t);
}

env.allowRemoteModels = true; // permitir bajar el modelo la primera vez

let extractorP = null;
function getExtractor() {
  if (!extractorP) extractorP = pipeline('feature-extraction', MODEL);
  return extractorP;
}

// Embebe un array de textos en batches; devuelve array de arrays (Float32 normalizados).
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
