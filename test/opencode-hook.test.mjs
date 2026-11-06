// opencode automation: the plugin (loaded for real, spawning a recorder instead of brain-rag), the
// keep policy, the idle → ingest → quiet → distill flow, the ingest lock, the extractor's output
// parsing, and the AGENTS.md block. No model, no embedder, no real keep.list.
import '../quiet.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => dirs.forEach(d => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));

// Every module reads BRAIN_DIR at load: point it at a throwaway dir BEFORE importing anything.
process.env.BRAIN_DIR = tmp('oc-hook-brain-');
const {
  parseOpencodeRun, shouldDistill, opencodeDistillSettings, EXTRACTOR_CONFIG, ingestLocked, start, idle,
  DEFAULT_QUIET_MIN,
} = await import('../opencode-hook.mjs');
const { opencodePath } = await import('../transcripts.mjs');
const { opencodePluginBody, stamp } = await import('../prompts.mjs');
const { upsertAgentsBlock, removeAgentsBlock, editAgentsFile, AGENTS_START, AGENTS_END } = await import('../opencode.mjs');

// --- extractor output --------------------------------------------------------------

test('parseOpencodeRun: joins the text parts and finds the session id (real event shapes)', () => {
  const lines = [
    { type: 'step_start', sessionID: 'ses_x1', part: { type: 'step-start', sessionID: 'ses_x1' } },
    { type: 'text', sessionID: 'ses_x1', part: { type: 'text', text: '[{"type":"decision",' } },
    { type: 'tool_use', sessionID: 'ses_x1', part: { type: 'tool', tool: 'read' } },
    { type: 'text', sessionID: 'ses_x1', part: { type: 'text', text: '"title":"x"}]' } },
    { type: 'step_finish', sessionID: 'ses_x1', part: { type: 'step-finish', reason: 'stop' } },
  ].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n';
  assert.deepEqual(parseOpencodeRun(lines), { sessionId: 'ses_x1', text: '[{"type":"decision",\n"title":"x"}]' });
  assert.deepEqual(parseOpencodeRun(''), { sessionId: null, text: '' });
});

test('extractor config: every tool denied and no second brain server', () => {
  const c = JSON.parse(EXTRACTOR_CONFIG);
  assert.deepEqual(c.permission, { '*': 'deny' });
  assert.equal(c.mcp.brain.enabled, false);
});

test('distill settings: on by default after 10 quiet minutes; config overrides', () => {
  assert.deepEqual(opencodeDistillSettings({}), { enabled: true, quietMs: DEFAULT_QUIET_MIN * 60_000, model: null });
  assert.deepEqual(opencodeDistillSettings({ opencodeDistill: false, opencodeDistillQuietMinutes: 2, opencodeDistillModel: 'ollama/qwen3:8b' }),
    { enabled: false, quietMs: 120_000, model: 'ollama/qwen3:8b' });
  assert.equal(opencodeDistillSettings({ opencodeDistillQuietMinutes: -1 }).quietMs, DEFAULT_QUIET_MIN * 60_000);
});

test('shouldDistill: only the newest waiter, and only when the session grew since the last distill', () => {
  assert.equal(shouldDistill({ myStamp: 'a', currentStamp: 'a', mtimeMs: 5, distilledMtimeMs: null }), true);
  assert.equal(shouldDistill({ myStamp: 'a', currentStamp: 'b', mtimeMs: 5, distilledMtimeMs: null }), false, 'newer activity owns it');
  assert.equal(shouldDistill({ myStamp: 'a', currentStamp: 'a', mtimeMs: 5, distilledMtimeMs: 5 }), false, 'nothing new');
  assert.equal(shouldDistill({ myStamp: 'a', currentStamp: 'a', mtimeMs: 9, distilledMtimeMs: 5 }), true, 'resumed and grew');
});

// --- ingest lock ---------------------------------------------------------------------

test('ingestLocked: a live holder queues the run; the holder loops once more; stale locks are taken over', () => {
  const dir = tmp('oc-lock-');
  writeFileSync(join(dir, 'ingest.lock'), String(process.pid)); // a live holder (us)
  let calls = 0;
  assert.equal(ingestLocked({ dir, run: () => calls++ }), 'queued');
  assert.equal(calls, 0);
  assert.ok(existsSync(join(dir, 'ingest.pending')));

  rmSync(join(dir, 'ingest.lock'));
  // pending is already set → the holder runs, sees no new pending, stops; a run that re-flags
  // pending (another idle arrived mid-ingest) makes it loop exactly once more
  let n = 0;
  assert.equal(ingestLocked({ dir, run: () => { if (n++ === 0) writeFileSync(join(dir, 'ingest.pending'), '1'); } }), 'ran 2');
  assert.ok(!existsSync(join(dir, 'ingest.lock')) && !existsSync(join(dir, 'ingest.pending')));

  writeFileSync(join(dir, 'ingest.lock'), '999999'); // a crashed run's lock
  assert.equal(ingestLocked({ dir, run: () => {} }), 'ran 1');
});

// --- keep policy + idle flow -----------------------------------------------------------

function fakeDb(dir, sessions) {
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
  for (const s of sessions) db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)').run(s.id, 'p', s.parent ?? null, 's', s.dir, 't', '1', s.at ?? 1000, s.at ?? 1000);
  return { path, db };
}

test('start: same precedence as mark-keep; writes the virtual path once', () => {
  const dir = tmp('oc-start-');
  const keepFile = join(dir, 'keep.list');
  const dbPath = join(dir, 'opencode.db');
  const base = { dbPath, keepFile, always: [], never: [], defaultOn: false, env: undefined };
  assert.deepEqual(start('ses_a', '/w/foo', base), { keep: false, reason: 'opt-in' });
  assert.ok(!existsSync(keepFile));
  const r = start('ses_a', '/w/foo', { ...base, defaultOn: true });
  assert.equal(r.reason, 'default');
  start('ses_a', '/w/foo', { ...base, defaultOn: true });
  assert.equal(readFileSync(keepFile, 'utf8'), opencodePath(dbPath, 'ses_a') + '\n', 'idempotent');
  assert.equal(start('ses_b', '/w/foo/sub', { ...base, defaultOn: true, never: ['/w/foo'] }).reason, 'never.list');
  assert.equal(start('ses_b', '/w/foo', { ...base, env: '0', defaultOn: true }).reason, 'BRAIN=0');
  assert.equal(start('ses_b', '/w/bar', { ...base, always: ['/w/bar'] }).reason, 'always.list');
});

test('idle: keeps by policy, ingests, waits, distills once — and again only after the session grows', async () => {
  const dir = tmp('oc-idle-');
  const { path: dbPath, db } = fakeDb(dir, [{ id: 'ses_main', dir: '/w/foo' }, { id: 'ses_kid', dir: '/w/foo', parent: 'ses_main' }]);
  const keepFile = join(dir, 'keep.list');
  const stateDir = join(dir, 'state');
  const ingests = [], distills = [];
  const opts = {
    dbPath, keepFile, stateDir, policy: { always: [], never: [], defaultOn: true, env: undefined },
    ingest: () => { ingests.push(1); return 'ran 1'; },
    distill: async (id, path) => { distills.push([id, path]); },
    sleep: async () => {}, settings: { enabled: true, quietMs: 0, model: null },
  };

  // idle arrives WITHOUT a directory (a resumed session): read from the DB, policy applied
  assert.deepEqual(await idle('ses_main', '', opts), { kept: true, distilled: true });
  assert.equal(readFileSync(keepFile, 'utf8').trim(), opencodePath(dbPath, 'ses_main'));
  assert.deepEqual(distills, [['ses_main', opencodePath(dbPath, 'ses_main')]]);
  assert.equal(ingests.length, 2, 'one ingest on idle, one final before distilling');

  // idle again with no new activity: ingest yes, distill no
  assert.deepEqual(await idle('ses_main', '/w/foo', opts), { kept: true, distilled: false });
  assert.equal(distills.length, 1);

  // the session grows (resumed later) → distilled again
  db.prepare('UPDATE session SET time_updated = 999999 WHERE id = ?').run('ses_main');
  assert.deepEqual(await idle('ses_main', '/w/foo', opts), { kept: true, distilled: true });
  assert.equal(distills.length, 2);

  // a newer idle arriving during the quiet wait wins: the older waiter stands down
  db.prepare('UPDATE session SET time_updated = 9999999 WHERE id = ?').run('ses_main');
  const raced = await idle('ses_main', '/w/foo', { ...opts, sleep: async () => writeFileSync(join(stateDir, 'ses_main.idle'), 'newer') });
  assert.deepEqual(raced, { kept: true, distilled: false });

  // subagent children are never kept; opted-out sessions are left alone
  assert.equal(await idle('ses_kid', '/w/foo', opts), undefined);
  assert.deepEqual(await idle('ses_main2', '/w/x', { ...opts, policy: { ...opts.policy, defaultOn: false } }), { kept: false });
  // distillation off: ingest only
  writeFileSync(keepFile, '');
  assert.deepEqual(await idle('ses_main', '/w/foo', { ...opts, settings: { enabled: false } }), { kept: true, distilled: false });
});

// --- the plugin, loaded for real ----------------------------------------------------------

test('plugin: created → start <id> <dir>; idle → idle <id> <dir>; children ignored; never throws', async () => {
  const dir = tmp('oc-plugin-');
  const rec = join(dir, 'calls.log');
  writeFileSync(join(dir, 'record.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(rec)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  const pluginFile = join(dir, 'brain-rag.js');
  writeFileSync(pluginFile, stamp(opencodePluginBody('brain-rag'), 'js'));
  process.env.BRAIN_RAG_BIN = `${process.execPath} ${join(dir, 'record.mjs')}`;
  try {
    const mod = await import(pathToFileURL(pluginFile).href);
    const hooks = await mod.BrainRag({ directory: '/w/foo' });
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1', directory: '/w/foo' } } } });
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_kid', directory: '/w/foo', parentID: 'ses_1' } } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_other' } } });
    await hooks.event({ event: { type: 'message.updated', properties: {} } });
    await hooks.event({ event: null }); // malformed: swallowed
    for (let i = 0; i < 50 && (!existsSync(rec) || readFileSync(rec, 'utf8').trim().split('\n').length < 3); i++) await new Promise(r => setTimeout(r, 100));
    const calls = readFileSync(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l)).sort((a, b) => a.join().localeCompare(b.join()));
    assert.deepEqual(calls, [
      ['opencode', 'idle', 'ses_1', '/w/foo'],
      ['opencode', 'idle', 'ses_other', ''],
      ['opencode', 'start', 'ses_1', '/w/foo'],
    ]);
    assert.ok(existsSync(join(process.env.BRAIN_DIR, 'opencode.log')), 'children write to the brain log');
  } finally { delete process.env.BRAIN_RAG_BIN; }
});

// --- AGENTS.md ---------------------------------------------------------------------------

test('AGENTS.md: the managed block is added, refreshed and removed without touching the rest', () => {
  const mine = '# My rules\n\nAlways answer in Spanish.\n';
  const added = upsertAgentsBlock(mine);
  assert.ok(added.text.startsWith(mine.trimEnd()));
  assert.ok(added.text.includes(AGENTS_START) && added.text.includes(AGENTS_END));
  assert.match(added.text, /brain_search_context/);
  assert.equal(upsertAgentsBlock(added.text).changed, false, 'idempotent');
  const refreshed = upsertAgentsBlock(added.text.replace('brain_search_context', 'OLD_NAME'));
  assert.equal(refreshed.text, added.text, 'an outdated block is replaced in place');
  assert.equal(removeAgentsBlock(added.text).text, mine, 'uninstall restores the user file');
  assert.equal(removeAgentsBlock(mine).changed, false);

  const dir = tmp('oc-agents-');
  const file = join(dir, 'AGENTS.md');
  editAgentsFile(file, (t) => upsertAgentsBlock(t));
  assert.ok(readFileSync(file, 'utf8').startsWith(AGENTS_START), 'created when absent');
  const r = editAgentsFile(file, removeAgentsBlock);
  assert.equal(r.removed, true);
  assert.ok(!existsSync(file), 'a file that only held our block is deleted on uninstall');
});
