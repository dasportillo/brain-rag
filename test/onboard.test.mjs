// Unit tests for `brain-rag onboard` (team ramp-up) and the concurrent distill batch it drives.
// Dep-free by design: onboard.mjs's helpers take injectable label/mtime functions, and
// distillBatch takes an injectable extractor + embedder — no claude spawn, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// store.mjs (a transitive import of distill.mjs) reads these at load — point it at a temp brain.
const dir = mkdtempSync(join(tmpdir(), 'brain-onboard-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { groupByProject, resolveSelection, estimateCost, planRun, EST_TOKENS } = await import('../onboard.mjs');
const { distillBatch, undistilledSessions, distillSession } = await import('../distill.mjs');
const { openDb } = await import('../store.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// groupByProject
// ---------------------------------------------------------------------------
const LABELS = {
  '/t/a1.jsonl': 'acme-api', '/t/a2.jsonl': 'acme-api', '/t/a3.jsonl': 'acme-api',
  '/t/w1.jsonl': 'acme-web', '/t/w2.jsonl': 'acme-web',
  '/t/p1.jsonl': 'my-side-project',
  '/t/x1.jsonl': null, // no label → 'unknown'
};
const MTIMES = { '/t/a1.jsonl': 10, '/t/a2.jsonl': 30, '/t/a3.jsonl': 20, '/t/w1.jsonl': 50, '/t/w2.jsonl': 40, '/t/p1.jsonl': 60, '/t/x1.jsonl': 5 };
const opts = { labelOf: (f) => LABELS[f], mtimeOf: (f) => MTIMES[f] };
const groups = groupByProject(Object.keys(LABELS), opts);

test('groupByProject: groups by label, most sessions first, tracks the newest mtime', () => {
  assert.deepEqual(groups.map(g => [g.project, g.files.length]),
    [['acme-api', 3], ['acme-web', 2], ['my-side-project', 1], ['unknown', 1]]);
  assert.equal(groups[0].newest, 30, 'newest mtime of the acme-api group');
  assert.equal(groups[1].newest, 50);
});

// ---------------------------------------------------------------------------
// resolveSelection — the privacy gate: only what is picked may reach the team
// ---------------------------------------------------------------------------
test('resolveSelection: numbers, names (case-insensitive), "all", and typos are reported', () => {
  assert.deepEqual(resolveSelection('1, 2', groups).groups.map(g => g.project), ['acme-api', 'acme-web']);
  assert.deepEqual(resolveSelection('ACME-WEB acme-api', groups).groups.map(g => g.project), ['acme-web', 'acme-api']);
  assert.deepEqual(resolveSelection('2,acme-web', groups).groups.map(g => g.project), ['acme-web'], 'de-duplicated');
  assert.equal(resolveSelection('all', groups).groups.length, 4);
  const bad = resolveSelection('acme-api, acme-mobile, 99', groups);
  assert.deepEqual(bad.groups.map(g => g.project), ['acme-api']);
  assert.deepEqual(bad.unknown, ['acme-mobile', '99'], 'out-of-range numbers and unknown names are surfaced, never ignored');
  assert.deepEqual(resolveSelection('', groups), { groups: [], unknown: [] });
});

// ---------------------------------------------------------------------------
// estimateCost — shown before any token is spent
// ---------------------------------------------------------------------------
test('estimateCost: per-session profile × price of the chosen model; unknown model priced as sonnet', () => {
  const s = estimateCost(100, 'sonnet');
  assert.equal(s.priced_as, 'sonnet');
  assert.ok(Math.abs(s.perSession - (EST_TOKENS.input * 2 + EST_TOKENS.output * 10) / 1e6) < 1e-9);
  assert.ok(Math.abs(s.total - s.perSession * 100) < 1e-9);
  assert.equal(estimateCost(1, 'claude-haiku-4-5').priced_as, 'haiku');
  assert.equal(estimateCost(1, 'opus').priced_as, 'opus');
  assert.equal(estimateCost(1, 'something-else').priced_as, 'sonnet');
  assert.ok(estimateCost(1, 'opus').perSession > estimateCost(1, 'sonnet').perSession);
  assert.equal(estimateCost(0).total, 0);
});

// ---------------------------------------------------------------------------
// planRun — idempotent: reruns only see what is left
// ---------------------------------------------------------------------------
test('planRun: skips kept + distilled transcripts, orders newest first, honours limit', () => {
  const sel = resolveSelection('acme-api,acme-web', groups).groups;
  const plan = planRun(sel, {
    keep: new Set(['/t/a1.jsonl']),
    done: new Set(['a2']), // source_session = basename(transcript) — already distilled
    mtimeOf: opts.mtimeOf,
  });
  assert.equal(plan.selected.length, 5);
  assert.deepEqual(plan.toKeep.sort(), ['/t/a2.jsonl', '/t/a3.jsonl', '/t/w1.jsonl', '/t/w2.jsonl']);
  assert.deepEqual(plan.toDistill, ['/t/w1.jsonl', '/t/w2.jsonl', '/t/a3.jsonl', '/t/a1.jsonl'], 'newest first, a2 excluded');
  assert.equal(plan.beyondLimit, 0);

  const capped = planRun(sel, { keep: new Set(), done: new Set(), mtimeOf: opts.mtimeOf, limit: 2 });
  assert.deepEqual(capped.toDistill, ['/t/w1.jsonl', '/t/w2.jsonl'], 'the CURRENT knowledge lands first on a partial run');
  assert.equal(capped.beyondLimit, 3);
});

test('planRun: personal projects left out of the selection never appear in the plan', () => {
  const sel = resolveSelection('acme-api', groups).groups;
  const plan = planRun(sel, { keep: new Set(), done: new Set(), mtimeOf: opts.mtimeOf });
  assert.ok(plan.selected.every(f => f.startsWith('/t/a')));
  assert.ok(!plan.toDistill.includes('/t/p1.jsonl'));
});

// ---------------------------------------------------------------------------
// distillBatch — concurrent, resumable, injectable extractor
// ---------------------------------------------------------------------------
const db = openDb();
const insSession = db.prepare('INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at,title) VALUES(?,?,?,?,?,?,?,?)');
const insChunk = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,NULL)');
const fakeEmbed = async (texts) => texts.map((_, i) => { const v = new Array(8).fill(0); v[i % 8] = 1; return v; });
const seed = (path, project, session, mtime, title) => {
  insSession.run(path, project, session, mtime, 100, 1, 'now', title);
  insChunk.run(path, project, session, null, 'user', `first user message of ${title}, long enough to be a chunk of text`);
  insChunk.run(path, project, session, null, 'summary', `Summary of ${title}: decided X because Y.`);
};
seed('/t/s1.jsonl', 'acme-api', 's1', 300, 'newest');
seed('/t/s2.jsonl', 'acme-api', 's2', 200, 'middle');
seed('/t/s3.jsonl', 'acme-web', 's3', 100, 'oldest');
seed('/t/s4.jsonl', 'my-side-project', 's4', 400, 'personal');

test('undistilledSessions: newest first, restricted to the given paths, skipping distilled ones', async () => {
  const rows = undistilledSessions(db, { paths: new Set(['/t/s1.jsonl', '/t/s2.jsonl', '/t/s3.jsonl']) });
  assert.deepEqual(rows.map(r => r.session), ['s1', 's2', 's3'], 'personal s4 excluded by paths; ordered by mtime desc');

  const run = async (prompt) => {
    assert.ok(prompt.includes('SESSION DIGEST'), 'the headless prompt wraps the digest');
    return JSON.stringify({ type: 'result', result: '[{"type":"decision","title":"Keep X","content":"decided X because Y"}]' });
  };
  const r = await distillSession(db, rows[1], { run, embed: fakeEmbed });
  assert.equal(r.count, 1);
  assert.match(r.lines[0], /created \[decision\] Keep X/);

  const left = undistilledSessions(db, { paths: new Set(['/t/s1.jsonl', '/t/s2.jsonl', '/t/s3.jsonl']) });
  assert.deepEqual(left.map(r => r.session), ['s1', 's3'], 's2 produced memories → skipped on the next run (resumable)');
});

test('distillBatch: bounded concurrency, per-session results, failures counted but never fatal', async () => {
  const rows = undistilledSessions(db, { paths: new Set(['/t/s1.jsonl', '/t/s3.jsonl', '/t/s4.jsonl']) });
  assert.equal(rows.length, 3);
  let inFlight = 0, peak = 0;
  const run = async (prompt, { model }) => {
    assert.equal(model, 'sonnet', 'model flag is passed through to the extractor');
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    if (prompt.includes('oldest')) throw new Error('boom');
    if (prompt.includes('personal')) return '[]';
    return '[{"type":"fact","title":"A","content":"a"},{"type":"todo","title":"B","content":"b"}]';
  };
  const seen = [];
  const totals = await distillBatch(db, rows, {
    concurrency: 2, model: 'sonnet', run, embed: fakeEmbed,
    onResult: (row, res) => seen.push([row.session, res.error ? 'error' : res.count]),
  });
  assert.equal(peak, 2, 'never more than `concurrency` extractions at once');
  assert.deepEqual(totals, { done: 2, failed: 1, memories: 2 });
  assert.deepEqual(Object.fromEntries(seen), { s1: 2, s3: 'error', s4: 0 });
  // The failed session is still undistilled → retried on the next run.
  assert.deepEqual(undistilledSessions(db, { paths: new Set(['/t/s3.jsonl']) }).map(r => r.session), ['s3']);
});

test('distillBatch: an empty batch is a no-op', async () => {
  assert.deepEqual(await distillBatch(db, [], { run: async () => { throw new Error('must not run'); } }),
    { done: 0, failed: 0, memories: 0 });
});
