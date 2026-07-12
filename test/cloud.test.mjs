// Unit tests for the team-sync client's pure layer: what syncs (and what NEVER does).
// Temp DB, no network, no model — toPushItem reuses stored embedding blobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-cloud-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { openDb, saveMemory } = await import('../store.mjs');
const { pendingMemories, toPushItem, loadCloudConfig, autoSync } = await import('../cloud.mjs');

const vec = (a, b) => { const v = new Array(8).fill(0); v[0] = a; v[1] = b; return v; };
const db = openDb();

test('pendingMemories: private memories NEVER sync; synced ones only re-sync after changes', () => {
  const pub = saveMemory(db, { type: 'decision', project: 'p', title: 'shared decision', content: 'goes to the team' }, vec(1, 0));
  saveMemory(db, { type: 'fact', project: 'p', title: 'my private note', content: 'stays home', private: true }, vec(0, 1));

  let pending = pendingMemories(db);
  assert.deepEqual(pending.map(r => r.title), ['shared decision'], 'private excluded by construction');

  // mark synced -> nothing pending
  db.prepare('UPDATE memories SET synced_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), pub.id);
  assert.equal(pendingMemories(db).length, 0);

  // refresh the memory (same title = update in place, bumps updated_at) -> pending again
  const later = new Date(Date.now() + 60000).toISOString();
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(later, pub.id);
  pending = pendingMemories(db);
  assert.deepEqual(pending.map(r => r.id), [pub.id], 'changed-after-sync re-syncs');
});

test('toPushItem: payload is built ONLY from memory fields, embedding round-trips, no-embedding rows skip', () => {
  const row = pendingMemories(db)[0];
  const item = toPushItem(row);
  assert.equal(item.local_id, row.id);
  assert.equal(item.title, 'shared decision');
  assert.equal(item.embedding.length, 8);
  assert.ok(Math.abs(item.embedding[0] - 1) < 1e-6, 'stored blob reused verbatim — no model load');
  // the payload shape has no field that could carry transcript/chunk text
  assert.deepEqual(Object.keys(item).sort(), ['confidence', 'content', 'embedding', 'entities', 'local_id', 'project', 'source_messages', 'source_session', 'status', 'title', 'type'].sort());

  assert.equal(toPushItem({ ...row, embedding: null }), null, 'embedding-less rows are skipped, not sent broken');
});

test('loadCloudConfig: absent -> null, malformed -> null, valid -> parsed', () => {
  assert.equal(loadCloudConfig(join(dir, 'nope.json')), null);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(loadCloudConfig(bad), null);
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ endpoint: 'https://x', apiKey: 'brk_' + 'a'.repeat(40) }));
  assert.equal(loadCloudConfig(good).endpoint, 'https://x');
});

test('autoSync: no config -> no-op null; auto:false -> no-op; on -> pushes pending and marks synced; offline -> pending intact', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  // no config file yet in BRAIN_DIR -> null, and crucially NO fetch attempted
  global.fetch = () => { throw new Error('fetch must not be called without config'); };
  assert.equal(await autoSync(db), null);

  const conf = { endpoint: 'https://team.example', apiKey: 'brk_' + 'a'.repeat(40) };
  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ ...conf, auto: false }));
  assert.equal(await autoSync(db), null, 'auto:false is a hard off switch');

  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ ...conf, auto: true }));
  // undo the earlier test's future timestamps: realistic state = unsynced, edited in the past
  db.prepare('UPDATE memories SET synced_at = NULL, updated_at = ? WHERE private = 0')
    .run(new Date(Date.now() - 1000).toISOString());
  const before = pendingMemories(db).length;
  assert.ok(before > 0, 'test premise: something pending');

  // happy path: fake server accepts everything
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ results: JSON.parse(opts.body).memories.map(() => ({ action: 'created', id: 1 })) }) };
  };
  const res = await autoSync(db);
  assert.equal(res.pushed, before);
  assert.equal(pendingMemories(db).length, 0, 'pushed rows are marked synced');
  assert.ok(calls[0].url.startsWith('https://team.example/v1/memories/push'));
  assert.ok(!JSON.stringify(calls).includes('stays home'), 'private memory never reaches the wire');

  // offline: a NEW pending memory + dead endpoint -> silent, row stays pending
  saveMemory(db, { type: 'fact', project: 'p', title: 'queued while offline', content: 'waits for reconnection' }, vec(2, 2));
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const off = await autoSync(db);
  assert.equal(off.offline, true);
  assert.equal(off.pushed, 0);
  assert.equal(pendingMemories(db).length, 1, 'nothing lost, still pending');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
