// Unit tests for v0.8 automatic extraction: the compact digest builder (buildDistillInput), the
// defensive JSON-array parser for headless `claude -p` output (parseMemoriesJson), and the
// always.list matcher (isAlwaysKept). Dep-free by design: distill.mjs/always.mjs expose these as
// pure functions and never touch embed.mjs, server.mjs or the DB at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// store.mjs (a transitive import) reads these at module load — point it away from the real brain.
const dir = mkdtempSync(join(tmpdir(), 'brain-distill-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { buildDistillInput, parseMemoriesJson, formatOpenTodos, sessionRefs } = await import('../distill.mjs');
const { isAlwaysKept } = await import('../always.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// buildDistillInput
// ---------------------------------------------------------------------------
const row = (role, text) => ({ role, text });

test('buildDistillInput: title → LAST summary → first user → last user → actions, in order', () => {
  const rows = [
    row('user', 'first user question about the ledger'),
    row('assistant', 'assistant prose that must not be included'),
    row('summary', 'early partial recap'),
    row('user', 'later user follow-up about hash chains'),
    row('summary', 'final full recap of the session'),
    row('actions', 'Actions taken in this session:\nBash: npm test'),
  ];
  const input = buildDistillInput(rows, 'ledger hardening');
  const order = ['# Session: ledger hardening', 'final full recap', 'first user question',
    'later user follow-up', 'Actions taken in this session'];
  let prev = -1;
  for (const marker of order) {
    const at = input.indexOf(marker);
    assert.ok(at > prev, `"${marker}" present after the previous section (at ${at})`);
    prev = at;
  }
  assert.ok(!input.includes('early partial recap'), 'only the LAST (complete) compaction recap is used');
  assert.ok(!input.includes('assistant prose'), 'assistant turns stay out — the summary already condenses them');
});

test('buildDistillInput: a single user turn is not duplicated as "last"', () => {
  const input = buildDistillInput([row('user', 'the only user turn')], null);
  assert.equal(input.match(/the only user turn/g).length, 1);
  assert.ok(!input.includes('Last user message'));
});

test('buildDistillInput: caps — oversized sections are clipped, total stays within ~12k', () => {
  const rows = [
    row('summary', 'S'.repeat(50000)),
    row('user', 'U'.repeat(50000)),
    row('user', 'V'.repeat(50000)),
    row('actions', 'Actions taken in this session:\n' + 'Bash: x\n'.repeat(10000)),
  ];
  const input = buildDistillInput(rows, 'big one');
  assert.ok(input.length <= 12000, `hard cap respected (${input.length})`);
  assert.ok(input.includes('Actions taken in this session'),
    'per-section caps leave room for the actions trace at the end (a huge summary must not starve it)');
  assert.ok(input.includes('# Session: big one'), 'title survives');
});

test('formatOpenTodos: empty -> empty string; entries carry their id for supersedes', () => {
  assert.equal(formatOpenTodos([]), '');
  const s = formatOpenTodos([{ id: 42, title: 'wire the eval', content: 'memory-targeted   cases\npending' }]);
  assert.match(s, /#42 wire the eval/);
  assert.match(s, /memory-targeted cases pending/, 'content is flattened to one line');
  assert.match(s, /supersedes:<id>/, 'the closing instruction travels with the list');
});

// ---------------------------------------------------------------------------
// parseMemoriesJson
// ---------------------------------------------------------------------------
const good = { type: 'decision', title: 'Use WAL mode', content: 'Chosen for concurrent hook writes.' };

test('parseMemoriesJson: clean JSON array passes through', () => {
  const out = parseMemoriesJson(JSON.stringify([good]));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'decision');
  assert.equal(out[0].title, 'Use WAL mode');
});

test('parseMemoriesJson: fenced markdown around the array', () => {
  const out = parseMemoriesJson('```json\n' + JSON.stringify([good]) + '\n```');
  assert.equal(out.length, 1);
});

test('parseMemoriesJson: prose before and after the array', () => {
  const out = parseMemoriesJson('Here are the memories[] I extracted:\n\n' + JSON.stringify([good]) + '\n\nLet me know!');
  assert.equal(out.length, 1, 'a degenerate "[]" in the prose cannot shadow the real payload');
});

test('parseMemoriesJson: brackets inside strings do not break the scan', () => {
  const tricky = [{ type: 'bug', title: 'off-by-one in a[i]]', content: 'text with ] and [ inside' }];
  const out = parseMemoriesJson('Result: ' + JSON.stringify(tricky));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'off-by-one in a[i]]');
});

test('parseMemoriesJson: invalid items dropped, valid ones kept', () => {
  const out = parseMemoriesJson(JSON.stringify([
    good,
    { type: 'vibes', title: 't', content: 'c' },  // unknown type
    { type: 'fact', title: '  ', content: 'c' },  // blank title
    { type: 'fact', content: 'missing title' },
    'just a string',
    null,
    [1, 2],
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'decision');
});

test('parseMemoriesJson: not an array / no JSON at all -> []', () => {
  assert.deepEqual(parseMemoriesJson('{"type":"fact","title":"t","content":"c"}'), []);
  assert.deepEqual(parseMemoriesJson('no json here'), []);
  assert.deepEqual(parseMemoriesJson(''), []);
  assert.deepEqual(parseMemoriesJson(null), []);
});

test('parseMemoriesJson: optional fields validated, junk fields and bad values dropped', () => {
  const out = parseMemoriesJson(JSON.stringify([{
    ...good,
    confidence: 0.9,
    entities: ['brain-rag', 5, '  '],
    source_messages: ['a quote'],
    supersedes: '12',          // numeric string — coerced
    extra_field: 'junk',
  }, {
    ...good, title: 'second', confidence: 7, supersedes: 'nope',  // out-of-range / non-numeric — dropped
  }]));
  assert.equal(out[0].confidence, 0.9);
  assert.deepEqual(out[0].entities, ['brain-rag']);
  assert.deepEqual(out[0].source_messages, ['a quote']);
  assert.equal(out[0].supersedes, 12);
  assert.ok(!('extra_field' in out[0]), 'unknown keys never reach saveMemory');
  assert.ok(!('confidence' in out[1]), 'out-of-range confidence dropped, memory kept');
  assert.ok(!('supersedes' in out[1]), 'non-numeric supersedes dropped, memory kept');
});

// ---------------------------------------------------------------------------
// sessionRefs — the keys the already-distilled skip matches against source_session
// ---------------------------------------------------------------------------
test('sessionRefs: claude transcript (basename == session id) collapses to ONE key', () => {
  assert.deepEqual(sessionRefs({ path: '/x/abc-123.jsonl', session: 'abc-123' }), ['abc-123']);
});

test('sessionRefs: codex rollout exposes BOTH the bare uuid and the file basename', () => {
  // The MCP server records basename(transcript) as source_session; batch distill records the
  // bare session id. The skip must recognize either, or in-session-distilled Codex sessions
  // would be re-distilled (re-paying tokens).
  assert.deepEqual(
    sessionRefs({ path: '/x/rollout-2026-07-10T12-00-00-uuid-1.jsonl', session: 'uuid-1' }),
    ['uuid-1', 'rollout-2026-07-10T12-00-00-uuid-1']);
});

test('sessionRefs: no recorded session id -> just the basename', () => {
  assert.deepEqual(sessionRefs({ path: '/x/rollout-2026-07-10T12-00-00-uuid-1.jsonl', session: null }),
    ['rollout-2026-07-10T12-00-00-uuid-1']);
});

// ---------------------------------------------------------------------------
// isAlwaysKept
// ---------------------------------------------------------------------------
test('isAlwaysKept: the root itself and any subdir match', () => {
  const roots = ['/a/repo', '/b/other'];
  assert.equal(isAlwaysKept('/a/repo', roots), true);
  assert.equal(isAlwaysKept('/a/repo/src/deep/dir', roots), true);
  assert.equal(isAlwaysKept('/b/other', roots), true);
});

test('isAlwaysKept: a sibling sharing a prefix does NOT match', () => {
  assert.equal(isAlwaysKept('/a/repo-2', ['/a/repo']), false);
  assert.equal(isAlwaysKept('/a/repository', ['/a/repo']), false);
  assert.equal(isAlwaysKept('/a', ['/a/repo']), false, 'a parent of the root is not inside it');
});

test('isAlwaysKept: empty/absent inputs are false (opt-in defaults to NO)', () => {
  assert.equal(isAlwaysKept(null, ['/a/repo']), false);
  assert.equal(isAlwaysKept(undefined, ['/a/repo']), false);
  assert.equal(isAlwaysKept('/a/repo', []), false);
  assert.equal(isAlwaysKept('/a/repo', null), false);
});

test('isAlwaysKept: trailing slashes tolerated on either side', () => {
  assert.equal(isAlwaysKept('/a/repo/', ['/a/repo']), true);
  assert.equal(isAlwaysKept('/a/repo/sub', ['/a/repo/']), true);
});

// ---------------------------------------------------------------------------
// Issue #65: the SessionEnd hook recognises a kept session by id, not only by path
// ---------------------------------------------------------------------------
test('isKeptSession: exact path, or the same session id under another folder; unmarked → false', async () => {
  const { isKeptSession } = await import('../distill.mjs');
  const P = '/h/.claude/projects';
  const kept = [`${P}/-w-repo--claude-worktrees-gentle/618b1c43.jsonl`, '', `${P}/-w-repo/aaa.jsonl`];
  assert.equal(isKeptSession(kept, `${P}/-w-repo/aaa.jsonl`), true, 'exact path');
  assert.equal(isKeptSession(kept, `${P}/-w-repo/618b1c43.jsonl`), true, 'moved: matched by id');
  assert.equal(isKeptSession(kept, `${P}/-w-repo/zzz.jsonl`), false, 'not marked');
  assert.equal(isKeptSession([], `${P}/-w-repo/aaa.jsonl`), false);
});

test('findIndexedSession: exact path first, else the same session indexed under another path', async () => {
  const { findIndexedSession } = await import('../distill.mjs');
  const { openDb } = await import('../store.mjs');
  const db = openDb();
  const ins = db.prepare('INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at,title) VALUES(?,?,?,?,?,?,?,?)');
  const P = '/h/.claude/projects';
  ins.run(`${P}/-w-repo/618b1c43.jsonl`, 'repo', '618b1c43', 1, 1, 1, 'now', 'moved one');
  ins.run(`${P}/-w-repo/rollout-x.jsonl`, 'repo', null, 1, 1, 1, 'now', 'no session id recorded');
  ins.run(`${P}/-w-repo/a_b.jsonl`, 'repo', null, 1, 1, 1, 'now', 'underscore is literal');

  assert.equal(findIndexedSession(db, `${P}/-w-repo--claude-worktrees-x/618b1c43.jsonl`)?.title, 'moved one', 'by session id');
  assert.equal(findIndexedSession(db, `${P}/-w-old/rollout-x.jsonl`)?.title, 'no session id recorded', 'by file name');
  assert.equal(findIndexedSession(db, `${P}/-w-repo/618b1c43.jsonl`)?.path, `${P}/-w-repo/618b1c43.jsonl`, 'exact path');
  assert.equal(findIndexedSession(db, `${P}/-w-repo/axb.jsonl`), undefined, "'_' does not act as a LIKE wildcard");
  assert.equal(findIndexedSession(db, `${P}/-w-repo/nope.jsonl`), undefined);
});
