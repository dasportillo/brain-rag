// Unit tests for the heuristic entity graph (v1.0): extractEntities precision per kind,
// migration v3, linkEntities/entityLookup round trip, and the searchChunks entity boost.
// Dep-free by design: temp DB via BRAIN_DIR/BRAIN_DB, hand-crafted embeddings, no model load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-ent-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { extractEntities } = await import('../entities.mjs');
const { openDb, vecToBlob, searchChunks, linkEntities, entityStats, entityLookup, saveMemory } = await import('../store.mjs');

// --- extractEntities: one precise pattern per kind --------------------------

test('aws_arn: keeps the resource tail, strips trailing punctuation', () => {
  const e = extractEntities('the lambda failed on arn:aws:dynamodb:us-east-1:123456789012:table/mi-tabla.');
  assert.deepEqual(e, [{ name: 'table/mi-tabla', kind: 'aws_arn' }]);
});

test('aws_resource: s3 bucket only — the key is noise, and never leaks as a file_path', () => {
  const e = extractEntities('backup lives in s3://efy-backups/2026/07/dump.sql.gz today');
  assert.deepEqual(e, [{ name: 'efy-backups', kind: 'aws_resource' }]);
});

test('database: tables after UPPERCASE FROM/JOIN in a SQL fragment', () => {
  const e = extractEntities('run SELECT p.id FROM pagos p JOIN eventos_ledger e ON e.pago_id = p.id');
  assert.deepEqual(e.filter(x => x.kind === 'database').map(x => x.name).sort(), ['eventos_ledger', 'pagos']);
});

test('database: prose FROM (no SQL statement around) extracts nothing', () => {
  assert.deepEqual(extractEntities('we copied FROM the source and moved on'), []);
  // even inside SQL-ish text, stopwords after FROM are rejected
  assert.ok(!extractEntities('SELECT it FROM the list').some(x => x.kind === 'database'));
});

test('repo: github.com URLs and gh CLI --repo; grep -R never mints a repo', () => {
  const e = extractEntities('see https://github.com/dasportillo/brain-rag/pull/12 then gh pr checkout 5 --repo efinti/efy3-users');
  assert.deepEqual(e.filter(x => x.kind === 'repo').map(x => x.name).sort(), ['dasportillo/brain-rag', 'efinti/efy3-users']);
  assert.deepEqual(extractEntities('grep -R foo/bar src'), [], 'a bare -R flag is not a gh invocation');
});

test('service: infrastructure hostnames only, lowercased, capped and deduped', () => {
  const e = extractEntities('pagos.efy.internal calls SQS.US-EAST-1.AMAZONAWS.COM and pagos.efy.internal again');
  assert.deepEqual(e.map(x => x.kind), ['service', 'service']);
  assert.equal(e[0].name, 'pagos.efy.internal', 'deduped and most frequent first');
  assert.equal(e[1].name, 'sqs.us-east-1.amazonaws.com', 'normalized to lowercase');
  // cap: 7 distinct hostnames, the two repeated ones must survive
  const many = 'a.x.internal a.x.internal b.x.internal b.x.internal c.x.internal d.x.internal e.x.internal f.x.internal g.x.internal';
  const svcs = extractEntities(many).filter(x => x.kind === 'service');
  assert.equal(svcs.length, 5, 'services capped at 5');
  assert.deepEqual(svcs.slice(0, 2).map(s => s.name), ['a.x.internal', 'b.x.internal']);
});

test('file_path: needs a slash and an extension; flood-capped at 1 per 200 chars', () => {
  const short = extractEntities('edit src/store.mjs then also src/server.mjs and test/entities.test.mjs');
  assert.deepEqual(short.filter(x => x.kind === 'file_path'), [{ name: 'src/store.mjs', kind: 'file_path' }],
    'short text (<400 chars) keeps only 1 path');
  const long = extractEntities(('padding words to grow the text well past four hundred characters ' .repeat(7))
    + ' /Users/wp/project/brain-rag/server.mjs and src/utils/helper.test.mjs');
  assert.deepEqual(long.filter(x => x.kind === 'file_path').map(x => x.name).sort(),
    ['/Users/wp/project/brain-rag/server.mjs', 'src/utils/helper.test.mjs'], 'longer text allows more paths');
});

test('file_path: URL path tails never leak in (with or without scheme)', () => {
  const withScheme = extractEntities('see https://github.com/o/r/blob/main/store.mjs for details');
  assert.ok(!withScheme.some(x => x.kind === 'file_path'));
  assert.ok(withScheme.some(x => x.kind === 'repo' && x.name === 'o/r'), 'the repo IS still extracted');
  assert.ok(!extractEntities('at github.com/o/r/blob/main/store.mjs too').some(x => x.kind === 'file_path'));
});

test('identifier: SCREAMING_SNAKE >= 6 chars with an underscore', () => {
  const e = extractEntities('el estado pasa a MONTOS_FIJOS y luego EN_RESPUESTA; AB_CD no cuenta; ERROR tampoco');
  assert.deepEqual(e.map(x => x.name).sort(), ['EN_RESPUESTA', 'MONTOS_FIJOS']);
  assert.ok(e.every(x => x.kind === 'identifier'));
});

test('global cap 20, most frequent first, deduped', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `STATE_${String.fromCharCode(65 + i)}X`);
  const text = `REPEATED_STATE ${ids.join(' ')} REPEATED_STATE and REPEATED_STATE`;
  const e = extractEntities(text);
  assert.equal(e.length, 20, 'capped at 20');
  assert.deepEqual(e[0], { name: 'REPEATED_STATE', kind: 'identifier' }, 'most frequent first');
  assert.equal(new Set(e.map(x => x.name)).size, 20, 'deduped');
});

test('empty / non-string input extracts nothing', () => {
  assert.deepEqual(extractEntities(''), []);
  assert.deepEqual(extractEntities(null), []);
  assert.deepEqual(extractEntities('plain prose without any identifiers at all'), []);
});

// --- migration v3 ------------------------------------------------------------

const db = openDb();

test('migration v3: entity tables present, user_version = 3, idempotent reopen', () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(openDb().prepare('PRAGMA user_version').get().user_version, 3, 'second openDb is a no-op');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'entity_mentions')").all();
  assert.equal(tables.length, 2);
});

// --- linkEntities + entityLookup round trip ----------------------------------

const insC = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
const vec = (a, b) => { const v = new Array(8).fill(0); v[0] = a; v[1] = b; return v; };

test('linkEntities + entityLookup: projects, counts, recency, co-occurrence', () => {
  const t1 = 'la auditoría dispara MONTOS_FIJOS via pagos.efy.internal';
  const t2 = 'MONTOS_FIJOS otra vez, ahora en otro proyecto';
  const c1 = Number(insC.run('/e/a.jsonl', 'projA', 'e1', '2026-07-01', 'assistant', t1, null).lastInsertRowid);
  const c2 = Number(insC.run('/e/b.jsonl', 'projB', 'e2', '2026-07-02', 'assistant', t2, null).lastInsertRowid);
  assert.equal(linkEntities(db, { chunkId: c1, project: 'projA', ts: '2026-07-01', text: t1 }), 2);
  assert.equal(linkEntities(db, { chunkId: c2, project: 'projB', ts: '2026-07-02', text: t2 }), 1);

  const info = entityLookup(db, 'MONTOS_FIJOS');
  assert.equal(info.entity.kind, 'identifier');
  assert.equal(info.mentionCount, 2);
  assert.equal(info.recentTs, '2026-07-02');
  assert.deepEqual(info.projects.map(p => p.project).sort(), ['projA', 'projB']);
  assert.ok(info.coOccurring.some(c => c.name === 'pagos.efy.internal' && c.kind === 'service'), 'co-mentioned in c1');
  assert.equal(info.recentMentions[0].chunk_id, c2, 'newest mention first, chunk text attached');
  assert.match(info.recentMentions[0].text, /otra vez/);

  assert.equal(entityLookup(db, 'montos_fijos').entity.name, 'MONTOS_FIJOS', 'case-insensitive fallback');
  assert.equal(entityLookup(db, 'NOT_IN_GRAPH_EVER'), null);
});

test('entityStats: mention-ordered overview, project filter narrows', () => {
  const all = entityStats(db);
  assert.equal(all[0].name, 'MONTOS_FIJOS');
  assert.equal(all[0].mentions, 2);
  assert.equal(all[0].projects, 2);
  const scoped = entityStats(db, { project: 'projB' });
  assert.deepEqual(scoped.map(r => r.name), ['MONTOS_FIJOS'], 'projB never mentioned the service');
});

test('saveMemory links entities on create, and refresh does not duplicate mentions', () => {
  saveMemory(db, {
    type: 'fact', project: 'projC', title: 'Estados del flujo',
    content: 'El flujo termina en EN_RESPUESTA cuando el pagador contesta.',
  }, vec(1, 0));
  assert.equal(entityLookup(db, 'EN_RESPUESTA').mentionCount, 1);
  saveMemory(db, { // same project+type+title => UPDATE in place => mentions relinked, not appended
    type: 'fact', project: 'projC', title: 'Estados del flujo',
    content: 'Actualizado: EN_RESPUESTA sigue siendo el estado terminal.',
  }, vec(1, 0));
  assert.equal(entityLookup(db, 'EN_RESPUESTA').mentionCount, 1, 'refresh replaced, not appended');
});

// --- searchChunks entity boost ------------------------------------------------

test('entity boost: an orthogonal chunk enters top-k only when its entity is in the query', () => {
  // two distractors aligned with the query vector; the target chunk is vectorially ORTHOGONAL
  // and shares no query tokens — the entity leg is its only way in.
  insC.run('/b/d1.jsonl', 'boost', 'b1', '2026-05-01', 'assistant', 'aligned distractor text one', vecToBlob(vec(1, 0)));
  insC.run('/b/d2.jsonl', 'boost', 'b2', '2026-05-02', 'assistant', 'aligned distractor text two', vecToBlob(vec(0.95, 0.312)));
  const g = Number(insC.run('/b/g.jsonl', 'boost', 'b3', '2026-05-03', 'assistant',
    'notas de jardinería y tulipanes', vecToBlob(vec(0, 1))).lastInsertRowid);
  // the mention is linked from text CONTAINING the entity, pointing at the orthogonal chunk —
  // so neither the vector nor the FTS leg can surface it, only the mention link.
  linkEntities(db, { chunkId: g, project: 'boost', ts: '2026-05-03', text: 'transición a MONTOS_FIJOS' });

  const boosted = searchChunks(db, vec(1, 0), { project: 'boost', k: 2, queryText: 'estado MONTOS_FIJOS flujo', recencyBoost: 0 });
  assert.ok(boosted.some(h => /jardinería/.test(h.text)), 'entity in the query pulls the mention chunk into top-k');

  const plain = searchChunks(db, vec(1, 0), { project: 'boost', k: 2, queryText: 'estado del flujo', recencyBoost: 0 });
  assert.ok(!plain.some(h => /jardinería/.test(h.text)), 'without the entity it stays out of top-k');
});

test("entity boost respects mode: 'semantic' (unchanged pure-cosine order)", () => {
  const res = searchChunks(db, vec(1, 0), { project: 'boost', k: 2, queryText: 'estado MONTOS_FIJOS flujo', mode: 'semantic', recencyBoost: 0 });
  assert.ok(!res.some(h => /jardinería/.test(h.text)), 'semantic mode ignores the entity leg');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
