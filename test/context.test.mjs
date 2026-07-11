// Unit tests for the v0.9 context builder: buildContext (section order, budget clipping,
// sources footer), detectConflicts (same-type near-dup actives; supersedes and type
// boundaries), and shouldInject (the SessionStart hook's gate). Temp DB + hand-crafted
// NORMALIZED embeddings — no model load, no heavy deps (context.mjs is model-free by design).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-ctx-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { openDb, saveMemory } = await import('../store.mjs');
const { buildContext, detectConflicts, approxTokens, shouldInject } = await import('../context.mjs');

// 8-dim normalized vectors: cosine == dot, exact and easy to reason about.
const norm = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const e = (i) => { const v = new Array(8).fill(0); v[i] = 1; return v; };

const db = openDb();

test('approxTokens: chars/4, rounded up', () => {
  assert.equal(approxTokens('a'.repeat(40)), 10);
  assert.equal(approxTokens('abcde'), 2);
  assert.equal(approxTokens(''), 0);
});

// ---------------------------------------------------------------------------
// buildContext — ordering + sources footer
// ---------------------------------------------------------------------------
mkdirSync(join(dir, 'state'), { recursive: true });
writeFileSync(join(dir, 'state', 'ctxp.md'), '# ctxp\nNow: shipping v0.9 context builder.\nNext: eval faithfulness.\n');

// decisions: d0 gets superseded by d1 (must NOT appear); d2 is orthogonal to d1 (no conflict noise)
const d0 = saveMemory(db, { type: 'decision', project: 'ctxp', title: 'Old plan: 16 schemas', content: 'One table per memory type.' }, e(0));
const d1 = saveMemory(db, { type: 'decision', project: 'ctxp', title: 'One memories table', content: 'Types are tags, not schemas.', supersedes: d0.id }, e(1));
const d2 = saveMemory(db, { type: 'decision', project: 'ctxp', title: 'Eval gates everything', content: 'No retrieval change ships without the eval.' }, e(2));
const f1 = saveMemory(db, { type: 'fact', project: 'ctxp', title: 'Node floor is 22.5', content: 'node:sqlite needs >= 22.5.' }, e(3));
const t1 = saveMemory(db, { type: 'todo', project: 'ctxp', title: 'Wire the SessionStart hook', content: 'Print context only for repos with brain data.' }, e(4));

test('buildContext: sections in order, superseded memory excluded, ids+types+dates on every line', () => {
  const { text, sources } = buildContext(db, 'ctxp');
  const order = ['## State', '## Active decisions', '## Recent knowledge', '## Open TODOs', 'Sources: '];
  const idx = order.map(h => text.indexOf(h));
  assert.ok(idx.every(i => i >= 0), `all sections present: ${JSON.stringify(idx)}\n${text}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'sections appear in the specced order');
  assert.ok(!text.includes('## Potential conflicts'), 'orthogonal memories produce no conflicts section');
  assert.match(text, /Now: shipping v0\.9/, 'state note body included');
  assert.ok(!text.includes('Old plan: 16 schemas'), 'superseded decision excluded');
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(text.includes(`- #${d1.id} [decision] One memories table · ${today} — Types are tags`), 'memory line carries id + type + date');
  assert.ok(text.includes(`#${f1.id} [fact]`), 'non-decision knowledge listed');
  assert.ok(text.includes(`#${t1.id} [todo]`), 'open todo listed');
});

test('buildContext: sources footer cites the state file and every included memory id', () => {
  const { text, sources } = buildContext(db, 'ctxp');
  assert.equal(sources.stateFile, join(dir, 'state', 'ctxp.md'));
  assert.deepEqual(sources.memoryIds, [d1.id, d2.id, f1.id, t1.id].sort((a, b) => a - b));
  const footer = text.trim().split('\n').at(-1);
  assert.ok(footer.startsWith('Sources: state/ctxp.md · memories '), footer);
  for (const id of sources.memoryIds) assert.ok(footer.includes(`#${id}`), `footer cites #${id}`);
});

test('buildContext: decisions newest first, capped at 6', () => {
  const ids = [];
  for (let i = 0; i < 7; i++) {
    ids.push(saveMemory(db, { type: 'decision', project: 'capd', title: `Decision ${i}`, content: `Body ${i}.` }, e(i % 8)).id);
  }
  const { text, sources } = buildContext(db, 'capd');
  assert.equal(sources.memoryIds.length, 6, 'cap of ~6 decisions');
  assert.ok(!text.includes('Decision 0'), 'the oldest decision falls off');
  const first = text.split('\n').find(l => l.startsWith('- #'));
  assert.ok(first.includes('Decision 6'), 'newest decision listed first');
});

test('buildContext: empty project -> empty text, empty sources (caller decides the fallback)', () => {
  const { text, sources } = buildContext(db, 'no-such-project');
  assert.equal(text, '');
  assert.equal(sources.stateFile, null);
  assert.deepEqual(sources.memoryIds, []);
});

// ---------------------------------------------------------------------------
// buildContext — budget clipping (proportional, whole lines, headers + footer survive)
// ---------------------------------------------------------------------------
const stateLines = Array.from({ length: 30 }, (_, i) => `state line ${i} ${'x'.repeat(45)}`);
writeFileSync(join(dir, 'state', 'bigp.md'), stateLines.join('\n') + '\n');
for (let i = 0; i < 6; i++) {
  saveMemory(db, { type: 'fact', project: 'bigp', title: `Big fact ${i}`, content: `detail ${i} ${'y'.repeat(280)}` }, e(i % 8));
}

test('buildContext: budget clips whole lines proportionally, keeps headers and footer', () => {
  const full = buildContext(db, 'bigp', { budget: 100000 }).text;
  assert.ok(stateLines.every(l => full.includes(l)), 'a huge budget clips nothing');

  const budget = 150;
  const { text } = buildContext(db, 'bigp', { budget });
  assert.ok(approxTokens(text) <= budget, `within budget: ${approxTokens(text)} <= ${budget}`);
  assert.ok(text.includes('## State') && text.includes('## Recent knowledge'), 'headers always survive');
  assert.ok(text.includes('Sources: state/bigp.md'), 'footer always survives');
  assert.ok(text.length < full.length, 'something was actually clipped');
  // never mid-line: every clipped-output line must be a verbatim line of the unclipped render (or the … marker)
  const fullLines = new Set(full.split('\n'));
  for (const line of text.split('\n')) {
    assert.ok(line === '…' || fullLines.has(line), `line survives whole or not at all: "${line}"`);
  }
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------
const vA = norm([1, 0.1, 0, 0, 0, 0, 0, 0]);
const vB = norm([0.98, 0.2, 0, 0, 0, 0, 0, 0]); // cosine vs vA ≈ 0.997 — well above 0.88

test('detectConflicts: two same-type near-dup ACTIVE memories are a conflict (newer listed as a)', () => {
  const c1 = saveMemory(db, { type: 'decision', project: 'confp', title: 'Retry with backoff', content: 'Use exponential backoff on 429.' }, vA);
  const c2 = saveMemory(db, { type: 'decision', project: 'confp', title: 'Retry immediately', content: 'Retry 429 at once, no backoff.' }, vB);
  const out = detectConflicts(db, 'confp');
  assert.equal(out.length, 1);
  assert.equal(out[0].a.id, c2.id, 'newer memory is a');
  assert.equal(out[0].b.id, c1.id, 'older memory is b');
  assert.match(out[0].reason, /cosine 0\.9\d/, 'reason carries the measured similarity');
  const { text } = buildContext(db, 'confp');
  assert.ok(text.includes('## Potential conflicts (resolve via save_memories supersedes)'), 'surfaced in the context');
  assert.ok(text.includes(`#${c1.id}`) && text.includes(`#${c2.id}`), 'both sides cited');
});

test('detectConflicts: an explicit supersedes link between the pair is NOT a conflict', () => {
  const [pair] = detectConflicts(db, 'confp');
  db.prepare('UPDATE memories SET supersedes = ? WHERE id = ?').run(pair.b.id, pair.a.id);
  assert.equal(detectConflicts(db, 'confp').length, 0, 'linked pair skipped even while both are active');
  db.prepare('UPDATE memories SET supersedes = NULL WHERE id = ?').run(pair.a.id);
});

test('detectConflicts: superseding (retiring) one side dissolves the conflict', () => {
  const m1 = saveMemory(db, { type: 'decision', project: 'confr', title: 'Ship as cron', content: 'Run distill on a schedule.' }, vA);
  assert.equal(detectConflicts(db, 'confr').length, 0);
  const m2 = saveMemory(db, { type: 'decision', project: 'confr', title: 'Ship as hook', content: 'Run distill from SessionEnd.', supersedes: m1.id }, vB);
  assert.equal(detectConflicts(db, 'confr').length, 0, 'retired memory is no longer an active side');
  assert.ok(m2.superseded === m1.id);
});

test('detectConflicts: near-dup vectors of DIFFERENT types do not conflict', () => {
  saveMemory(db, { type: 'fact', project: 'confq', title: 'Aurora is the store', content: 'Data lives in Aurora.' }, vA);
  saveMemory(db, { type: 'architecture', project: 'confq', title: 'Aurora-backed design', content: 'The design centers on Aurora.' }, vB);
  assert.equal(detectConflicts(db, 'confq').length, 0);
});

test('detectConflicts: capped at 5 pairs', () => {
  for (let i = 0; i < 4; i++) {
    saveMemory(db, { type: 'fact', project: 'confs', title: `Near dup ${i}`, content: `Variant ${i}.` }, norm([1, 0.01 * i, 0, 0, 0, 0, 0, 0]));
  }
  assert.equal(detectConflicts(db, 'confs').length, 5, '4 near-dups = 6 pairs, capped at 5');
});

// ---------------------------------------------------------------------------
// shouldInject — the SessionStart hook's gate
// ---------------------------------------------------------------------------
test('shouldInject: false for unknown projects and missing names', () => {
  assert.equal(shouldInject(db, 'never-seen-repo'), false);
  assert.equal(shouldInject(db, null), false);
  assert.equal(shouldInject(db, ''), false);
});

test('shouldInject: true when the project has memories, chunks, or a state note', () => {
  assert.equal(shouldInject(db, 'ctxp'), true, 'memories + state note');
  db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)')
    .run('/p/x.jsonl', 'chunkonly', 'sx', '2026-07-01', 'assistant', 'indexed history only', null);
  assert.equal(shouldInject(db, 'chunkonly'), true, 'indexed chunks alone are brain data');
  writeFileSync(join(dir, 'state', 'stateonly.md'), 'Now: just a note.\n');
  assert.equal(shouldInject(db, 'stateonly'), true, 'a state note alone is brain data');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
