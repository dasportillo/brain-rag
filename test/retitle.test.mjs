// Unit tests for `brain-rag retitle` (issue #38): the title-only repair pass over memories
// distilled before the one-claim rules. The point of the command is what it does NOT do — it
// creates no rows, so none of the data-destroying paths of the parked `rewrite` command (#35)
// exist here. These tests pin that: the private flag, created_at, provenance and the supersedes
// chain all survive, and a lazy model answer leaves the memory alone.
// Temp DB, injected extractor and embedder: no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-retitle-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const {
  chunkBatches, buildRetitleInput, retitlePrompt, parseTitles, formatBeforeAfter,
  selectLongTitles, retitleAll, DEFAULT_OVER, DEFAULT_BATCH,
} = await import('../retitle.mjs');
const { openDb, saveMemory, aliasMembers, searchMemories } = await import('../store.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const vec = (a, b) => { const v = new Array(8).fill(0); v[0] = a; v[1] = b; return v; };
const fakeEmbed = async (texts) => texts.map((_, i) => vec(1, i));
const LONG = 'Un título larguísimo que describe en detalle todo lo que pasó en la sesión y además incluye el identificador app-d2c4bhdlxjqimb';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test('chunkBatches: batching is the cost fix — 46 memories at 20 is 3 calls, not 46', () => {
  const items = Array.from({ length: 46 }, (_, i) => i);
  const groups = chunkBatches(items, 20);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.flat(), items, 'every memory in exactly one batch');
  assert.equal(chunkBatches(items).length, Math.ceil(46 / DEFAULT_BATCH), 'default batch');
  // A garbage size must never degrade to one call per memory (that is the 16-USD mistake).
  for (const bad of [0, -5, NaN, undefined, 0.5]) {
    assert.equal(chunkBatches(items, bad).length, Math.ceil(46 / DEFAULT_BATCH), `size ${bad} falls back to the default`);
  }
});

test('buildRetitleInput / retitlePrompt: ids, current length and a capped body; asks for JSON only', () => {
  const rows = [{ id: 7, type: 'fact', title: LONG, content: 'x'.repeat(2000) }];
  const input = buildRetitleInput(rows, { bodyCap: 100 });
  assert.match(input, /### id 7 · fact/);
  assert.match(input, new RegExp(`current title \\(${LONG.length} chars\\)`));
  assert.ok(input.length < 400, 'the body is capped — the model picks a title, it does not read an essay');
  const p = retitlePrompt(input);
  assert.match(p, /OUTPUT ONLY a JSON array/);
  assert.match(p, /SAME LANGUAGE/);
  assert.match(p, /Do not rewrite the body/);
  assert.ok(p.includes(input));
});

test('parseTitles: accepts only titles that are an improvement', () => {
  const batch = [{ id: 1, title: LONG }, { id: 2, title: LONG + '!' }];
  const ok = parseTitles('```json\n[{"id":1,"title":"El dashboard corre en Amplify"}]\n```', batch);
  assert.deepEqual([...ok], [[1, 'El dashboard corre en Amplify']], 'fences and prose tolerated');

  const reject = (answer, why) => assert.equal(parseTitles(answer, batch).size, 0, why);
  reject('[{"id":99,"title":"corta"}]', 'id outside the batch');
  reject('[{"id":1,"title":"   "}]', 'empty title');
  reject(`[{"id":1,"title":"${LONG}"}]`, 'unchanged');
  reject(`[{"id":1,"title":"${LONG + ' y más"'}}]`, 'longer than the original');
  reject(`[{"id":1,"title":"${'z'.repeat(DEFAULT_OVER + 1)}"}]`, 'still over the threshold — left for a retry');
  reject('no json at all', 'unparseable');
  reject('[]', 'empty array');

  const dup = parseTitles('[{"id":1,"title":"Primera corta"},{"id":1,"title":"Segunda corta"}]', batch);
  assert.deepEqual([...dup], [[1, 'Primera corta']], 'first answer per id wins');
  assert.match(formatBeforeAfter({ id: 1, project: 'p', type: 'fact', title: LONG }, 'Corta'), /#1 p · fact/);
});

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const db = openDb();
const mk = (title, extra = {}) => saveMemory(db, {
  type: 'fact', project: 'proj', title, content: 'El cuerpo de la memoria, con su porqué y sus rutas src/**/*.ts.', ...extra,
}, vec(1, 0)).id;

test('selectLongTitles: only active, only over the threshold, longest first, project-aware', () => {
  const long = mk(LONG);
  const longer = mk(LONG + ' y todavía un poco más de texto');
  mk('Un título corto y correcto');
  const otro = mk(LONG, { project: 'otro' });
  saveMemory(db, { type: 'fact', project: 'proj', title: LONG + ' (retirada)', content: 'x', status: 'superseded' }, vec(1, 0));

  const rows = selectLongTitles(db, { aliasMembers });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(long) && ids.includes(longer) && ids.includes(otro));
  assert.equal(rows[0].id, longer, 'longest first, so --limit fixes the worst');
  assert.ok(rows.every((r) => r.title.length > DEFAULT_OVER), 'short ones excluded');
  assert.ok(!rows.some((r) => r.title.includes('(retirada)')), 'retired memories are not touched');

  assert.deepEqual(selectLongTitles(db, { project: 'otro', aliasMembers }).map((r) => r.id), [otro]);
  assert.equal(selectLongTitles(db, { limit: 1, aliasMembers }).length, 1);
  assert.equal(selectLongTitles(db, { over: 1000, aliasMembers }).length, 0);
});

test('a retitle is an UPDATE: id, private, created_at, provenance and the supersedes chain survive', async () => {
  const oldId = mk('Una memoria vieja que será superada por otra con título larguísimo de verdad');
  const id = saveMemory(db, {
    type: 'decision', project: 'proj', title: LONG,
    content: 'Se decidió X porque Y, y la ruta es src/**/*.ts.',
    private: true, source_session: 'sess-42', source_messages: ['cita textual'], entities: ['Amplify'],
    supersedes: oldId,
  }, vec(0, 1)).id;
  const before = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);

  const run = async (prompt) => {
    assert.match(prompt, new RegExp(`id ${id}`));
    return JSON.stringify({ type: 'result', result: `[{"id":${id},"title":"El dashboard corre en Amplify"}]` });
  };
  const t = await retitleAll(db, [{ id, project: 'proj', type: 'decision', title: LONG, content: before.content }], { run, embed: fakeEmbed });
  assert.deepEqual([t.calls, t.changed, t.skipped], [1, 1, 0]);

  const after = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.equal(after.id, id, 'same row — no new memory was created');
  assert.equal(after.title, 'El dashboard corre en Amplify');
  assert.equal(after.content, before.content, 'the body is untouched');
  assert.equal(after.private, 1, 'the private flag survives — this is the bug that sank the split path');
  assert.equal(after.created_at, before.created_at, 'the date it was learned survives');
  assert.equal(after.status, 'active');
  assert.equal(after.supersedes, oldId, 'the chain survives');
  assert.equal(after.source_session, 'sess-42');
  assert.equal(after.source_messages, before.source_messages);
  // updated_at is re-stamped so `cloud sync` (updated_at > synced_at) re-pushes the new title.
  // Compared with >= rather than !=: a save and a retitle inside the same millisecond produce the
  // same ISO string, which is a test-timing artifact, not a behaviour worth pinning.
  assert.ok(after.updated_at >= before.updated_at, 'updated_at is re-stamped');
  assert.ok(Date.now() - Date.parse(after.updated_at) < 60_000, 'and it is stamped now, not left stale');
  assert.notEqual(Buffer.compare(Buffer.from(after.embedding), Buffer.from(before.embedding)), 0, 're-embedded: the vector covers the title');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memories WHERE project='proj'").get().n,
    db.prepare("SELECT COUNT(*) n FROM memories WHERE project='proj'").get().n, 'no rows added or removed');
  // The FTS index follows the title through its UPDATE trigger, so the new words are findable.
  const hit = searchMemories(db, vec(0, 1), { project: 'proj', queryText: 'Amplify dashboard', k: 5 });
  assert.ok(hit.some((h) => h.id === id), 'still retrievable after the change');
});

test('retitleAll: a batch the model fluffs is left alone and stays selectable; --dry writes nothing', async () => {
  const a = mk(LONG + ' aaa');
  const b = mk(LONG + ' bbb');
  const rows = selectLongTitles(db, { aliasMembers }).filter((r) => [a, b].includes(r.id));
  assert.equal(rows.length, 2);

  // The model answers usefully for one and uselessly for the other (longer title).
  const run = async () => `[{"id":${a},"title":"Título corto y bueno"},{"id":${b},"title":"${LONG + ' bbb y aún más largo'}"}]`;
  const t = await retitleAll(db, rows, { run, embed: fakeEmbed });
  assert.deepEqual([t.changed, t.skipped], [1, 1]);
  assert.equal(db.prepare('SELECT title FROM memories WHERE id = ?').get(a).title, 'Título corto y bueno');
  assert.ok(db.prepare('SELECT title FROM memories WHERE id = ?').get(b).title.length > DEFAULT_OVER, 'untouched');
  // The length filter IS the idempotency marker: the fixed one is gone from the next selection,
  // the fluffed one is still there to retry.
  const next = selectLongTitles(db, { aliasMembers }).map((r) => r.id);
  assert.ok(!next.includes(a) && next.includes(b));

  const dryRows = selectLongTitles(db, { aliasMembers }).filter((r) => r.id === b);
  const titleBefore = db.prepare('SELECT title, updated_at FROM memories WHERE id = ?').get(b);
  const dt = await retitleAll(db, dryRows, { dry: true, run: async () => `[{"id":${b},"title":"Corto de verdad"}]`, embed: fakeEmbed });
  assert.equal(dt.changed, 1, 'dry still reports what it WOULD do');
  assert.deepEqual(db.prepare('SELECT title, updated_at FROM memories WHERE id = ?').get(b), titleBefore, 'and wrote nothing');
});

test('retitleAll: a failed call costs the batch, not the run', async () => {
  const rows = selectLongTitles(db, { aliasMembers });
  const t = await retitleAll(db, rows, {
    batch: 1,
    run: async (p) => { if (/bbb/.test(p)) throw new Error('claude exploded'); return '[]'; },
    embed: fakeEmbed,
  });
  assert.equal(t.changed, 0);
  assert.equal(t.skipped, rows.length, 'every memory accounted for, none half-written');
  assert.ok(t.calls < rows.length, 'the failed batch did not count as a call');
});
