// Recall eval: runs a labeled set of "known-item" queries and measures whether the correct
// content shows up in the top-K results. A query is a HIT if any top-K chunk matches one of the
// case's `expectAny` regexes. Reports Recall@K and MRR (mean reciprocal rank).
//
//   node eval.mjs          # K=5
//   node eval.mjs 8        # K=8
import { readFileSync } from 'node:fs';
import { openDb, searchChunks } from './store.mjs';
import { embed } from './embed.mjs';

const K = Number(process.argv[2] || 5);
const cases = JSON.parse(readFileSync(new URL('./eval-cases.json', import.meta.url), 'utf8'));
const db = openDb();

const qvecs = await embed(cases.map(c => c.query));

let hits = 0, rrSum = 0;
console.log(`\nRecall eval — K=${K}, ${cases.length} known-item queries\n`);

cases.forEach((c, i) => {
  const res = searchChunks(db, qvecs[i], { k: K, project: c.project ?? null });
  const patterns = c.expectAny.map(p => new RegExp(p, 'i'));
  let rank = 0;
  for (let r = 0; r < res.length; r++) {
    if (patterns.some(re => re.test(res[r].text))) { rank = r + 1; break; }
  }
  if (rank) { hits++; rrSum += 1 / rank; }

  const tag = rank ? `✔ hit@${rank}` : '✗ MISS ';
  const top = res[0];
  const where = top ? `${top.project} · ${top.ts?.slice(0, 10) ?? '?'}` : '—';
  console.log(`${tag}  ${c.query}`);
  console.log(`        top: [${top ? top.score.toFixed(3) : '—'}] ${where}`);
  console.log(`        ${(top?.text ?? '').replace(/\s+/g, ' ').slice(0, 140)}\n`);
});

console.log('─'.repeat(60));
console.log(`Recall@${K}: ${(hits / cases.length * 100).toFixed(0)}%  (${hits}/${cases.length})`);
console.log(`MRR:       ${(rrSum / cases.length).toFixed(3)}`);
