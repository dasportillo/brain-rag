// Consolidation eval (issue #26): measures the two halves of `brain-rag consolidate` against a
// LABELED set built from a real corpus, so threshold and prompt changes are gated by numbers.
//
//   1. CLUSTERER — for every labeled pair {a, b, label: "dup" | "distinct"}, does clusterMemories
//      put a and b in the same cluster? Reports precision / recall / F1 of "proposed as a pair"
//      at the configured --sim/--lex, plus a sweep over a small grid. Model-free, instant.
//   2. JUDGE (--judge, COSTS TOKENS) — for every labeled cluster {members, expect}, run the real
//      judge and compare the verdict class. Reports accuracy, the confusion list, and the one
//      number that must stay at ZERO: verdicts that retire a memory whose labeled partner says
//      "distinct" (knowledge loss).
//
//   node eval-consolidate.mjs                     # clusterer only
//   node eval-consolidate.mjs --judge [--model M] # + judge (one claude -p per labeled cluster)
//   node eval-consolidate.mjs --sim 0.85 --lex 0.15
//   node eval-consolidate.mjs --json              # machine-readable (for docs/EVAL-BASELINE.md)
//
// Labels live in eval-consolidate.local.json (gitignored — they quote your memories):
//   { "project": "<name>", "note": "...",
//     "pairs":    [ { "a": <id>, "b": <id>, "label": "dup" | "distinct" }, ... ],
//     "clusters": [ { "members": [<ids>], "expect": "keep" | "supersede" | "merge" | "close_todo" | [<several acceptable>] }, ... ] }
// See eval-consolidate.example.json for the shape.
import { readFileSync, existsSync } from 'node:fs';
import { openDb, blobToVec } from './store.mjs';
import { clusterMemories, clusterKey, buildJudgeInput, judgePrompt, parseVerdict, DEFAULT_SIM, DEFAULT_LEX } from './consolidate.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
const JSON_OUT = has('--json');
const JUDGE = has('--judge');
const MODEL = val('--model', 'sonnet');
const SIM = Number(val('--sim', DEFAULT_SIM)), LEX = Number(val('--lex', DEFAULT_LEX));

const labelsUrl = new URL('./eval-consolidate.local.json', import.meta.url);
if (!existsSync(labelsUrl)) {
  console.error('eval-consolidate: eval-consolidate.local.json not found — label a real corpus first (shape in eval-consolidate.example.json).');
  process.exit(1);
}
const labels = JSON.parse(readFileSync(labelsUrl, 'utf8'));
const db = openDb();

// Every memory the labels mention, regardless of status (the eval DB may already be consolidated).
const ids = [...new Set([...labels.pairs.flatMap(p => [p.a, p.b]), ...(labels.clusters ?? []).flatMap(c => c.members)])];
const rows = db.prepare(`SELECT id, type, project, title, content, confidence, status, supersedes, source_session, source_messages, sources,
    entities, embedding, created_at, updated_at FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  .map(r => ({ ...r, embedding: r.embedding ? blobToVec(r.embedding) : null }));
const byId = new Map(rows.map(r => [r.id, r]));
const missing = ids.filter(id => !byId.has(id));
if (missing.length) { console.error(`eval-consolidate: labeled ids not in this DB: ${missing.join(', ')}`); process.exit(1); }

// --- 1. clusterer -------------------------------------------------------------------------------
function pairMetrics(sim, lex) {
  // Cluster the labeled memories as one project-sized pool (the labels are the universe).
  const clusters = clusterMemories(rows, { sim, lex, maxSize: 1000 });
  const same = new Map();
  clusters.forEach((c, i) => c.members.forEach(m => same.set(m.id, i)));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of labels.pairs) {
    const proposed = same.has(p.a) && same.get(p.a) === same.get(p.b);
    if (p.label === 'dup') proposed ? tp++ : fn++;
    else proposed ? fp++ : tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { sim, lex, tp, fp, fn, tn, precision, recall, f1 };
}
const main = pairMetrics(SIM, LEX);
const sweep = [];
for (const sim of [0.80, 0.85, 0.90]) for (const lex of [0, 0.10, 0.15, 0.25]) sweep.push(pairMetrics(sim, lex));

// --- 2. judge (optional) ------------------------------------------------------------------------
const distinctPairs = new Set(labels.pairs.filter(p => p.label === 'distinct').map(p => clusterKey([p.a, p.b])));
let judge = null;
if (JUDGE && labels.clusters?.length) {
  const { runClaude } = await import('./distill.mjs');
  judge = { total: labels.clusters.length, correct: 0, unusable: 0, knowledge_loss: 0, merged_distinct: 0, rows: [] };
  for (const lc of labels.clusters) {
    const cluster = { key: clusterKey(lc.members), members: lc.members.map(id => byId.get(id)) };
    let got = null, text = '';
    try {
      const out = await runClaude(judgePrompt(buildJudgeInput(cluster)), { model: MODEL });
      text = out;
      try { const o = JSON.parse(out); if (typeof o.result === 'string') text = o.result; } catch { /* raw */ }
      got = parseVerdict(text, cluster);
    } catch (e) { text = `ERROR ${e.message}`; }
    const verdict = got?.verdict ?? 'unusable';
    const expect = Array.isArray(lc.expect) ? lc.expect : [lc.expect]; // several verdicts can be right (supersede vs merge)
    if (!got) judge.unusable++;
    if (expect.includes(verdict)) judge.correct++;
    // knowledge loss: retiring a memory that a labeled-distinct partner in this cluster kept
    // (supersede / close_todo). A merge retires EVERY member, so it is scored separately: each
    // labeled-distinct pair folded into one merged memory is a merged_distinct warning.
    let loss = 0, mergedDistinct = 0;
    if (got?.retire?.length) {
      const survivors = cluster.members.map(m => m.id).filter(id => !got.retire.includes(id));
      for (const r of got.retire) for (const s of survivors) if (distinctPairs.has(clusterKey([r, s]))) loss++;
      if (got.verdict === 'merge') {
        for (let i = 0; i < got.retire.length; i++) for (let j = i + 1; j < got.retire.length; j++)
          if (distinctPairs.has(clusterKey([got.retire[i], got.retire[j]]))) mergedDistinct++;
      }
    }
    judge.knowledge_loss += loss;
    judge.merged_distinct += mergedDistinct;
    judge.rows.push({ members: lc.members, expect: expect.join('|'), got: verdict, ok: expect.includes(verdict), loss, mergedDistinct, reason: got?.reason ?? text.slice(0, 120) });
  }
  judge.accuracy = judge.correct / judge.total;
}

// --- report --------------------------------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ project: labels.project, pairs: labels.pairs.length, clusterer: main, sweep, judge: judge && { ...judge, rows: undefined } }, null, 2));
} else {
  const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';
  console.log(`\nConsolidation eval — project ${labels.project} · ${labels.pairs.length} labeled pairs (${labels.pairs.filter(p => p.label === 'dup').length} dup / ${labels.pairs.filter(p => p.label === 'distinct').length} distinct)\n`);
  console.log(`Clusterer @ sim ${SIM} lex ${LEX}: precision ${pct(main.precision)} · recall ${pct(main.recall)} · F1 ${pct(main.f1)}   (tp ${main.tp} fp ${main.fp} fn ${main.fn} tn ${main.tn})\n`);
  console.log('  sim   lex    prec  recall  F1     fp  fn');
  for (const s of sweep) console.log(`  ${s.sim.toFixed(2)}  ${s.lex.toFixed(2)}   ${pct(s.precision)}  ${pct(s.recall)}   ${pct(s.f1)}   ${String(s.fp).padStart(2)}  ${String(s.fn).padStart(2)}${s.sim === SIM && s.lex === LEX ? '   ← current' : ''}`);
  if (judge) {
    console.log(`\nJudge (${MODEL}) on ${judge.total} labeled clusters: accuracy ${pct(judge.accuracy)} · unusable ${judge.unusable} · knowledge-loss retirements ${judge.knowledge_loss} (must be 0) · distinct pairs merged ${judge.merged_distinct} (must be 0)\n`);
    for (const r of judge.rows) console.log(`  ${r.ok ? '✔' : '✗'} [${r.members.join(',')}] expect ${r.expect} → got ${r.got}${r.loss ? ` ⚠ loss ${r.loss}` : ''}${r.mergedDistinct ? ` ⚠ merged-distinct ${r.mergedDistinct}` : ''} — ${String(r.reason).replace(/\s+/g, ' ').slice(0, 110)}`);
  } else if (JUDGE) {
    console.log('\n(no labeled clusters — add "clusters" to the labels file to eval the judge)');
  }
}
