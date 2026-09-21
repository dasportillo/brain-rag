// Unit tests for consolidation (issue #26): the candidate clusterer (two-signal, over-proposes
// by design), the defensive verdict parser, verdict application (nothing deleted, provenance
// inherited, ledger written), and the idempotent project loop. Temp DB, hand-made unit vectors,
// injected judge — no claude spawn, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-consolidate-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const {
  tokenSet, jaccard, clusterMemories, clusterKey, parseVerdict, buildJudgeInput, judgePrompt,
  unionSources, applyVerdict, consolidateProject, activeMemories, alreadyJudged, consolidatableProjects,
} = await import('../consolidate.mjs');
const { openDb, saveMemory, retireMemories, searchMemories } = await import('../store.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

// Unit vectors: `dir(angleDeg)` in a 2-D plane padded to 8 dims → cosine = cos(Δangle).
const dirv = (deg) => { const v = new Array(8).fill(0); v[0] = Math.cos(deg * Math.PI / 180); v[1] = Math.sin(deg * Math.PI / 180); return v; };
const mem = (id, type, title, content, deg, updated_at = '2026-09-01T00:00:00Z', extra = {}) =>
  ({ id, type, project: 'p', title, content, embedding: dirv(deg), updated_at, ...extra });

// ---------------------------------------------------------------------------
// lexical leg
// ---------------------------------------------------------------------------
test('tokenSet / jaccard: diacritics-insensitive, stopwords and short words dropped', () => {
  const a = tokenSet('La auditoría VCO se dispara por MONTOS_FIJOS');
  assert.ok(a.has('auditoria') && a.has('vco') && a.has('montos_fijos'));
  assert.ok(!a.has('la') && !a.has('se') && !a.has('por'));
  assert.equal(jaccard(a, tokenSet('auditoria vco montos_fijos dispara')), 1);
  assert.equal(jaccard(a, tokenSet('totally unrelated words here')), 0);
  assert.equal(jaccard(new Set(), a), 0);
});

// ---------------------------------------------------------------------------
// clusterMemories — both signals must agree; todos pair with any type
// ---------------------------------------------------------------------------
test('clusterMemories: cosine alone is NOT enough (e5 clusters high) — lexical overlap must agree', () => {
  const rows = [
    mem(1, 'decision', 'Idempotency keys in Postgres', 'keep idempotency keys in postgres not redis', 0),
    mem(2, 'decision', 'Idempotency keys stay in Postgres', 'idempotency keys postgres instead of redis eviction risk', 5),   // cos≈0.996, lexical overlap high → paired
    mem(3, 'decision', 'Ledger API migration order', 'migrate ledger endpoints before webhooks', 8),                            // cos≈0.99 but NO lexical overlap → not paired
    mem(4, 'decision', 'Idempotency keys in Postgres (old)', 'idempotency keys in redis for now', 60),                          // lexical yes, cos=0.5 → not paired
    mem(5, 'bug', 'Idempotency keys in Postgres', 'keep idempotency keys in postgres not redis', 1),                            // same text, DIFFERENT type → not comparable
  ];
  const clusters = clusterMemories(rows);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.map(m => m.id), [2, 1], 'newest first (same date → higher id first)');
  assert.equal(clusters[0].key, '1,2');
});

test('clusterMemories: a todo pairs with the non-todo memory that may have resolved it; big groups are sliced', () => {
  const rows = [
    mem(10, 'todo', 'Rotate staging credentials', 'rotate the staging credentials postponed', 0, '2026-08-01T00:00:00Z'),
    mem(11, 'solution', 'Staging credentials rotated', 'rotated the staging credentials via secrets manager', 3, '2026-09-01T00:00:00Z'),
    ...Array.from({ length: 8 }, (_, i) => mem(20 + i, 'fact', 'Retry policy for webhooks', `webhooks retry policy exponential backoff variant ${i}`, 90 + i * 0.5, `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`)),
  ];
  const clusters = clusterMemories(rows, { maxSize: 6 });
  const todo = clusters.find(c => c.members.some(m => m.id === 10));
  assert.deepEqual(todo.members.map(m => m.id), [11, 10]);
  const big = clusters.filter(c => c.members.some(m => m.type === 'fact'));
  assert.deepEqual(big.map(c => c.members.length).sort(), [2, 6], '8 facts → slices of 6 + 2');
  assert.equal(big.find(c => c.members.length === 6).members[0].id, 27, 'newest slice first');
});

test('clusterMemories: rows without embedding are ignored; sim/lex thresholds are tunable', () => {
  const rows = [mem(1, 'fact', 'A thing', 'alpha beta gamma', 0, undefined, { embedding: null }), mem(2, 'fact', 'A thing', 'alpha beta gamma', 0)];
  assert.equal(clusterMemories(rows).length, 0);
  const far = [mem(1, 'fact', 'A thing', 'alpha beta gamma', 0), mem(2, 'fact', 'A thing', 'alpha beta gamma', 40)]; // cos≈0.77
  assert.equal(clusterMemories(far).length, 0);
  assert.equal(clusterMemories(far, { sim: 0.7 }).length, 1);
  assert.equal(clusterKey([12, 3, 7]), '3,7,12');
});

// ---------------------------------------------------------------------------
// judge I/O
// ---------------------------------------------------------------------------
const cluster = { key: '1,2,3', members: [
  mem(3, 'todo', 'Fix retries', 'todo: add retry policy', 0, '2026-09-03T00:00:00Z'),
  mem(2, 'decision', 'Retry policy: exponential backoff', 'decided exponential backoff because bursts', 1, '2026-09-02T00:00:00Z'),
  mem(1, 'decision', 'Retry policy', 'use exponential backoff', 2, '2026-09-01T00:00:00Z'),
] };

test('buildJudgeInput / judgePrompt: every member in full, newest first, ids and dates visible', () => {
  const input = buildJudgeInput(cluster);
  assert.ok(input.indexOf('#3 [todo]') < input.indexOf('#2 [decision]') && input.indexOf('#2') < input.indexOf('#1 [decision]'));
  assert.match(input, /updated 2026-09-02/);
  assert.match(judgePrompt(input), /OUTPUT ONLY a JSON object/);
  assert.ok(judgePrompt(input).includes(input));
});

test('parseVerdict: accepts each verdict shape, rejects foreign ids, half-valid → null', () => {
  assert.deepEqual(parseVerdict('{"verdict":"keep","reason":"different"}', cluster), { verdict: 'keep', reason: 'different' });
  assert.deepEqual(parseVerdict('Sure! {"verdict":"supersede","keep_id":2,"retire":[1,2,99],"reason":"newer"}', cluster),
    { verdict: 'supersede', keep_id: 2, retire: [1], reason: 'newer' }, 'survivor and foreign ids dropped from retire');
  assert.equal(parseVerdict('{"verdict":"supersede","keep_id":42,"retire":[1]}', cluster), null, 'keep_id outside the cluster');
  assert.equal(parseVerdict('{"verdict":"supersede","keep_id":2,"retire":[2]}', cluster), null, 'nothing left to retire');

  const merge = parseVerdict('```json\n{"verdict":"merge","merged":{"type":"decision","title":"Retry policy","content":"Exponential backoff because bursts.","confidence":0.9,"entities":["webhooks"]},"reason":"unify"}\n```', cluster);
  assert.equal(merge.verdict, 'merge');
  assert.deepEqual(merge.retire, [1, 2], 'no retire list → all members OF THE MERGED TYPE (the todo #3 is never folded in)');
  assert.equal(merge.merged.confidence, 0.9);
  assert.equal(parseVerdict('{"verdict":"merge","merged":{"type":"decision","title":"","content":"x"}}', cluster), null, 'empty title');
  assert.equal(parseVerdict('{"verdict":"merge","merged":{"type":"nonsense","title":"T","content":"C"}}', cluster).merged.type, 'decision', 'unknown type → majority non-todo type');
  assert.equal(parseVerdict('{"verdict":"merge","merged":{"type":"todo","title":"T","content":"C"},"retire":[1,2,3]}', cluster), null,
    'types are boundaries: a merged todo may only absorb todos, and one todo is not a merge → null (cluster left alone)');
  assert.equal(parseVerdict('{"verdict":"supersede","keep_id":2,"retire":[1,3]}', cluster).retire.join(), '1', 'supersede drops cross-type ids');
  assert.equal(parseVerdict('{"verdict":"supersede","keep_id":3,"retire":[1,2]}', cluster), null, 'a todo cannot supersede decisions');
  assert.equal(parseVerdict('{"reason":"thought first","verdict":"keep"}', cluster).reason, 'thought first', 'reason-first key order is fine');

  assert.deepEqual(parseVerdict('{"verdict":"close_todo","resolved_by":2,"retire":[3,1]}', cluster),
    { verdict: 'close_todo', resolved_by: 2, retire: [3], reason: '' }, 'only todos can be closed');
  assert.equal(parseVerdict('{"verdict":"close_todo","resolved_by":3,"retire":[1]}', cluster), null, 'a todo cannot be the resolver');
  assert.equal(parseVerdict('{"verdict":"delete_all"}', cluster), null);
  assert.equal(parseVerdict('no json here', cluster), null);
  assert.equal(parseVerdict('', cluster), null);
});

test('unionSources: source_session + sources JSON, de-duplicated, malformed ignored', () => {
  assert.deepEqual(unionSources([
    { source_session: 's1', sources: '["s1","s2"]' }, { source_session: 's3', sources: 'not json' }, { source_session: null, sources: null },
  ]), ['s1', 's2', 's3']);
});

// ---------------------------------------------------------------------------
// applyVerdict + consolidateProject against a temp DB
// ---------------------------------------------------------------------------
const db = openDb();
const fakeEmbed = async (texts) => texts.map(() => dirv(0));
const save = (m, deg) => saveMemory(db, { project: 'proj', ...m }, dirv(deg)).id;

test('migration v5: sources column + consolidations ledger; retireMemories never resurrects', () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  const id = save({ type: 'fact', title: 'temp', content: 'temp content', sources: ['sA', 'sB'] }, 45);
  assert.equal(db.prepare('SELECT sources FROM memories WHERE id = ?').get(id).sources, '["sA","sB"]');
  assert.equal(retireMemories(db, [id]), 1);
  assert.equal(retireMemories(db, [id]), 0, 'already retired → no-op');
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(id).status, 'superseded');
  assert.throws(() => retireMemories(db, [id], { status: 'active' }));
});

test('applyVerdict supersede: losers retire, survivor inherits provenance + supersedes, ledger written', async () => {
  const older = save({ type: 'decision', title: 'Idempotency in Postgres', content: 'idempotency keys in postgres', source_session: 'sess-old' }, 0);
  const newer = save({ type: 'decision', title: 'Idempotency keys in Postgres, not Redis', content: 'idempotency keys in postgres not redis because eviction', source_session: 'sess-new' }, 1);
  const [c] = clusterMemories(activeMemories(db, 'proj'));
  assert.equal(c.key, clusterKey([older, newer]));
  const res = await applyVerdict(db, c, { verdict: 'supersede', keep_id: newer, retire: [older], reason: 'newer is complete' }, { embed: fakeEmbed });
  assert.deepEqual(res, { verdict: 'supersede', result_id: newer, retired: [older] });
  const survivor = db.prepare('SELECT status, supersedes, sources FROM memories WHERE id = ?').get(newer);
  assert.equal(survivor.status, 'active');
  assert.equal(survivor.supersedes, older);
  assert.deepEqual(JSON.parse(survivor.sources).sort(), ['sess-new', 'sess-old']);
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(older).status, 'superseded');
  assert.ok(alreadyJudged(db, c.key));
  assert.equal(searchMemories(db, dirv(0), { project: 'proj', type: 'decision' }).length, 1, 'search hides the retired one by default');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n >= 3, true, 'nothing deleted');
});

test('applyVerdict merge: new merged memory with union provenance, all members retired', async () => {
  const a = save({ type: 'solution', title: 'Fix 502 on uploads (a)', content: 'raised payload limit on gateway for uploads', source_session: 'sA', entities: ['gateway'] }, 10);
  const b = save({ type: 'solution', title: 'Fix 502 on uploads (b)', content: 'uploads 502 fixed by aligning payload limit between services', source_session: 'sB', entities: ['uploads-svc'] }, 11);
  const c = clusterMemories(activeMemories(db, 'proj')).find(x => x.key === clusterKey([a, b]));
  const res = await applyVerdict(db, c, {
    verdict: 'merge', retire: [a, b], reason: 'same fix',
    merged: { type: 'solution', title: 'Fix 502 on large uploads', content: 'Root cause: payload limit mismatch gateway vs service; fix: align both limits.', entities: ['gateway'] },
  }, { embed: fakeEmbed });
  assert.equal(res.verdict, 'merge');
  assert.deepEqual(res.retired.sort(), [a, b].sort());
  const merged = db.prepare('SELECT * FROM memories WHERE id = ?').get(res.result_id);
  assert.equal(merged.status, 'active');
  assert.deepEqual(JSON.parse(merged.sources).sort(), ['sA', 'sB']);
  assert.deepEqual(JSON.parse(merged.entities).sort(), ['gateway', 'uploads-svc'], 'entities = judge + members');
  assert.ok([a, b].includes(merged.supersedes));
  for (const id of [a, b]) assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(id).status, 'superseded');
});

test('applyVerdict merge whose title equals a member REFRESHES that member (it survives, others retire)', async () => {
  const x = save({ type: 'fact', title: 'Model is e5-small', content: 'embeddings via multilingual e5 small', source_session: 'sX' }, 30);
  const y = save({ type: 'fact', title: 'Embedding model: e5-small', content: 'multilingual e5 small embeddings locally', source_session: 'sY' }, 31);
  const c = clusterMemories(activeMemories(db, 'proj')).find(cl => cl.key === clusterKey([x, y]));
  const res = await applyVerdict(db, c, { verdict: 'merge', retire: [x, y], merged: { type: 'fact', title: 'Model is e5-small', content: 'Embeddings: multilingual e5-small, local.' } }, { embed: fakeEmbed });
  assert.equal(res.result_id, x);
  assert.equal(res.refreshed, true);
  assert.deepEqual(res.retired, [y]);
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(x).status, 'active');
});

test('applyVerdict close_todo: todo retires, resolver points at it; keep: ledger only', async () => {
  const todo = save({ type: 'todo', title: 'Rotate staging creds', content: 'rotate staging credentials', source_session: 'sT' }, 50);
  const done = save({ type: 'solution', title: 'Staging creds rotated', content: 'rotated staging credentials via secrets manager', source_session: 'sD' }, 51);
  const c = clusterMemories(activeMemories(db, 'proj')).find(cl => cl.key === clusterKey([todo, done]));
  const res = await applyVerdict(db, c, { verdict: 'close_todo', resolved_by: done, retire: [todo] });
  assert.deepEqual(res, { verdict: 'close_todo', result_id: done, retired: [todo] });
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(todo).status, 'superseded');
  assert.equal(db.prepare('SELECT supersedes FROM memories WHERE id = ?').get(done).supersedes, todo);

  const k1 = save({ type: 'fact', title: 'Alpha fact', content: 'alpha beta gamma delta', source_session: 'k' }, 70);
  const k2 = save({ type: 'fact', title: 'Alpha fact again', content: 'alpha beta gamma delta again', source_session: 'k' }, 71);
  const kc = clusterMemories(activeMemories(db, 'proj')).find(cl => cl.key === clusterKey([k1, k2]));
  const kr = await applyVerdict(db, kc, { verdict: 'keep', reason: 'different angles' });
  assert.deepEqual(kr, { verdict: 'keep', retired: [] });
  assert.ok(alreadyJudged(db, kc.key), 'keep is memoized so the cluster is never re-judged');
  assert.equal(db.prepare('SELECT status FROM memories WHERE id IN (?,?) AND status = ?').all(k1, k2, 'active').length, 2);
});

test('consolidateProject: judges only un-judged clusters, applies, is idempotent; dry spends nothing', async () => {
  const p = 'proj2';
  const s = (m, deg) => saveMemory(db, { project: p, ...m }, dirv(deg)).id;
  const a = s({ type: 'decision', title: 'Use Drizzle', content: 'drizzle orm chosen over kysely', source_session: '1' }, 0);
  const b = s({ type: 'decision', title: 'Drizzle ORM chosen', content: 'drizzle orm chosen over kysely and raw sql', source_session: '2' }, 1);
  s({ type: 'fact', title: 'Unrelated', content: 'something else entirely', source_session: '3' }, 90);

  const dry = await consolidateProject(db, p, { dry: true, run: async () => { throw new Error('must not run'); } });
  assert.equal(dry.clusters, 1);
  assert.equal(dry.judged, 0);

  let calls = 0;
  const run = async (prompt, { model }) => {
    calls++;
    assert.equal(model, 'sonnet');
    assert.ok(prompt.includes('#' + a) && prompt.includes('#' + b));
    return JSON.stringify({ type: 'result', result: `{"verdict":"supersede","keep_id":${b},"retire":[${a}],"reason":"b is complete"}` });
  };
  const seen = [];
  const t = await consolidateProject(db, p, { model: 'sonnet', run, embed: fakeEmbed, onCluster: (c, v, r) => seen.push([v.verdict, r.retired]) });
  assert.deepEqual([t.clusters, t.judged, t.applied, t.retired, t.failed, t.skipped], [1, 1, 1, 1, 0, 0]);
  assert.deepEqual(seen, [['supersede', [a]]]);
  assert.equal(calls, 1);

  const again = await consolidateProject(db, p, { run: async () => { throw new Error('must not run: nothing left'); } });
  assert.equal(again.clusters, 0, 'the loser is retired → no active cluster remains');
  assert.deepEqual(consolidatableProjects(db).map(x => x.project).includes(p), true);
});

test('consolidateProject: unusable judge output leaves the cluster alone (skipped, not applied, not memoized); approve() can veto', async () => {
  const p = 'proj3';
  const s = (m, deg) => saveMemory(db, { project: p, ...m }, dirv(deg)).id;
  const a = s({ type: 'fact', title: 'Region us-east-1', content: 'deployed in us-east-1 region', source_session: '1' }, 0);
  const b = s({ type: 'fact', title: 'Region: us-east-1', content: 'everything deployed in us-east-1 region', source_session: '2' }, 1);

  const bad = await consolidateProject(db, p, { run: async () => 'I cannot decide.' });
  assert.deepEqual([bad.judged, bad.skipped, bad.applied], [1, 1, 0]);
  assert.equal(alreadyJudged(db, clusterKey([a, b])), false, 'not memoized → retried next run');

  const veto = await consolidateProject(db, p, {
    run: async () => `{"verdict":"supersede","keep_id":${b},"retire":[${a}]}`,
    approve: async () => false,
  });
  assert.deepEqual([veto.judged, veto.skipped, veto.applied], [1, 1, 0]);
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(a).status, 'active');

  const failing = await consolidateProject(db, p, { run: async () => { throw new Error('claude exploded'); } });
  assert.deepEqual([failing.failed, failing.applied], [1, 0]);
  assert.match(failing.results[0].error, /exploded/);
});
