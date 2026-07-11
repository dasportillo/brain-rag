// Recall eval: runs a labeled set of "known-item" queries and measures whether the correct
// content shows up in the top-K results. A query is a HIT if any top-K chunk matches one of the
// case's `expectAny` regexes. Chunks containing the literal query are skipped (self-echo guard:
// an indexed eval session must not grade itself).
//
// Reports Recall@{1,5,K}, MRR, nDCG@K, search latency p50/p95, context bytes, and hit/total
// slices by case `kind` / `lang` / `project` when the cases carry that metadata.
//
//   node eval.mjs            # human output, K=8
//   node eval.mjs 5          # override primary K
//   node eval.mjs --json     # machine-readable metrics only (for docs/EVAL-BASELINE.md)
//   node eval.mjs --rerank   # cross-encoder second pass (rerank:true) — the v1.0 gate leg
import { readFileSync, existsSync } from 'node:fs';
import { openDb, searchChunks, stats } from './store.mjs';
import { embed } from './embed.mjs';
import { firstHitRank, recallAtK, mrr, ndcgAtK, percentile, sliceBy } from './eval-metrics.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const MODE = args.includes('--semantic') ? 'semantic' : 'hybrid'; // --semantic = vector-only A/B leg
const RERANK = args.includes('--rerank');
const K = Number(args.find(a => /^\d+$/.test(a)) || 8);
const KS = [...new Set([1, 5, K])].sort((a, b) => a - b);

// Prefer eval-cases.local.json (gitignored, real cases for your corpus) over the shipped example.
const localUrl = new URL('./eval-cases.local.json', import.meta.url);
const casesUrl = existsSync(localUrl) ? localUrl : new URL('./eval-cases.json', import.meta.url);
const cases = JSON.parse(readFileSync(casesUrl, 'utf8'));
const db = openDb();

const tEmbed = Date.now();
const qvecs = await embed(cases.map(c => c.query), { kind: 'query' });
const embedMsPerQuery = Math.round((Date.now() - tEmbed) / cases.length);

const ranks = [], latencies = [], ctxBytes = [];
if (!JSON_OUT) console.log(`\nRecall eval — K=${K}, ${cases.length} known-item queries${RERANK ? ' — RERANK on' : ''}\n`);

// Rerank warmup: the FIRST rerank call downloads/loads the cross-encoder (seconds). One
// untimed query up front means the latencies below reflect steady-state per-query cost —
// the honest number for a long-lived server, not the one-off model load.
if (RERANK) await searchChunks(db, qvecs[0], { k: K, project: cases[0].project ?? null, queryText: cases[0].query, mode: MODE, rerank: true });

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const t0 = Date.now();
  const res = await searchChunks(db, qvecs[i], { k: K, project: c.project ?? null, queryText: c.query, mode: MODE, rerank: RERANK });
  latencies.push(Date.now() - t0);
  // context size = what the server would actually inject for this query (post-clip)
  ctxBytes.push(res.reduce((s, r) => s + Math.min(r.text.length, r.role === 'summary' ? 2000 : 1200), 0));

  const patterns = c.expectAny.map(p => new RegExp(p, 'i'));
  const rank = firstHitRank(res, patterns, c.query);
  ranks.push(rank);

  if (JSON_OUT) continue;
  const tag = rank ? `✔ hit@${rank}` : '✗ MISS ';
  const top = res[0];
  const where = top ? `${top.project} · ${top.ts?.slice(0, 10) ?? '?'}` : '—';
  console.log(`${tag}  ${c.query}${c.kind ? `   [${c.kind}]` : ''}`);
  console.log(`        top: [${top ? top.score.toFixed(3) : '—'}] ${where}`);
  console.log(`        ${(top?.text ?? '').replace(/\s+/g, ' ').slice(0, 140)}\n`);
}

const metrics = {
  casesFile: casesUrl.pathname.split('/').pop(),
  cases: cases.length,
  k: K,
  // rerank fields only when the leg is on, so the baseline --json output is unchanged.
  // Latency note: searchLatencyMs then INCLUDES the per-query cross-encoder pass; the one-off
  // model load was excluded via the warmup query above.
  ...(RERANK ? { rerank: true, rerankModel: (await import('./rerank.mjs')).RERANK_MODEL } : {}),
  corpus: stats(db),
  recall: Object.fromEntries(KS.map(k => [`@${k}`, +(recallAtK(ranks, k)).toFixed(3)])),
  mrr: +mrr(ranks).toFixed(3),
  [`ndcg@${K}`]: +ndcgAtK(ranks, K).toFixed(3),
  searchLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  embedMsPerQuery,
  ctxBytesP50: percentile(ctxBytes, 50),
  byKind: sliceBy(cases, ranks, 'kind', K),
  byLang: sliceBy(cases, ranks, 'lang', K),
  byProject: sliceBy(cases, ranks, 'project', K),
};

if (JSON_OUT) {
  console.log(JSON.stringify(metrics, null, 2));
} else {
  const slice = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.hits}/${v.total}`).join(' · ');
  console.log('─'.repeat(60));
  console.log(KS.map(k => `Recall@${k}: ${(recallAtK(ranks, k) * 100).toFixed(0)}%`).join('   '));
  console.log(`MRR: ${metrics.mrr}   nDCG@${K}: ${metrics[`ndcg@${K}`]}`);
  console.log(`search: p50 ${metrics.searchLatencyMs.p50}ms · p95 ${metrics.searchLatencyMs.p95}ms   embed: ~${embedMsPerQuery}ms/query   context: ~${(metrics.ctxBytesP50 / 1000).toFixed(1)}kB/query`);
  console.log(`by kind: ${slice(metrics.byKind)}`);
  console.log(`by lang: ${slice(metrics.byLang)}`);
}
