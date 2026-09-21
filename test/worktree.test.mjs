// Project naming for sessions that ran inside a linked git WORKTREE (issue #30): the project is
// the MAIN repo, never the worktree folder. Uses a real `git worktree add` in a temp repo, plus
// the two fallbacks (unreadable pointer → path shape; deleted worktree → the walk reaches the
// main .git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const { gitRoot, gitRootName } = await import('../transcripts.mjs');

const base = mkdtempSync(join(tmpdir(), 'brain-wt-'));
test.after(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

test('a real linked worktree under <repo>/.claude/worktrees resolves to the MAIN repo', () => {
  const repo = join(base, 'acme-api');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'x');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(repo, '.claude', 'worktrees', 'gentle-gliding-church');
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  assert.ok(existsSync(join(wt, '.git')), 'worktree has a .git pointer file');

  // git writes the REAL path into the pointer (macOS: /var → /private/var), so compare realpaths.
  assert.equal(realpathSync(gitRoot(wt)), realpathSync(repo));
  assert.equal(realpathSync(gitRoot(join(wt, 'src', 'deep'))), realpathSync(repo), 'subdir of the worktree too');
  assert.equal(gitRootName(wt), 'acme-api');
  assert.equal(gitRoot(repo), repo, 'the main repo itself is unchanged');
});

test('a worktree living OUTSIDE the repo folder still resolves through its gitdir pointer', () => {
  const repo = join(base, 'acme-web');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a'), 'x'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(base, 'elsewhere', 'acme-web-hotfix');
  mkdirSync(join(base, 'elsewhere'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'hotfix');
  assert.equal(gitRootName(wt), 'acme-web');
});

test('unreadable pointer falls back to the .claude/worktrees path shape; deleted worktree walks up to the main .git', () => {
  const repo = join(base, 'acme-cli');
  mkdirSync(join(repo, '.git'), { recursive: true }); // a bare "repo" marker is enough for the walk
  const wt = join(repo, '.claude', 'worktrees', 'witty-moseying-allen');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), 'garbage without a gitdir line');
  assert.equal(gitRootName(wt), 'acme-cli', 'path shape fallback');

  const gone = join(repo, '.claude', 'worktrees', 'deleted-one', 'src');
  assert.ok(!existsSync(gone));
  assert.equal(gitRootName(gone), 'acme-cli', 'no .git on the way up until the main repo');
});

test('a plain directory with a .git DIRECTORY is a regular repo (no regression)', () => {
  const repo = join(base, 'plain');
  mkdirSync(join(repo, '.git'), { recursive: true });
  assert.equal(gitRoot(join(repo, 'x', 'y')), repo);
  assert.equal(gitRootName(join(base, 'not-a-repo-at-all')), basename(join(base, 'not-a-repo-at-all')), 'outside any repo → cwd basename');
});
