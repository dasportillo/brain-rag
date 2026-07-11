// Unit tests for the parse/redact/chunk layer. Model-free (no embeddings) so `node --test` is fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  redact, chunkText, projectFromPath, parseTranscript, gitRootName,
  parseCodexRollout, parseSession, isCodexRollout, codexHeadCwd, findCurrentTranscript,
  ADAPTERS, registerAdapter, CLAUDE_PROJECTS, CODEX_SESSIONS,
} from '../transcripts.mjs';

test('redact scrubs known secret shapes', () => {
  assert.match(redact('h eyJabcdefgh.ijklmnop.qrstuvwx z'), /\[JWT_REDACTED\]/);
  assert.match(redact('AKIAABCDEFGHIJKLMNOP'), /\[AWS_KEY_REDACTED\]/);
  assert.match(redact('key AIza' + 'a'.repeat(35)), /\[GOOGLE_KEY_REDACTED\]/);
  assert.match(redact('sk-proj-' + 'A'.repeat(20)), /\[API_KEY_REDACTED\]/);
  assert.match(redact('gho_' + 'A'.repeat(36)), /\[GH_TOKEN_REDACTED\]/);
  assert.match(redact('DB_PASSWORD=hunter2secret'), /\[SECRET_REDACTED\]/);
  assert.match(redact('postgres://user:p4ssword@host/db'), /:\[SECRET_REDACTED\]@/);
});

test('redact leaves prose and near-misses intact', () => {
  assert.equal(redact('the password reset flow sends a token'), 'the password reset flow sends a token');
  assert.equal(redact('tokenizer=notasecret'), 'tokenizer=notasecret');
});

test('chunkText: short text stays one chunk', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world']);
});

test('chunkText: long text splits into overlapping windows', () => {
  const text = 'x'.repeat(4000);
  const chunks = chunkText(text, 1800, 200);
  assert.ok(chunks.length >= 2, 'splits');
  for (const c of chunks) assert.ok(c.length <= 1800, 'window size respected');
  assert.equal(chunks[0].slice(-200), chunks[1].slice(0, 200), 'windows overlap by 200');
});

test('projectFromPath strips the dashified user/project prefix', () => {
  const p = '/x/.claude/projects/-Users-me-project-my-project/s.jsonl';
  assert.equal(projectFromPath(p), 'my-project');
});

test('gitRootName names a project by its git repo, stable across subdirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-repo-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'src', 'domains'), { recursive: true });
  assert.equal(gitRootName(dir), basename(dir), 'repo root → repo name');
  assert.equal(gitRootName(join(dir, 'src', 'domains')), basename(dir), 'deep subdir maps back to the repo');
  rmSync(dir, { recursive: true, force: true });
});

test('gitRootName falls back to the folder name when not in a repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-norepo-'));
  assert.equal(gitRootName(join(dir, 'sub')), 'sub');
  assert.equal(gitRootName(null), null, 'no cwd → null (caller uses the path fallback)');
  rmSync(dir, { recursive: true, force: true });
});

test('parseTranscript returns the session cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cwd-'));
  const f = join(dir, 's.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'user', cwd: '/Users/me/project/foo',
    message: { role: 'user', content: 'hello there, a real user turn' }, timestamp: '2026-01-01', sessionId: 'z' }));
  assert.equal(parseTranscript(f).cwd, '/Users/me/project/foo');
  rmSync(dir, { recursive: true, force: true });
});

// --- Codex rollouts -------------------------------------------------------

// A minimal but realistic rollout: session_meta first line, harness-injected user items
// (developer role, AGENTS.md dump, environment context, turn_aborted), real conversation,
// event_msg duplicates (must NOT double-index), tool calls, and a compaction recap.
function codexFixtureLines(cwd = '/Users/me/work/foo') {
  return [
    { timestamp: '2026-07-01T10:00:00Z', type: 'session_meta', payload: { session_id: 'sess-1', id: 'sess-1', cwd, originator: 'codex-tui', base_instructions: { text: 'You are Codex…' } } },
    { timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\nsandbox stuff' }] } },
    { timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/me/work/foo\nrouting rules' }] } },
    { timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd etc' }] } },
    { timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>' }] } },
    { timestamp: '2026-07-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'why did these tariffs land in the VCO audit, which rules fired?' }] } },
    { timestamp: '2026-07-01T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'why did these tariffs land in the VCO audit, which rules fired?' } },
    { timestamp: '2026-07-01T10:00:03Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA…' } },
    { timestamp: '2026-07-01T10:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg -n auditoria jobs -S"}', call_id: 'c1' } },
    { timestamp: '2026-07-01T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'jobs/x.py:12 …' } },
    { timestamp: '2026-07-01T10:00:06Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"sed -n 1,10p x"})', call_id: 'c2' } },
    { timestamp: '2026-07-01T10:00:07Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the MONTOS_FIJOS rule forces the audit flag for that modality' }], phase: 'commentary' } },
    { timestamp: '2026-07-01T10:00:07Z', type: 'event_msg', payload: { type: 'agent_message', message: 'the MONTOS_FIJOS rule forces the audit flag for that modality' } },
    { timestamp: '2026-07-01T10:00:08Z', type: 'compacted', payload: { message: 'Recap: we traced the audit flag to blocking rules.', replacement_history: [] } },
    { timestamp: '2026-07-01T10:00:09Z', type: 'compacted', payload: { message: '', replacement_history: [] } },
  ].map(o => JSON.stringify(o)).join('\n');
}

test('parseCodexRollout: cwd, roles, noise drop, no event_msg duplication, actions, compaction summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-codex-'));
  const f = join(dir, 'rollout-2026-07-01T10-00-00-sess-1.jsonl');
  writeFileSync(f, codexFixtureLines());

  const { turns, title, cwd } = parseCodexRollout(f);
  assert.equal(cwd, '/Users/me/work/foo');
  assert.equal(title, null, 'fixture session is not in the session index');
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'summary', 'actions'],
    'developer/harness/noise items dropped, empty compaction dropped');

  const user = turns.find(t => t.role === 'user');
  assert.match(user.text, /VCO audit/);
  assert.equal(user.session, 'sess-1');
  assert.equal(turns.filter(t => t.text.includes('VCO audit')).length, 1, 'event_msg duplicates are not indexed');

  const actions = turns.find(t => t.role === 'actions').text;
  assert.match(actions, /exec_command: rg -n auditoria jobs -S/, 'function_call arguments unpacked (cmd)');
  assert.match(actions, /exec: const r = await tools\.exec_command/, 'custom_tool_call input traced');

  assert.match(turns.find(t => t.role === 'summary').text, /Recap: we traced/);
  rmSync(dir, { recursive: true, force: true });
});

// --- Adapter registry -------------------------------------------------------

test('adapter registry: ships the two real adapters with the documented shape', () => {
  const byName = Object.fromEntries(ADAPTERS.map(a => [a.name, a]));
  assert.equal(byName['claude-code'].root, CLAUDE_PROJECTS);
  assert.equal(byName['codex'].root, CODEX_SESSIONS);
  for (const a of ADAPTERS) {
    assert.equal(typeof a.detect, 'function', `${a.name}.detect`);
    assert.equal(typeof a.parse, 'function', `${a.name}.parse`);
    assert.equal(typeof a.currentSessionCwdMatch, 'function', `${a.name}.currentSessionCwdMatch`);
  }
});

test('adapter registry: a registered adapter is dispatched by parseSession and findCurrentTranscript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-registry-'));
  const fakeRoot = join(dir, 'fake-agent-sessions');
  mkdirSync(fakeRoot, { recursive: true });
  const fakeFile = join(fakeRoot, 'chat-1.jsonl');
  // no sessionId/parentUuid and no session_meta → neither real adapter claims it
  writeFileSync(fakeFile, JSON.stringify({ format: 'fake-agent', dir: '/Users/me/work/foo', text: 'hi' }));

  const fake = registerAdapter({
    name: 'fake-agent',
    root: fakeRoot,
    detect: (f) => f.endsWith('.jsonl') && f.startsWith(fakeRoot),
    parse: () => ({ turns: [{ role: 'user', text: 'from the fake adapter', ts: null, session: 'f-1' }], title: 'fake title', cwd: '/Users/me/work/foo' }),
    currentSessionCwdMatch: (f, cwd) => cwd === '/Users/me/work/foo',
  });
  try {
    // parseSession dispatches through the registry, not a hardcoded if/else
    const parsed = parseSession(fakeFile);
    assert.equal(parsed.title, 'fake title');
    assert.equal(parsed.cwd, '/Users/me/work/foo');
    // …and the real formats still win their own files (specificity order intact)
    const codex = join(dir, 'rollout.jsonl');
    writeFileSync(codex, codexFixtureLines('/Users/me/work/bar'));
    assert.equal(parseSession(codex).cwd, '/Users/me/work/bar');

    // findCurrentTranscript surfaces the fake adapter's cwd-matched file with no built-in candidates
    const opts = { claudeRoot: join(dir, 'no-claude'), codexRoot: join(dir, 'no-codex') };
    assert.equal(findCurrentTranscript('/Users/me/work/foo', opts), fakeFile);
    // …and joins the pure-recency fallback when nothing matches the cwd
    assert.equal(findCurrentTranscript('/Users/elsewhere', opts), fakeFile);
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(fake), 1); // never leak the fake into other tests
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSession dispatches by content: rollout → codex parser, transcript → claude parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-dispatch-'));
  const codex = join(dir, 'rollout.jsonl');
  writeFileSync(codex, codexFixtureLines());
  const claude = join(dir, 'claude.jsonl');
  writeFileSync(claude, JSON.stringify({ type: 'user', cwd: '/Users/me/project/bar',
    message: { role: 'user', content: 'hello there, a real user turn' }, timestamp: '2026-01-01', sessionId: 'z' }));

  assert.equal(isCodexRollout(codex), true);
  assert.equal(isCodexRollout(claude), false);
  assert.equal(parseSession(codex).cwd, '/Users/me/work/foo');
  assert.equal(parseSession(claude).cwd, '/Users/me/project/bar');
  assert.equal(codexHeadCwd(codex), '/Users/me/work/foo');
  rmSync(dir, { recursive: true, force: true });
});

test('findCurrentTranscript: newest across both stores, cwd-matched codex preferred', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-find-'));
  const cwd = '/Users/me/work/foo';
  const claudeRoot = join(dir, 'claude-projects');
  const codexRoot = join(dir, 'codex-sessions');
  const projDir = join(claudeRoot, cwd.replace(/[/_]/g, '-'));
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(codexRoot, '2026', '07', '01'), { recursive: true });

  const claudeF = join(projDir, 'sess.jsonl');
  writeFileSync(claudeF, '{}');
  const codexMatch = join(codexRoot, '2026', '07', '01', 'rollout-a.jsonl');
  writeFileSync(codexMatch, codexFixtureLines(cwd));
  const codexOther = join(codexRoot, '2026', '07', '01', 'rollout-b.jsonl');
  writeFileSync(codexOther, codexFixtureLines('/Users/me/work/OTHER'));

  const t = (s) => new Date(`2026-07-01T10:0${s}:00Z`);
  utimesSync(claudeF, t(1), t(1));
  utimesSync(codexMatch, t(2), t(2));
  utimesSync(codexOther, t(3), t(3)); // newest overall, but for ANOTHER cwd

  const opts = { claudeRoot, codexRoot };
  assert.equal(findCurrentTranscript(cwd, opts), codexMatch,
    'cwd-matched codex rollout beats a newer rollout from another project');

  utimesSync(claudeF, t(4), t(4));
  assert.equal(findCurrentTranscript(cwd, opts), claudeF, 'newest cwd-scoped claude transcript wins');

  assert.equal(findCurrentTranscript('/Users/me/work/OTHER', opts), codexOther,
    'no dashified claude dir for that cwd → its own codex rollout matches');
  rmSync(dir, { recursive: true, force: true });
});

test('parseTranscript: roles, summary tagging, title, noise drop, actions trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-t-'));
  const f = join(dir, 's.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'my session', sessionId: 'abc' },
    { type: 'user', message: { role: 'user', content: 'hello there, this is a real user turn' }, timestamp: '2026-01-01', sessionId: 'abc' },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued. Summary: things happened.' }, timestamp: '2026-01-02', sessionId: 'abc' },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'internal reasoning that should be dropped' },
      { type: 'text', text: 'an assistant reply' },
      { type: 'tool_use', name: 'Bash', input: { command: 'terraform apply -auto-approve' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'terraform apply -auto-approve' } }, // dup
    ] }, timestamp: '2026-01-03', sessionId: 'abc' },
    { type: 'user', message: { role: 'user', content: '<system-reminder>noise</system-reminder>' } },
  ].map(o => JSON.stringify(o)).join('\n');
  writeFileSync(f, lines);

  const { turns, title } = parseTranscript(f);
  assert.equal(title, 'my session');
  assert.deepEqual(turns.map(t => t.role), ['user', 'summary', 'assistant', 'actions'], 'noise + thinking dropped, summary tagged, actions appended');
  assert.ok(turns.find(t => t.role === 'summary').text.includes('Summary'));

  const actions = turns.find(t => t.role === 'actions').text;
  assert.match(actions, /Bash: terraform apply -auto-approve/);
  assert.match(actions, /Edit: src\/auth\.ts/);
  assert.equal(actions.match(/terraform apply/g).length, 1, 'duplicate actions are collapsed');
  assert.ok(!actions.includes('internal reasoning'), 'thinking is not indexed');
  rmSync(dir, { recursive: true, force: true });
});
