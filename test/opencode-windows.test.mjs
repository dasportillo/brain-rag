// Issue #52: on Windows npm CLIs are .cmd shims that Node will not spawn without a shell, and
// cmd.exe caps the command line at ~8191 characters. These tests pin how commands are built per
// platform, that the extractor prompt travels on stdin, and that the generated plugin carries the
// Windows path. (No Windows CI here: the win32 branch is checked as the exact string cmd.exe gets.)
import '../quiet.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

const { winQuote, commandFor, runCapture, runOpencode } = await import('../opencode-hook.mjs');
const { opencodePluginBody } = await import('../prompts.mjs');

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => dirs.forEach(d => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));

test('winQuote: plain tokens stay bare; spaces and empties are quoted; quotes cannot break out', () => {
  assert.equal(winQuote('ses_e4e37f501ffe9tRfBHni1oYEAf'), 'ses_e4e37f501ffe9tRfBHni1oYEAf');
  assert.equal(winQuote('C:\\Users\\ana\\repo'), 'C:\\Users\\ana\\repo');
  assert.equal(winQuote('C:\\Users\\Juan Perez\\repo'), '"C:\\Users\\Juan Perez\\repo"');
  assert.equal(winQuote(''), '""', 'an empty directory argument keeps its position');
  assert.equal(winQuote('a" & calc'), '"a & calc"');
});

test('commandFor: win32 goes through cmd.exe as one quoted line; posix is a plain argv spawn', () => {
  assert.deepEqual(commandFor('npx', ['-y', 'brain-rag', 'opencode', 'idle', 'ses_1', ''], 'win32'),
    { file: 'npx -y brain-rag opencode idle ses_1 ""', args: [], shell: true });
  assert.deepEqual(commandFor('npx', ['-y', 'brain-rag'], 'darwin'), { file: 'npx', args: ['-y', 'brain-rag'], shell: false });
});

test('runCapture: feeds stdin, returns stdout, rejects with stderr on a non-zero exit', async () => {
  const echo = `process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))`;
  assert.equal(await runCapture(process.execPath, ['-e', echo], { input: 'hola stdin' }), 'HOLA STDIN');
  await assert.rejects(runCapture(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']), /exited 3: boom/);
});

test('runOpencode: the prompt goes on stdin (never argv), tools are denied, the session is deleted', async () => {
  const bin = tmp('fake-opencode-');
  const log = join(bin, 'calls.log');
  // A fake `opencode` on PATH: records argv + stdin size, answers like `run --format json` does.
  writeFileSync(join(bin, 'opencode'), `#!${process.execPath}
const fs = require('fs');
let input = ''; process.stdin.on('data', d => input += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input.length, cfg: process.env.OPENCODE_CONFIG_CONTENT, brain: process.env.BRAIN }) + '\\n');
  if (process.argv[2] === 'run') {
    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_fake1', part: { type: 'text', text: '[]' } }));
  }
});
`);
  chmodSync(join(bin, 'opencode'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = bin + delimiter + PATH;
  try {
    const prompt = 'x'.repeat(20_000); // far past cmd.exe's 8191-character command line
    assert.equal(await runOpencode(prompt, { model: 'ollama/qwen3:8b' }), '[]');
  } finally { process.env.PATH = PATH; }
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls[0].argv, ['run', '--pure', '--format', 'json', '-m', 'ollama/qwen3:8b'], 'no prompt in argv');
  assert.equal(calls[0].stdin, 20_000, 'the whole prompt arrived on stdin');
  assert.equal(calls[0].brain, '0');
  assert.deepEqual(JSON.parse(calls[0].cfg).permission, { '*': 'deny' });
  assert.deepEqual(calls[1].argv, ['session', 'delete', 'ses_fake1'], 'the throwaway session is cleaned up');
});

test('plugin: Windows path spawns through a shell with quoted args and a hidden window', () => {
  const body = opencodePluginBody('brain-rag');
  assert.match(body, /const WIN = process\.platform === 'win32'/);
  assert.match(body, /WIN \? spawn\(\[BIN\[0\], \.\.\.argv\]\.map\(q\)\.join\(' '\), \[\], \{ \.\.\.opts, shell: true \}\)/);
  assert.match(body, /windowsHide: true/);
  // issue #55: a detached process gets its own console on Windows, and windowsHide does not hide it
  assert.match(body, /detached: !WIN/, 'never detached on Windows (no console window per event)');
  assert.match(body, /child\.on\('error'/, 'a missing binary never becomes an unhandled error in opencode');
  // pinned to the package version, so npx can never keep running a stale cached release
  assert.match(opencodePluginBody('brain-rag', '9.9.9'), /'npx -y brain-rag@9\.9\.9'/);
  // the plugin's inline quoting matches the hook's winQuote
  const q = new Function(`return ${body.match(/const q = (\(a\) => [^\n]+);/)[1]}`)();
  for (const s of ['ses_1', 'C:\\Users\\Juan Perez\\x', '', 'npx']) assert.equal(q(s), winQuote(s));
});
