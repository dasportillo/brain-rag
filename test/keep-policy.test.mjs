// Unit tests for the SessionStart keep policy: the pure precedence in mark-keep.decideKeep and the
// never.list matcher. I/O-free (no hook stdin, no keep.list writes) so `node --test` stays fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideKeep } from '../mark-keep.mjs';
import { isNeverKept } from '../never.mjs';

const REPO = '/Users/x/project/efy3';

test('BRAIN=1 keeps regardless of lists or default', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: '1', never: [REPO], always: [], defaultOn: false }),
    { keep: true, reason: 'BRAIN' },
  );
});

test('BRAIN=0 skips even with capture-by-default on', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: '0', defaultOn: true }),
    { keep: false, reason: 'BRAIN=0' },
  );
});

test('never.list beats always.list and default', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: undefined, never: [REPO], always: [REPO], defaultOn: true }),
    { keep: false, reason: 'never.list' },
  );
});

test('always.list keeps when default is off', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: '', always: [REPO], defaultOn: false }),
    { keep: true, reason: 'always.list' },
  );
});

test('capture-by-default keeps an unlisted repo', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: undefined, defaultOn: true }),
    { keep: true, reason: 'default' },
  );
});

test('historic opt-in default: nothing triggers, session is skipped', () => {
  assert.deepEqual(
    decideKeep({ cwd: REPO, env: undefined, defaultOn: false }),
    { keep: false, reason: 'opt-in' },
  );
});

test('isNeverKept is boundary-aware — a sibling sharing a prefix does not match', () => {
  assert.equal(isNeverKept('/Users/x/project/efy3', [REPO]), true);
  assert.equal(isNeverKept('/Users/x/project/efy3/services/api', [REPO]), true);
  assert.equal(isNeverKept('/Users/x/project/efy3-legacy', [REPO]), false);
  assert.equal(isNeverKept(undefined, [REPO]), false);
});
