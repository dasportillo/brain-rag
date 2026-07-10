// Unit tests for two later improvements: the temporal VERSION SIGNAL in searchChunks (annotates
// near-duplicate results from different dates with outdatedBy/supersedes) and the project ALIAS
// helpers (canonicalProject / aliasMembers). Like store.test.mjs, this uses a temp DB with
// hand-crafted normalized embeddings — no model load. BRAIN_DB/BRAIN_DIR are set before importing
// store.mjs (both are read at module load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-improve-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { openDb, vecToBlob, searchChunks } = await import('../store.mjs');

// ---------------------------------------------------------------------------
// VERSION SIGNAL
// ---------------------------------------------------------------------------
// 4-dim NORMALIZED vectors so cosine == dot is exact and easy to reason about.
// Distinct subspaces keep the pairs from cross-contaminating each other.
const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const vOld    = norm([1, 0, 0, 0]);          // different-day pair, older
const vNew    = norm([0.98, 0.20, 0, 0]);    // near-dup of vOld (cosine ~0.98, well above VSIM 0.92)
const vUnrel  = norm([0, 0, 1, 0]);          // orthogonal to everything (cosine ~0)
const vSameA  = norm([0, 0, 0, 1]);          // same-day pair
const vSameB  = norm([0, 0.05, 0, 0.998]);   // near-dup of vSameA (cosine ~0.9987)

const vdb = openDb();
const insC = vdb.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
// Different-day near-dup pair (distinct text so dedup keeps both).
insC.run('/p/a.jsonl', 'vp', 'a', '2026-01-01', 'assistant', 'the plan, first draft', vecToBlob(vOld));
insC.run('/p/b.jsonl', 'vp', 'b', '2026-01-05', 'assistant', 'the plan, final draft', vecToBlob(vNew));
// Unrelated topic (orthogonal): must never be annotated.
insC.run('/p/c.jsonl', 'vp', 'c', '2026-01-03', 'assistant', 'a completely unrelated topic', vecToBlob(vUnrel));
// Same-day near-dup pair: near-dup but SAME date → must NOT be annotated.
insC.run('/p/d.jsonl', 'vp', 'd', '2026-02-02', 'assistant', 'same day note one', vecToBlob(vSameA));
insC.run('/p/e.jsonl', 'vp', 'e', '2026-02-02', 'assistant', 'same day note two', vecToBlob(vSameB));

// Pure-vector search (no queryText), recencyBoost 0 → score is exactly cosine; k high so all 5 return.
const vres = searchChunks(vdb, vOld, { k: 8, recencyBoost: 0 });
const bySession = (s) => vres.find((r) => r.session === s);

test('version signal: older near-dup on a different date is flagged outdatedBy the newer', () => {
  const older = bySession('a');
  assert.equal(older.outdatedBy, '2026-01-05', 'older row points at the newer date');
});

test('version signal: newer near-dup supersedes the older date', () => {
  const newer = bySession('b');
  assert.ok(Array.isArray(newer.supersedes), 'supersedes is an array');
  assert.ok(newer.supersedes.includes('2026-01-01'), 'supersedes contains the older date');
  assert.equal(newer.outdatedBy, undefined, 'the newest row is not itself outdated');
});

test('version signal: an unrelated (orthogonal) result is not annotated', () => {
  const unrel = bySession('c');
  assert.equal(unrel.outdatedBy, undefined);
  assert.equal(unrel.supersedes, undefined);
});

test('version signal: near-duplicates on the SAME date are not annotated', () => {
  const a = bySession('d');
  const b = bySession('e');
  assert.equal(a.outdatedBy, undefined);
  assert.equal(a.supersedes, undefined);
  assert.equal(b.outdatedBy, undefined);
  assert.equal(b.supersedes, undefined);
});

test('version signal: the internal _vec field never leaks to callers', () => {
  for (const r of vres) assert.ok(!('_vec' in r), `_vec absent on session ${r.session}`);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// PROJECT ALIASES
// ---------------------------------------------------------------------------
// ALIASES is captured once at module init from the BRAIN_ALIASES JSON file, so each scenario needs a
// FRESH module instance. We set BRAIN_ALIASES, write the file, then dynamic-import store.mjs with a
// unique query string — Node keys the ESM cache by full specifier, so each import is an isolated
// instance that re-reads the env. (This keeps the whole test in-process; no child process needed.)
async function loadStoreWithAliases(tag, aliasFileContents) {
  const adir = mkdtempSync(join(tmpdir(), 'brain-alias-'));
  process.env.BRAIN_DIR = adir;
  process.env.BRAIN_DB = join(adir, 'brain.db');
  if (aliasFileContents === null) {
    // Point at a path that does NOT exist → identity mapping (no aliasing).
    process.env.BRAIN_ALIASES = join(adir, 'nope.json');
  } else {
    const p = join(adir, 'aliases.json');
    writeFileSync(p, JSON.stringify(aliasFileContents));
    process.env.BRAIN_ALIASES = p;
  }
  const mod = await import(`../store.mjs?alias=${tag}`);
  return { mod, cleanup: () => rmSync(adir, { recursive: true, force: true }) };
}

test('aliases: a member fragment resolves to its canonical project', async () => {
  const { mod, cleanup } = await loadStoreWithAliases('member', {
    efy3: ['efy3-efy-experience', 'efy3-efy3-users'],
  });
  try {
    assert.equal(mod.canonicalProject('efy3-efy-experience'), 'efy3');
    assert.equal(mod.canonicalProject('efy3-efy3-users'), 'efy3');
    assert.equal(mod.canonicalProject('efy3'), 'efy3', 'the canonical maps to itself');
  } finally { cleanup(); }
});

test('aliases: an unaliased name maps to itself', async () => {
  const { mod, cleanup } = await loadStoreWithAliases('unaliased', {
    efy3: ['efy3-efy-experience'],
  });
  try {
    assert.equal(mod.canonicalProject('some-other-project'), 'some-other-project');
  } finally { cleanup(); }
});

test('aliases: aliasMembers returns the full set including the name itself', async () => {
  const { mod, cleanup } = await loadStoreWithAliases('members', {
    efy3: ['efy3-efy-experience', 'efy3-efy3-users'],
  });
  try {
    // Ask via a member fragment: expect canonical + all its members (incl. the queried name).
    const members = mod.aliasMembers('efy3-efy-experience');
    assert.deepEqual(
      new Set(members),
      new Set(['efy3', 'efy3-efy-experience', 'efy3-efy3-users']),
    );
    // Ask via the canonical: same full set.
    assert.deepEqual(new Set(mod.aliasMembers('efy3')), new Set(members));
  } finally { cleanup(); }
});

test('aliases: with NO alias file, mapping is identity', async () => {
  const { mod, cleanup } = await loadStoreWithAliases('none', null);
  try {
    assert.equal(mod.canonicalProject('efy3-efy-experience'), 'efy3-efy-experience');
    assert.deepEqual(mod.aliasMembers('efy3-efy-experience'), ['efy3-efy-experience']);
  } finally { cleanup(); }
});
