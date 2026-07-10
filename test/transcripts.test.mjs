// Unit tests for the parse/redact/chunk layer. Model-free (no embeddings) so `node --test` is fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redact, chunkText, projectFromPath, parseTranscript } from '../transcripts.mjs';

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
