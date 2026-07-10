// Unit tests for retrieval (hybrid RRF, dedup, title attach). Uses a temp DB with hand-crafted
// embeddings — no model load. BRAIN_DB must be set before importing store.mjs (read at module load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-store-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { openDb, vecToBlob, searchChunks, diffChunks, recentActivity } = await import('../store.mjs');

test('diffChunks: only new/changed text embeds; vanished chunks are stale', () => {
  const existing = [{ id: 1, text: 'turn a' }, { id: 2, text: 'turn b' }, { id: 3, text: 'old summary' }];
  const records = [{ text: 'turn a' }, { text: 'turn b' }, { text: 'turn c' }, { text: 'new summary' }];
  const { toEmbed, staleIds } = diffChunks(existing, records);
  assert.deepEqual(toEmbed.map(r => r.text), ['turn c', 'new summary'], 'only new/changed embed');
  assert.deepEqual(staleIds, [3], 'the vanished old summary is stale');
});

test('diffChunks: unchanged file embeds nothing, deletes nothing', () => {
  const rows = [{ id: 1, text: 'x' }, { id: 2, text: 'y' }];
  const { toEmbed, staleIds } = diffChunks(rows, [{ text: 'x' }, { text: 'y' }]);
  assert.equal(toEmbed.length, 0);
  assert.equal(staleIds.length, 0);
});

// unit vectors in the first two dims (rest zero) → cosine == dot is exact and easy to reason about
const vec = (a, b) => { const v = new Array(384).fill(0); v[0] = a; v[1] = b; return v; };

const db = openDb();
const insC = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
const insS = db.prepare('INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at,title) VALUES(?,?,?,?,?,?,?,?)');
// A: aligned with the query + lexical match, session has a title
insC.run('/p/s1.jsonl', 'proj', 's1', '2026-01-01', 'assistant', 'oauth-idp groups authorizer role mapping bug', vecToBlob(vec(1, 0)));
// B: orthogonal, no lexical overlap
insC.run('/p/s2.jsonl', 'proj', 's2', '2026-01-02', 'assistant', 'coffee brewing temperature notes', vecToBlob(vec(0, 1)));
// A-dup: same text as A (should be de-duplicated), slightly lower similarity so A wins deterministically
insC.run('/p/s3.jsonl', 'proj', 's3', '2026-01-03', 'assistant', 'oauth-idp groups authorizer role mapping bug', vecToBlob(vec(0.9, 0.436)));
insS.run('/p/s1.jsonl', 'proj', 's1', 0, 0, 1, 'x', 'auth work');

const results = searchChunks(db, vec(1, 0), { k: 5, queryText: 'oauth-idp groups authorizer', recencyBoost: 0 });

test('hybrid search ranks the aligned+lexical chunk first', () => {
  assert.equal(results[0].session, 's1');
  assert.match(results[0].text, /oauth-idp/);
});

test('identical text is de-duplicated across sessions', () => {
  assert.equal(results.length, 2, 'A-dup removed, leaving A and B');
  assert.ok(!results.some(r => r.session === 's3'));
});

test('session title is attached to hits (and only where present)', () => {
  assert.equal(results.find(r => r.session === 's1').title, 'auth work');
  assert.equal(results.find(r => r.session === 's2').title, undefined);
});

test('project filter restricts the candidate set', () => {
  const none = searchChunks(db, vec(1, 0), { k: 5, project: 'nope', queryText: 'oauth-idp' });
  assert.equal(none.length, 0);
});

test('no cross-domain facet when all hits share one project', () => {
  assert.equal(results.facet, undefined);
});

test('cross-project facet reports per-project counts, largest first', () => {
  // same query vocabulary ("oauth-idp") from a different project → blends into the result set
  insC.run('/p/s4.jsonl', 'medical', 's4', '2026-01-04', 'assistant',
    'oauth-idp mentioned while auditing medical claims glosas', vecToBlob(vec(-0.5, 0.866)));
  const hits = searchChunks(db, vec(1, 0), { k: 5, queryText: 'oauth-idp groups authorizer', recencyBoost: 0 });
  assert.ok(hits.facet, 'facet present when hits span projects');
  assert.deepEqual(hits.facet.map(f => f.project), ['proj', 'medical'], 'sorted by hit count');
  assert.equal(hits.facet.find(f => f.project === 'proj').n, 2);
  assert.equal(hits.facet.find(f => f.project === 'medical').n, 1);
});

test('recentActivity: window filter, dedup, oldest→newest', () => {
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  insC.run('/r/a.jsonl', 'ra', 'r1', iso(2), 'assistant', 'newest note', null);
  insC.run('/r/a.jsonl', 'ra', 'r1', iso(5), 'user', 'older note', null);
  insC.run('/r/a.jsonl', 'ra', 'r1', iso(5), 'user', 'older note', null); // dup
  insC.run('/r/a.jsonl', 'ra', 'r1', iso(40), 'user', 'beyond the window', null);
  const rows = recentActivity(db, 'ra', { days: 30, limit: 10 });
  assert.deepEqual(rows.map(r => r.text), ['older note', 'newest note'], 'deduped, chronological, windowed');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
