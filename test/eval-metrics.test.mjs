// Unit tests for the pure metric layer of the eval harness — no model, no corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHitRank, recallAtK, mrr, ndcgAtK, percentile, sliceBy } from '../eval-metrics.mjs';
import { wrapEvidence } from '../store.mjs';

const R = (...texts) => texts.map(text => ({ text }));

test('firstHitRank: 1-based rank of first pattern match, 0 on miss', () => {
  const pats = [/needle/i];
  assert.equal(firstHitRank(R('hay', 'the Needle here', 'more'), pats), 2);
  assert.equal(firstHitRank(R('hay', 'stack'), pats), 0);
  assert.equal(firstHitRank([], pats), 0);
});

test('firstHitRank: self-echo chunks neither hit nor occupy a rank', () => {
  const query = 'how did we fix the needle bug';
  const pats = [/needle/i];
  // First result is the indexed eval session itself (contains the literal query) → skipped
  // entirely; the real evidence at position 2 counts as rank 1.
  const results = R(`discussing: "${query}" and its expectAny needle`, 'the needle fix was X');
  assert.equal(firstHitRank(results, pats, query), 1);
  // Only the echo → miss, not a fake hit.
  assert.equal(firstHitRank(R(`eval case: ${query} needle`), pats, query), 0);
});

test('recallAtK / mrr / ndcgAtK on a known rank distribution', () => {
  const ranks = [1, 3, 0, 9]; // hit@1, hit@3, miss, hit@9 (outside K=8)
  assert.equal(recallAtK(ranks, 1), 0.25);
  assert.equal(recallAtK(ranks, 8), 0.5);
  assert.equal(mrr(ranks), (1 + 1 / 3 + 0 + 1 / 9) / 4);
  const expected = (1 + 1 / Math.log2(4)) / 4; // rank 9 and the miss contribute 0 at K=8
  assert.ok(Math.abs(ndcgAtK(ranks, 8) - expected) < 1e-9);
  assert.equal(recallAtK([], 5), 0, 'empty set → 0, not NaN');
});

test('percentile: nearest-rank, clamped', () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([], 50), 0);
});

test('sliceBy groups hit/total per case field, missing field under —', () => {
  const cases = [{ kind: 'exact-term' }, { kind: 'exact-term' }, { kind: 'state' }, {}];
  const ranks = [1, 0, 4, 2];
  const s = sliceBy(cases, ranks, 'kind', 8);
  assert.deepEqual(s['exact-term'], { hits: 1, total: 2 });
  assert.deepEqual(s['state'], { hits: 1, total: 1 });
  assert.deepEqual(s['—'], { hits: 1, total: 1 });
});

test('wrapEvidence frames text as evidence and survives pre-wrapped clipping', () => {
  const clipped = 'x'.repeat(1200) + ' … [+800 chars]'; // clip() runs BEFORE wrapping
  const wrapped = wrapEvidence(clipped);
  assert.ok(wrapped.startsWith('[Historical context recovered from previous conversations'));
  assert.ok(wrapped.endsWith('[End of recovered historical context.]'), 'footer intact after clipping');
  assert.ok(wrapped.includes(clipped), 'content unmodified');
  assert.match(wrapEvidence('note', 'the curated state note for "foo"'), /curated state note for "foo"/);
});
