// Trustworthy recall eval with an LLM-as-judge (language/keyword agnostic).
//
// Two phases so the judge is decoupled from retrieval:
//   node eval-judge.mjs --emit                  -> retrieves top-K per query, writes eval-bundle.json
//   node eval-judge.mjs --score verdicts.json   -> computes Recall@K / MRR / P@K from judged relevance
//
// The judge (which of the K results are relevant) is produced by an LLM over eval-bundle.json and
// written to verdicts.json as { "<caseId>": [true,false,...]  }. Keeping it out-of-band means the
// judge can be Claude today or an API call later, without changing retrieval or metrics.
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb, searchChunks } from './store.mjs';

const K = Number(process.env.EVAL_K || 5);
const mode = process.argv[2];
const db = openDb();
const casesUrl = new URL('./eval-cases.json', import.meta.url);
const bundleUrl = new URL('./eval-bundle.json', import.meta.url);
const cases = JSON.parse(readFileSync(casesUrl, 'utf8'));

if (mode === '--emit') {
  const { embed } = await import('./embed.mjs');
  const qvecs = await embed(cases.map(c => c.query), { kind: 'query' });
  const bundle = cases.map((c, i) => ({
    id: i,
    query: c.query,
    results: searchChunks(db, qvecs[i], { k: K, project: c.project ?? null, queryText: c.query })
      .map((r, ri) => ({ rank: ri + 1, project: r.project, ts: r.ts?.slice(0, 10) ?? '?', score: +r.score.toFixed(3), text: r.text })),
  }));
  writeFileSync(bundleUrl, JSON.stringify(bundle, null, 2));
  console.log(`✔ emitted eval-bundle.json — ${bundle.length} queries × top-${K}`);
} else if (mode === '--score') {
  const bundle = JSON.parse(readFileSync(bundleUrl, 'utf8'));
  const verdicts = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  let hit = 0, rr = 0, precSum = 0;
  console.log(`\nLLM-judged eval — K=${K}, ${bundle.length} queries\n`);
  for (const b of bundle) {
    const v = (verdicts[b.id] ?? verdicts[String(b.id)] ?? []).slice(0, K);
    const firstRel = v.findIndex(Boolean) + 1; // 0 = none relevant
    const relCount = v.filter(Boolean).length;
    if (firstRel > 0) { hit++; rr += 1 / firstRel; }
    precSum += relCount / K;
    console.log(`${firstRel > 0 ? '✔ hit@' + firstRel : '✗ MISS  '}  (${relCount}/${K} relevant)  ${b.query}`);
  }
  const n = bundle.length;
  console.log('\n' + '─'.repeat(60));
  console.log(`Recall@${K}: ${(hit / n * 100).toFixed(0)}%  (${hit}/${n})`);
  console.log(`MRR:       ${(rr / n).toFixed(3)}`);
  console.log(`P@${K}:      ${(precSum / n).toFixed(2)}  (avg fraction of top-${K} that is relevant)`);
} else {
  console.error('usage: node eval-judge.mjs --emit | --score <verdicts.json>');
  process.exit(1);
}
