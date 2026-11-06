// opencode host: the SQLite session adapter, launching-agent detection, the comment-preserving
// config edit, and the generated commands. The fixture DB uses opencode 1.18's real schema (the
// columns the adapter reads) and payload shapes copied from real sessions.
import '../quiet.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  parseOpencodeSession, parseSession, listOpencodeSessions, listSessions, opencodePath,
  splitOpencodePath, isOpencodePath, sessionStat, sessionExists, sessionRefOf, sessionProject,
  adapterFor, findCurrentTranscript, hostAdapterName, isAncestorPid, ADAPTERS, OPENCODE_DB,
} from '../transcripts.mjs';
import { blankJsonc, addBrainMcp, removeBrainMcp, brainEntry, opencodeConfigFile, editOpencodeConfig } from '../opencode.mjs';
import { promptFiles, syncPrompts } from '../prompts.mjs';

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => dirs.forEach(d => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));

// --- fixture ---------------------------------------------------------------

function makeDb(dir) {
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
      directory text NOT NULL, title text NOT NULL, version text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
      time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE INDEX part_session_idx ON part (session_id);`);
  return { path, db };
}

let seq = 0;
const T0 = Date.parse('2026-09-17T14:00:00Z');
function addSession(db, { id, directory, title = 'Debugging the gate', parent = null, at = T0 }) {
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'p1', parent, 'slug', directory, title, '1.18.30', at, at);
}
function addMessage(db, sessionId, info, parts, at) {
  const id = `msg_${String(++seq).padStart(6, '0')}`;
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, sessionId, at, at, JSON.stringify({ ...info, time: { created: at } }));
  for (const p of parts) {
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`prt_${String(++seq).padStart(6, '0')}`, id, sessionId, at, at, JSON.stringify(p));
  }
  return id;
}

// One realistic session: a question, a tool-using answer with reasoning, an auto-compaction with
// its synthetic "continue" nudge, and a user-run tool echo (synthetic) that must not be indexed.
function seedMain(db, id = 'ses_main1', directory = '/Users/me/work/foo') {
  addSession(db, { id, directory });
  let t = T0;
  addMessage(db, id, { role: 'user', agent: 'build' }, [{ type: 'text', text: 'why does the gate reject fresh certificates?' }], t += 1000);
  addMessage(db, id, { role: 'assistant', mode: 'build', path: { cwd: directory } }, [
    { type: 'step-start' },
    { type: 'reasoning', text: 'internal chain of thought that must not be indexed' },
    { type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: '/Users/me/work/foo/gate.mjs' }, output: 'x' } },
    { type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'completed', input: { command: 'npm test', description: 'run tests' }, output: 'ok' } },
    { type: 'tool', tool: 'read', callID: 'c3', state: { status: 'completed', input: { filePath: '/Users/me/work/foo/gate.mjs' } } },
    { type: 'text', text: 'The gate compares local time against UTC; that is the bug.' },
    { type: 'step-finish', reason: 'stop' },
  ], t += 1000);
  addMessage(db, id, { role: 'user' }, [{ type: 'compaction', auto: true }], t += 1000);
  addMessage(db, id, { role: 'assistant', mode: 'compaction', agent: 'compaction', summary: true }, [
    { type: 'text', text: '## Objective\n- Fix the freshness gate timezone bug.' },
  ], t += 1000);
  addMessage(db, id, { role: 'user' }, [{ type: 'text', synthetic: true, text: 'Continue if you have next steps, or stop and ask for clarification.' }], t += 1000);
  addMessage(db, id, { role: 'user' }, [{ type: 'text', synthetic: true, text: 'The following tool was executed by the user' }], t += 1000);
  addMessage(db, id, { role: 'user' }, [{ type: 'text', text: 'ok, ship the fix' }], t += 1000);
  return t;
}

// --- parsing -----------------------------------------------------------------

test('parseOpencodeSession: roles, compaction summary, synthetic + reasoning dropped, actions trace', () => {
  const { path, db } = makeDb(tmp('oc-parse-'));
  seedMain(db);
  const p = opencodePath(path, 'ses_main1');
  const { turns, title, cwd } = parseOpencodeSession(p);

  assert.equal(title, 'Debugging the gate');
  assert.equal(cwd, '/Users/me/work/foo');
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'summary', 'user', 'actions']);
  assert.equal(turns[1].text, 'The gate compares local time against UTC; that is the bug.');
  assert.match(turns[2].text, /freshness gate timezone/);
  assert.ok(turns.every(t => t.session === 'ses_main1'));
  assert.equal(turns[0].ts, new Date(T0 + 1000).toISOString());
  const all = turns.map(t => t.text).join('\n');
  assert.ok(!all.includes('chain of thought'), 'reasoning is not indexed');
  assert.ok(!all.includes('Continue if you have next steps'), 'synthetic nudges are not indexed');
  assert.ok(!all.includes('executed by the user'), 'synthetic tool echoes are not indexed');

  const actions = turns.at(-1).text;
  assert.match(actions, /^Read: \/Users\/me\/work\/foo\/gate\.mjs$/m, 'lowercase tool capitalized, filePath picked up');
  assert.match(actions, /^Bash: npm test$/m);
  assert.equal(actions.match(/gate\.mjs/g).length, 1, 'duplicate actions collapse');
  assert.deepEqual(parseSession(p), { turns, title, cwd }, 'parseSession dispatches the virtual path to opencode');
});

test('parseOpencodeSession: placeholder titles become null; unknown ids and missing DBs yield nothing', () => {
  const dir = tmp('oc-title-');
  const { path, db } = makeDb(dir);
  addSession(db, { id: 'ses_untitled', directory: '/x', title: 'New session - 2026-09-17T13:51:50.321Z' });
  assert.equal(parseOpencodeSession(opencodePath(path, 'ses_untitled')).title, null);
  assert.deepEqual(parseOpencodeSession(opencodePath(path, 'ses_nope')).turns, []);
  assert.deepEqual(parseOpencodeSession(opencodePath(join(dir, 'gone.db'), 'ses_x')).turns, []);
});

// --- virtual paths + generic helpers ---------------------------------------------

test('virtual paths: split/detect/ref, and plain files are never mistaken for opencode', () => {
  const p = opencodePath('/h/.local/share/opencode/opencode.db', 'ses_f502a68ecffespDLFrPG3D306Z');
  assert.deepEqual(splitOpencodePath(p), { dbPath: '/h/.local/share/opencode/opencode.db', sessionId: 'ses_f502a68ecffespDLFrPG3D306Z' });
  assert.equal(isOpencodePath(p), true);
  assert.equal(adapterFor(p).name, 'opencode');
  assert.equal(sessionRefOf(p), 'ses_f502a68ecffespDLFrPG3D306Z');
  assert.equal(sessionRefOf('/h/.claude/projects/-x/abc-123.jsonl'), 'abc-123');
  assert.equal(isOpencodePath('/h/.claude/projects/-x/abc.jsonl'), false);
  assert.equal(isOpencodePath('/h/notes.db#readme'), false);
  assert.equal(ADAPTERS[0].name, 'opencode', 'opencode detects first: no file adapter may open "<db>#<id>"');
  assert.equal(ADAPTERS.find(a => a.name === 'opencode').root, OPENCODE_DB);
});

test('list/stat/exists/project: one row per session; stat moves when the session grows', () => {
  const dir = tmp('oc-list-');
  const { path, db } = makeDb(dir);
  const repo = join(dir, 'myrepo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const last = seedMain(db, 'ses_a', join(repo, 'src'));
  addSession(db, { id: 'ses_b', directory: '/elsewhere' });

  const listed = listOpencodeSessions(path);
  assert.deepEqual(listed.sort(), [opencodePath(path, 'ses_a'), opencodePath(path, 'ses_b')]);
  const a = opencodePath(path, 'ses_a');
  const before = sessionStat(a);
  assert.equal(before.mtimeMs, last);
  assert.ok(before.size > 0);
  assert.equal(sessionProject(a), 'myrepo', 'project = git repo of the recorded directory, without a parse');

  addMessage(db, 'ses_a', { role: 'assistant', mode: 'build' }, [{ type: 'text', text: 'done' }], last + 5000);
  listOpencodeSessions(path); // a fresh listing refreshes the cached stats (the MCP server is long-lived)
  const after = sessionStat(a);
  assert.equal(after.mtimeMs, last + 5000);
  assert.ok(after.size > before.size, 'ingest sees the session changed and re-indexes it');

  assert.equal(sessionExists(a), true);
  db.prepare("DELETE FROM session WHERE id = 'ses_a'").run();
  assert.equal(sessionExists(a), false, 'a deleted session is reported gone (ingest prunes it)');
  assert.equal(sessionExists(opencodePath(join(dir, 'gone.db'), 'ses_a')), false);
  assert.throws(() => sessionStat(opencodePath(path, 'ses_never')), { code: 'ENOENT' });
});

test('listOpencodeSessions: absent or foreign database → nothing (never a crash)', () => {
  const dir = tmp('oc-absent-');
  assert.deepEqual(listOpencodeSessions(join(dir, 'missing.db')), []);
  const foreign = join(dir, 'foreign.db');
  new DatabaseSync(foreign).exec('CREATE TABLE other (x int)');
  assert.deepEqual(listOpencodeSessions(foreign), []);
  assert.ok(Array.isArray(listSessions()), 'the real listing never throws either');
});

// --- the current session ---------------------------------------------------------

test('findCurrentTranscript: the launching agent wins in a shared cwd; subagent children never do', () => {
  const dir = tmp('oc-current-');
  const { path, db } = makeDb(dir);
  const cwd = '/Users/me/work/foo';
  seedMain(db, 'ses_mine', cwd);                                   // newest write: T0 + 7s
  addSession(db, { id: 'ses_child', directory: cwd, parent: 'ses_mine', at: T0 + 60000 }); // newer, but a subagent
  addSession(db, { id: 'ses_other', directory: '/Users/me/work/OTHER', at: T0 + 90000 });

  const claudeRoot = join(dir, 'claude');
  const claudeF = join(claudeRoot, cwd.replace(/[/_]/g, '-'), 'sess.jsonl');
  mkdirSync(join(claudeF, '..'), { recursive: true });
  writeFileSync(claudeF, '{}');
  const late = new Date(T0 + 30000);
  utimesSync(claudeF, late, late); // a parallel Claude session in the SAME repo, written after ours

  const base = { claudeRoot, codexRoot: join(dir, 'no-codex'), opencodeRoot: path };
  assert.equal(findCurrentTranscript(cwd, { ...base, host: 'opencode' }), opencodePath(path, 'ses_mine'),
    'from opencode: its own session, not the newer Claude transcript nor the subagent child');
  assert.equal(findCurrentTranscript(cwd, { ...base, host: 'claude-code' }), claudeF,
    'from Claude Code: its transcript, even with opencode active in the repo');
  assert.equal(findCurrentTranscript(cwd, { ...base, host: null }), claudeF, 'unknown host: plain recency within the cwd');
  assert.equal(findCurrentTranscript('/Users/me/work/OTHER', { ...base, host: 'opencode' }), opencodePath(path, 'ses_other'));
});

test('hostAdapterName: opencode only when OPENCODE_PID is a real ancestor; CLAUDECODE otherwise', () => {
  const chain = { 100: 50, 50: 7, 7: 1 }; // me(100) → npx(50) → opencode(7) → launchd
  const ppidOf = (p) => chain[p] ?? null;
  const isAnc = (pid) => isAncestorPid(pid, { start: 100, ppidOf });
  assert.equal(isAnc(7), true);
  assert.equal(isAnc(999), false);
  assert.equal(isAnc('nope'), false);
  assert.equal(hostAdapterName({ OPENCODE: '1', OPENCODE_PID: '7', CLAUDECODE: '1' }, { isAncestor: isAnc }), 'opencode');
  // Claude started from an opencode terminal inherits OPENCODE_PID, but opencode is not its ancestor
  assert.equal(hostAdapterName({ OPENCODE_PID: '999', CLAUDECODE: '1' }, { isAncestor: isAnc }), 'claude-code');
  assert.equal(hostAdapterName({}, { isAncestor: isAnc }), null);
  assert.equal(isAncestorPid(process.ppid), true, 'the real ps walk finds our own parent');
});

// --- config edit ------------------------------------------------------------------

const REAL_SHAPE = `{
  "$schema": "https://opencode.ai/config.json",
  // modelo local por defecto
  "model": "ollama/qwen3-8b-fast",
  "mcp": {
    "aws": {
      "type": "local",
      "command": ["uvx", "mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp"],
      /* el proxy firma con SigV4 */
      "environment": { "AWS_PROFILE": "smd", },
    },
  },
}
`;

test('addBrainMcp/removeBrainMcp: comments and trailing commas survive; the round trip is byte-exact', () => {
  const entry = brainEntry('brain-rag');
  const added = addBrainMcp(REAL_SHAPE, entry);
  assert.equal(added.changed, true);
  const parsed = JSON.parse(blankJsonc(added.text));
  assert.deepEqual(parsed.mcp.brain, { type: 'local', command: ['npx', '-y', 'brain-rag', 'serve'] });
  assert.ok(parsed.mcp.aws, 'the existing server is untouched');
  assert.match(added.text, /\/\/ modelo local por defecto/);
  assert.match(added.text, /\/\* el proxy firma con SigV4 \*\//);
  assert.equal(addBrainMcp(added.text, entry).changed, false, 'idempotent');
  assert.equal(removeBrainMcp(added.text).text, REAL_SHAPE, 'uninstall restores the file exactly');
  assert.equal(removeBrainMcp(REAL_SHAPE).changed, false);
});

test('addBrainMcp: empty file, no mcp key, and a user-owned brain entry', () => {
  const entry = brainEntry('brain-rag');
  assert.deepEqual(JSON.parse(addBrainMcp('', entry).text).mcp.brain, entry);
  const noMcp = addBrainMcp('{\n  // theme\n  "theme": "x"\n}\n', entry).text;
  assert.deepEqual(JSON.parse(blankJsonc(noMcp)).mcp.brain, entry);
  assert.match(noMcp, /\/\/ theme/);
  assert.deepEqual(JSON.parse(addBrainMcp('{}', entry).text), { mcp: { brain: entry } });
  const mine = '{"mcp":{"brain":{"type":"local","command":["node","/src/brain-rag/server.mjs"]}}}';
  assert.equal(addBrainMcp(mine, entry).changed, false, 'a checkout registration is never overwritten');
  // strings containing comment/comma lookalikes are not touched by the blanking
  const tricky = '{"url":"http://x/y,}", "note":"a // b", "mcp":{"brain":{"type":"local"},"z":{"type":"local"}}}';
  const removed = removeBrainMcp(tricky);
  assert.deepEqual(JSON.parse(removed.text), { url: 'http://x/y,}', note: 'a // b', mcp: { z: { type: 'local' } } });
  assert.throws(() => addBrainMcp('{"mcp": [1]}', entry), /not an object/);
});

test('editOpencodeConfig: prefers the existing jsonc, backs it up, writes only on change', () => {
  const dir = tmp('oc-cfg-');
  assert.equal(opencodeConfigFile(dir), join(dir, 'opencode.json'), 'nothing yet → opencode.json');
  writeFileSync(join(dir, 'opencode.jsonc'), REAL_SHAPE);
  const file = opencodeConfigFile(dir);
  assert.equal(file, join(dir, 'opencode.jsonc'));
  const r = editOpencodeConfig(file, (t) => addBrainMcp(t, brainEntry('brain-rag')));
  assert.equal(r.changed, true);
  assert.equal(readFileSync(r.backup, 'utf8'), REAL_SHAPE);
  assert.equal(editOpencodeConfig(file, (t) => addBrainMcp(t, brainEntry('brain-rag'))).changed, false);
  editOpencodeConfig(file, removeBrainMcp);
  assert.equal(readFileSync(file, 'utf8'), REAL_SHAPE);
});

// --- generated commands -----------------------------------------------------------

test('opencode commands: written only where opencode is installed, MCP-tool based, stamped', () => {
  const without = tmp('oc-home-none-');
  mkdirSync(join(without, '.claude', 'commands'), { recursive: true });
  syncPrompts({ home: without, name: 'brain-rag', mode: 'install' });
  assert.equal(existsSync(join(without, '.config', 'opencode', 'commands')), false, 'no opencode → no commands');

  const withOc = tmp('oc-home-');
  mkdirSync(join(withOc, '.config', 'opencode'), { recursive: true });
  const r = syncPrompts({ home: withOc, name: 'brain-rag', mode: 'install' });
  const cmd = (f) => join(withOc, '.config', 'opencode', 'commands', f);
  for (const f of ['brain.md', 'state.md', 'distill.md']) assert.ok(r.created.includes(cmd(f)), f);
  const brain = readFileSync(cmd('brain.md'), 'utf8');
  assert.match(brain, /^---\ndescription: /, 'opencode command frontmatter');
  assert.match(brain, /keep_session/);
  assert.ok(!brain.includes('npx -y'), 'calls the MCP tool, never a shell command');
  assert.match(brain, /<!-- brain-rag:prompt [0-9a-f]{12}/);
  assert.match(readFileSync(cmd('distill.md'), 'utf8'), /save_memories/);
  assert.match(brain, /`brain_keep_session`/, 'names the tool the way opencode exposes it');
  assert.match(readFileSync(cmd('distill.md'), 'utf8'), /brain_save_memories/);
  assert.match(readFileSync(cmd('state.md'), 'utf8'), /brain_get_state[\s\S]*brain_save_state/);
  const files = promptFiles({ home: withOc }).filter(f => f.host === 'opencode');
  assert.equal(files.length, 4, 'three commands + the plugin');
});
