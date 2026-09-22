// The prompt FILES (~/.claude/commands/*.md, ~/.codex/prompts/*.md) are written once by install,
// so before this mechanism a package upgrade never reached /distill: the rules changed in
// distill-prompt.mjs and the slash command kept extracting with last year's copy. These tests pin
// the contract that fixes it — stamped files, a refresh that only repairs what is provably out of
// date, and a refresh that can never break a session start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  bodyHash, stamp, splitStamp, fileState, promptFiles, syncPrompts, refreshQuietly,
  runningFromCheckout,
} = await import('../prompts.mjs');
const { DISTILL_PROMPT, MEMORY_RULES } = await import('../distill-prompt.mjs');

// A throwaway $HOME per test; `codex` decides whether this machine "has Codex".
function fakeHome({ codex = false, commands = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'brain-prompts-'));
  if (commands) mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  if (codex) mkdirSync(join(home, '.codex', 'prompts'), { recursive: true });
  return home;
}
const homes = [];
const home = (opts) => { const h = fakeHome(opts); homes.push(h); return h; };
process.on('exit', () => homes.forEach(h => { try { rmSync(h, { recursive: true, force: true }); } catch {} }));

const CMD = (h, f) => join(h, '.claude', 'commands', f);
const CODEX = (h, f) => join(h, '.codex', 'prompts', f);
const read = (p) => readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

test('a stamped file round-trips: the body comes back byte-identical and the hash matches it', () => {
  const body = '---\ndescription: x\n---\nhello\n';
  const text = stamp(body);
  const { body: back, hash } = splitStamp(text);
  assert.equal(back, body);
  assert.equal(hash, bodyHash(body));
  assert.equal(fileState(text, body), 'current');
});

test('the stamp is an HTML comment on its own line — invisible in Markdown, inert as a prompt', () => {
  const text = stamp('body\n');
  const last = text.trimEnd().split('\n').pop();
  assert.match(last, /^<!-- brain-rag:prompt [0-9a-f]{12} .*-->$/);
  assert.ok(text.startsWith('body\n'), 'the body stays first and untouched');
});

test('trailing newlines are not content: the hash is stable across them', () => {
  assert.equal(bodyHash('a\n'), bodyHash('a\n\n\n'));
  assert.equal(fileState(stamp('a\n'), 'a\n\n'), 'current');
});

test('fileState tells the five cases apart', () => {
  const body = 'current body\n';
  assert.equal(fileState(null, body), 'missing');
  assert.equal(fileState(stamp(body), body), 'current');
  assert.equal(fileState(stamp('older body\n'), body), 'stale', 'ours, unedited, package moved on');
  assert.equal(fileState('older body\n', body), 'legacy', 'written before stamps existed');
  assert.equal(fileState('current body\n', body), 'stale', 'unstamped but already right → just stamp it');
  // Stamped, then hand-edited: the hash no longer describes the body.
  const edited = stamp(body).replace('current body', 'MY OWN body');
  assert.equal(fileState(edited, body), 'edited');
});

// ---------------------------------------------------------------------------
// What gets generated
// ---------------------------------------------------------------------------

test('the generated /distill files carry the CURRENT extraction rules verbatim', () => {
  const files = promptFiles({ home: '/nowhere', name: 'brain-rag' });
  const claude = files.find(f => f.host === 'claude' && f.path.endsWith('distill.md'));
  const codex = files.find(f => f.host === 'codex' && f.path.endsWith('distill.md'));
  for (const f of [claude, codex]) {
    assert.ok(f.body.includes(DISTILL_PROMPT), 'the file embeds the single source of truth');
    assert.ok(f.body.includes(MEMORY_RULES), 'and therefore the one-claim-per-memory rules');
  }
  assert.ok(claude.body.startsWith('---\ndescription:'), 'Claude Code needs the frontmatter');
  assert.ok(!codex.body.startsWith('---'), 'Codex prompts have none');
});

test('the commands point at the package by name, so a rename cannot orphan them', () => {
  const files = promptFiles({ home: '/nowhere', name: 'other-pkg' });
  const brain = files.find(f => f.host === 'claude' && f.path.endsWith('brain.md'));
  assert.ok(brain.body.includes('npx -y other-pkg mark-current'));
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

test('install writes every file, stamped; a second install is a no-op', () => {
  const h = home({ codex: true });
  const first = syncPrompts({ home: h, mode: 'install' });
  assert.equal(first.created.length, 6, 'three Claude commands + three Codex prompts');
  for (const p of first.created) assert.equal(fileState(read(p), splitStamp(read(p)).body), 'current');

  const again = syncPrompts({ home: h, mode: 'install' });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.updated, [], 'idempotent: nothing rewritten when nothing changed');
  assert.equal(again.skipped.length, 6);
});

test('install skips Codex entirely on a machine without it', () => {
  const h = home({ codex: false });
  const r = syncPrompts({ home: h, mode: 'install' });
  assert.equal(r.created.length, 3);
  assert.ok(!existsSync(join(h, '.codex')), 'no ~/.codex is conjured');
});

// ---------------------------------------------------------------------------
// refresh — the actual bug being fixed
// ---------------------------------------------------------------------------

test('THE BUG: a file left by an older version is refreshed, so /distill stops using the old rules', () => {
  const h = home();
  // What an older brain-rag wrote: no stamp, and no MEMORY_RULES in it.
  const old = '---\ndescription: Distill THIS conversation\n---\nBuild a SELF-CONTAINED memory.\n';
  writeFileSync(CMD(h, 'distill.md'), old);

  const r = syncPrompts({ home: h, mode: 'refresh' });
  assert.ok(r.updated.includes(CMD(h, 'distill.md')), 'refreshed without anyone re-running install');
  assert.ok(read(CMD(h, 'distill.md')).includes(MEMORY_RULES), 'and now it carries the new rules');
  assert.deepEqual(r.backedUp, [CMD(h, 'distill.md') + '.bak'], 'the old text is never destroyed');
  assert.equal(read(CMD(h, 'distill.md') + '.bak'), old);
});

test('a refresh never CREATES a file the user does not have', () => {
  const h = home();
  const r = syncPrompts({ home: h, mode: 'refresh' });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.updated, []);
  assert.ok(!existsSync(CMD(h, 'distill.md')), 'a background caller does not install for you');
});

test('a refresh leaves a file the user made their own, and says so instead of silently ignoring it', () => {
  const h = home();
  const mine = stamp('---\ndescription: d\n---\nold body\n').replace('old body', 'MY house rules');
  writeFileSync(CMD(h, 'distill.md'), mine);

  const r = syncPrompts({ home: h, mode: 'refresh' });
  assert.equal(read(CMD(h, 'distill.md')), mine, 'untouched');
  assert.deepEqual(r.edited, [CMD(h, 'distill.md')]);
  assert.deepEqual(r.updated, []);
});

test('install DOES overwrite an edited file (you asked for it) but keeps a .bak', () => {
  const h = home();
  const mine = stamp('---\ndescription: d\n---\nold\n').replace('old', 'MY house rules');
  writeFileSync(CMD(h, 'distill.md'), mine);

  const r = syncPrompts({ home: h, mode: 'install' });
  assert.ok(r.updated.includes(CMD(h, 'distill.md')));
  assert.equal(read(CMD(h, 'distill.md') + '.bak'), mine);
  assert.ok(read(CMD(h, 'distill.md')).includes(MEMORY_RULES));
});

test('a refresh of an already-current install writes nothing at all', () => {
  const h = home({ codex: true });
  syncPrompts({ home: h, mode: 'install' });
  const before = promptFiles({ home: h }).map(f => read(f.path));
  const r = syncPrompts({ home: h, mode: 'refresh' });
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.backedUp, []);
  assert.deepEqual(promptFiles({ home: h }).map(f => read(f.path)), before);
});

test('Codex prompts are refreshed too, but only where Codex exists', () => {
  const withCodex = home({ codex: true });
  writeFileSync(CODEX(withCodex, 'distill.md'), 'ancient codex prompt\n');
  const a = syncPrompts({ home: withCodex, mode: 'refresh' });
  assert.ok(a.updated.includes(CODEX(withCodex, 'distill.md')));

  const without = home({ codex: false });
  const b = syncPrompts({ home: without, mode: 'refresh' });
  assert.deepEqual(b.updated, []);
});

// ---------------------------------------------------------------------------
// The guarantee that matters for a hook
// ---------------------------------------------------------------------------

test('refreshQuietly is silent when there is nothing to do', () => {
  const h = home({ codex: true });
  syncPrompts({ home: h, mode: 'install' });
  const lines = [];
  refreshQuietly({ home: h, log: (s) => lines.push(s), fromSource: false });
  assert.deepEqual(lines, [], 'no noise on every single session start');
});

test('refreshQuietly reports exactly what it changed', () => {
  const h = home();
  writeFileSync(CMD(h, 'distill.md'), 'ancient\n');
  const lines = [];
  refreshQuietly({ home: h, log: (s) => lines.push(s), fromSource: false });
  assert.ok(lines.some(l => l.includes('refreshed') && l.includes('distill.md')));
  assert.ok(lines.some(l => l.includes('.bak')));
});

test('refreshQuietly NEVER throws — a session start can never be broken by a prompt file', () => {
  // An unreadable/absurd home is the stand-in for every I/O failure: no permissions, read-only FS.
  assert.doesNotThrow(() => refreshQuietly({ home: '\0not-a-path', log: () => {}, fromSource: false }));
  assert.doesNotThrow(() => refreshQuietly({ home: join(tmpdir(), 'does-not-exist-' + Date.now()), log: () => {}, fromSource: false }));
});

test('the SessionStart hook keeps deciding correctly with the refresh wired in front of it', async () => {
  // decideKeep is the hook's real job; the refresh must not have become a precondition of it.
  const { decideKeep } = await import('../mark-keep.mjs');
  assert.equal(decideKeep({ cwd: '/x', env: '1' }).keep, true);
  assert.equal(decideKeep({ cwd: '/x', env: undefined }).keep, false);
});

// A developer running the MCP server straight from a git checkout must NOT have their global
// prompt files rewritten from whatever branch happens to be checked out (they would silently
// oscillate on every branch switch). Only a published copy repairs in the background.
test('refreshQuietly does nothing when running from a source checkout', () => {
  const h = mkdtempSync(join(tmpdir(), 'brain-prompts-src-'));
  mkdirSync(join(h, '.claude', 'commands'), { recursive: true });
  const f = join(h, '.claude', 'commands', 'distill.md');
  writeFileSync(f, 'an old prompt from a previous version');
  const lines = [];
  assert.equal(refreshQuietly({ home: h, log: (s) => lines.push(s), fromSource: true }), null);
  assert.equal(readFileSync(f, 'utf8'), 'an old prompt from a previous version', 'file untouched');
  assert.deepEqual(lines, [], 'and it says nothing');
  // The same call from a published copy does repair it.
  refreshQuietly({ home: h, log: (s) => lines.push(s), fromSource: false });
  assert.match(readFileSync(f, 'utf8'), /brain-rag:prompt/);
  rmSync(h, { recursive: true, force: true });
});

test('runningFromCheckout: true beside a .git, false otherwise', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-checkout-'));
  assert.equal(runningFromCheckout(d), false);
  mkdirSync(join(d, '.git'));
  assert.equal(runningFromCheckout(d), true);
  rmSync(d, { recursive: true, force: true });
});
