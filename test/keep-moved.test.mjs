// Issue #62: keep.list stores the transcript path as it was when the session was marked. When the
// transcript ends up in another project folder (a worktree session saved under the main repo's
// folder, a deleted worktree), exact-path matching dropped the session silently — 80 of them,
// 62 from one repo, counted as "unchanged". Kept sessions are now matched by session id too,
// keep.list heals itself, and a marked session with no transcript anywhere shows in the summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveKept } from '../transcripts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => dirs.forEach(d => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));

test('resolveKept: exact path wins; a vanished path resolves by session id; nowhere → missing', () => {
  const P = '/h/.claude/projects';
  const files = [`${P}/-w-repo/aaa.jsonl`, `${P}/-w-repo/bbb.jsonl`, `${P}/-w-other/zzz.jsonl`];
  const onDisk = new Set(files);
  const { kept, moved, missing } = resolveKept([
    `${P}/-w-repo/aaa.jsonl`,                           // still where it was marked
    `${P}/-w-repo--claude-worktrees-gentle/bbb.jsonl`,  // marked in a worktree, saved under the main repo
    `${P}/-w-repo--claude-worktrees-gentle/ccc.jsonl`,  // gone from every folder
    `${P}/-w-repo/aaa.jsonl`,                           // duplicate line
  ], files, { exists: (p) => onDisk.has(p), mtimeOf: () => 0 });
  assert.deepEqual([...kept].sort(), [`${P}/-w-repo/aaa.jsonl`, `${P}/-w-repo/bbb.jsonl`]);
  assert.deepEqual([...moved], [[`${P}/-w-repo--claude-worktrees-gentle/bbb.jsonl`, `${P}/-w-repo/bbb.jsonl`]]);
  assert.deepEqual(missing, [`${P}/-w-repo--claude-worktrees-gentle/ccc.jsonl`]);
  assert.ok(!kept.has(`${P}/-w-other/zzz.jsonl`), 'an unmarked session stays unmarked');
});

test('resolveKept: several folders hold the id → the newest transcript; an existing path outside the stores is left alone', () => {
  const files = ['/s/a/x.jsonl', '/s/b/x.jsonl'];
  const mt = { '/s/a/x.jsonl': 10, '/s/b/x.jsonl': 20 };
  const r = resolveKept(['/s/gone/x.jsonl', '/elsewhere/y.jsonl'], files, {
    exists: (p) => p === '/elsewhere/y.jsonl' || p in mt, mtimeOf: (f) => mt[f],
  });
  assert.equal(r.moved.get('/s/gone/x.jsonl'), '/s/b/x.jsonl');
  assert.deepEqual(r.missing, [], 'a file that exists is never reported missing');
  assert.ok(!r.kept.has('/elsewhere/y.jsonl'));
});

function setup(prefix) {
  const home = tmp(prefix);
  const projects = join(home, '.claude', 'projects');
  const brain = join(home, '.claude', 'brain');
  mkdirSync(brain, { recursive: true });
  const env = { ...process.env, HOME: home, BRAIN_DIR: brain, XDG_DATA_HOME: join(home, 'xdg') };
  const ingest = (...a) => execFileSync(process.execPath, [join(ROOT, 'ingest.mjs'), '--no-embed', ...a], { env, encoding: 'utf8' });
  const transcript = (dir, id, text) => {
    mkdirSync(join(projects, dir), { recursive: true });
    const f = join(projects, dir, `${id}.jsonl`);
    writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: `${text} — long enough to clear the 80-character chunk floor of ingest.` }, sessionId: id, cwd: '/w/meridian' }));
    return f;
  };
  const keepFile = join(brain, 'keep.list');
  return { projects, keepFile, ingest, transcript };
}

test('ingest: a marked session whose transcript changed folder is indexed and keep.list is rewritten', () => {
  const { projects, keepFile, ingest, transcript } = setup('keep-moved-');
  const marked = transcript('-w-meridian--claude-worktrees-validated-nibbling-parnas', '618b1c43', 'the data model redesign of meridian');
  transcript('-w-meridian', 'unmarked', 'a session nobody marked, it must stay out of the index');
  writeFileSync(keepFile, marked + '\n' + join(projects, '-w-gone', 'lost01.jsonl') + '\n');

  // the transcript ends up under the main repo's folder; the worktree folder is gone
  const now = join(projects, '-w-meridian', '618b1c43.jsonl');
  renameSync(marked, now);
  rmSync(dirname(marked), { recursive: true });

  const out = ingest();
  assert.match(out, /✔ ingest: 1 processed, 0 unchanged, 1 not kept, /);
  assert.match(out, /1 relinked \(transcript moved\)/);
  assert.match(out, /1 kept without transcript \(never indexed\)/, 'the loss is visible in the summary');
  assert.match(out, /sessions: 1/);
  assert.deepEqual(readFileSync(keepFile, 'utf8').trim().split('\n'), [now, join(projects, '-w-gone', 'lost01.jsonl')]);

  // healed: the next run matches by path and finds nothing to do
  const again = ingest();
  assert.match(again, /0 processed, 1 unchanged, 1 not kept/);
  assert.doesNotMatch(again, /relinked/);
});

test('ingest: a session already indexed under its old path moves with its chunks — no second copy', () => {
  const { projects, keepFile, ingest, transcript } = setup('keep-moved-indexed-');
  const old = transcript('-w-meridian--claude-worktrees-x', 'abc123', 'the ledger decision, indexed before the move');
  writeFileSync(keepFile, old + '\n');
  assert.match(ingest(), /1 processed[\s\S]*sessions: 1, projects: 1, chunks: 1/);

  mkdirSync(join(projects, '-w-meridian'), { recursive: true });
  renameSync(old, join(projects, '-w-meridian', 'abc123.jsonl'));
  const out = ingest();
  assert.match(out, /0 processed, 1 unchanged/, 'same mtime and size: nothing re-indexed');
  assert.match(out, /1 relinked/);
  assert.doesNotMatch(out, /archived/, 'the old path does not linger as an archived duplicate');
  assert.match(out, /sessions: 1, projects: 1, chunks: 1/);
});
