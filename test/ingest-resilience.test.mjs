// Issue #45: a transcript bigger than V8's max string (~512 MB) crashed readFileSync, and the crash
// aborted the whole ingest run — nothing was indexed for weeks. These tests pin both halves of the
// fix: transcripts are read line by line in blocks, and one failing transcript never stops the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines, parseTranscript } from '../transcripts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => dirs.forEach(d => { try { chmodSync(d, 0o755); rmSync(d, { recursive: true, force: true }); } catch {} }));

const lines = (f, opts) => [...readLines(f, opts)];

test('readLines: same lines as split, across tiny blocks, with multi-byte chars cut at block edges', () => {
  const f = join(tmp('rl-'), 'a.jsonl');
  const text = '{"a":"ñandú — 漢字 🧠"}\n\n{"b":2}\r\n{"c":"último sin salto"}';
  writeFileSync(f, text);
  for (const blockSize of [1, 2, 3, 5, 7, 64, 1 << 20]) {
    assert.deepEqual(lines(f, { blockSize }), text.split('\n'), `blockSize ${blockSize}`);
  }
  writeFileSync(f, 'x\n');
  assert.deepEqual(lines(f), ['x'], 'a trailing newline adds no empty last line');
  writeFileSync(f, '');
  assert.deepEqual(lines(f), []);
});

test('readLines: a line over maxLine is skipped whole and reading resumes at the next line', () => {
  const f = join(tmp('rl-big-'), 'b.jsonl');
  writeFileSync(f, `{"keep":1}\n${'x'.repeat(5000)}\n{"keep":2}\n${'y'.repeat(5000)}`);
  for (const blockSize of [3, 100, 1 << 20]) {
    assert.deepEqual(lines(f, { blockSize, maxLine: 1000 }), ['{"keep":1}', '{"keep":2}'], `blockSize ${blockSize}`);
  }
});

test('parseTranscript reads through readLines (no whole-file string)', () => {
  const f = join(tmp('rl-parse-'), 's.jsonl');
  const huge = 'z'.repeat(3000);
  writeFileSync(f, [
    { type: 'user', message: { role: 'user', content: 'a real question about the gate' }, sessionId: 's1', cwd: '/w/foo' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: huge }] }, sessionId: 's1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }, sessionId: 's1' },
  ].map(o => JSON.stringify(o)).join('\n'));
  const { turns, cwd } = parseTranscript(f);
  assert.equal(cwd, '/w/foo');
  assert.deepEqual(turns.map(t => t.text), ['a real question about the gate', 'the answer']);
});

test('ingest: one unreadable transcript is reported and skipped; the others are indexed', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, () => {
  const home = tmp('ingest-home-');
  const proj = join(home, '.claude', 'projects', '-w-foo');
  mkdirSync(proj, { recursive: true });
  const t = (id, text) => [
    { type: 'user', message: { role: 'user', content: `${text} — long enough to clear the 80-character chunk floor of ingest.` }, sessionId: id, cwd: '/w/foo' },
  ].map(o => JSON.stringify(o)).join('\n');
  const good1 = join(proj, 'good1.jsonl'), bad = join(proj, 'bad.jsonl'), good2 = join(proj, 'good2.jsonl');
  writeFileSync(good1, t('good1', 'first good session about the freshness gate'));
  writeFileSync(bad, t('bad', 'this one cannot be read'));
  writeFileSync(good2, t('good2', 'second good session about the WAL decision'));
  chmodSync(bad, 0o000);
  mkdirSync(join(home, '.claude', 'brain'), { recursive: true });
  writeFileSync(join(home, '.claude', 'brain', 'keep.list'), [good1, bad, good2].join('\n') + '\n');

  const env = { ...process.env, HOME: home, BRAIN_DIR: join(home, '.claude', 'brain'), XDG_DATA_HOME: join(home, 'xdg') };
  let out;
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'ingest.mjs'), '--no-embed'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    assert.fail(`ingest must not exit non-zero on one bad transcript:\n${e.stdout}\n${e.stderr}`);
  }
  assert.match(out, /✔ ingest: 2 processed, .*1 FAILED/);
  assert.match(out, /sessions: 2/);
});
