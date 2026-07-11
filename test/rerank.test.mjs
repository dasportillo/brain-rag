// Unit tests for the reranker's BLEND function only — pure logic, dependency-free.
// rerank.mjs itself (model load, tokenization) is deliberately NOT imported here: the
// cross-encoder is exercised by the eval harness against the real corpus, not by unit tests.
// searchChunks' rerank:false default path is covered by the existing store/improvements suites
// staying green untouched — that equivalence IS the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendScores, RRF_K } from '../rerank-blend.mjs';

// helper: order of candidate indices implied by the blended scores, best first
const orderOf = (blended) => blended.map((s, i) => i).sort((a, b) => blended[b] - blended[a]);

test('empty input -> empty output', () => {
  assert.deepEqual(blendScores([], []), []);
});

test('output length follows the shorter input (defensive)', () => {
  assert.equal(blendScores([1, 2, 3], [0, 1]).length, 2);
});

test('all scores stay within [0, 1] with default weights', () => {
  const blended = blendScores([-100, -3.5, 0, 0.98, 100], [0, 1, 2, 3, 4]);
  for (const s of blended) assert.ok(s >= 0 && s <= 1, `score ${s} out of [0,1]`);
});

test('equal CE scores preserve the incoming rank order (rank prior is the tiebreak)', () => {
  const blended = blendScores([0.5, 0.5, 0.5, 0.5], [0, 1, 2, 3]);
  assert.deepEqual(orderOf(blended), [0, 1, 2, 3]);
  for (let i = 1; i < blended.length; i++) assert.ok(blended[i] < blended[i - 1], 'strictly decreasing in rank');
});

test('a confident CE hit RESCUES a bottom-ranked candidate over a CE-rejected top one', () => {
  // measured jina-v2 shape: relevant ES passage for an EN query ≈ +0.98, distractors ≈ -3.5
  const blended = blendScores([-3.5, -3.4, 0.98], [0, 1, 29]);
  assert.equal(orderOf(blended)[0], 2, 'the buried relevant candidate wins');
});

test('a near-tie CE difference does NOT overturn a whole-pool rank gap (no scramble)', () => {
  // candidate at rank 29 scores marginally higher than the rank-0 one: prior must hold
  const blended = blendScores([0.0, 0.05], [0, 29]);
  assert.ok(blended[0] > blended[1], 'rank-0 candidate stays ahead');
});

test('monotone in CE score: raising a logit never lowers the blended score', () => {
  const lo = blendScores([0.2], [5])[0];
  const hi = blendScores([0.9], [5])[0];
  assert.ok(hi > lo);
});

test('monotone in rank: same CE score, better incoming rank -> higher blend', () => {
  const better = blendScores([0.3], [2])[0];
  const worse = blendScores([0.3], [20])[0];
  assert.ok(better > worse);
});

test('weight overrides: wCe=0 is pure rank order, wRank=0 is pure CE order', () => {
  const ce = [0.1, 2.0, -1.0];
  const rankOnly = blendScores(ce, [2, 0, 1], { wCe: 0, wRank: 1 });
  assert.deepEqual(orderOf(rankOnly), [1, 2, 0]); // by incoming rank: 0 < 1 < 2
  const ceOnly = blendScores(ce, [2, 0, 1], { wCe: 1, wRank: 0 });
  assert.deepEqual(orderOf(ceOnly), [1, 0, 2]); // by logit: 2.0 > 0.1 > -1.0
});

test('rank prior is RRF-shaped: rank 0 contributes exactly wRank', () => {
  // sigmoid(0) = 0.5, prior(0) = RRF_K/(RRF_K+0) = 1
  const [s] = blendScores([0], [0], { wCe: 0.7, wRank: 0.3 });
  assert.ok(Math.abs(s - (0.7 * 0.5 + 0.3 * 1)) < 1e-12);
  assert.equal(RRF_K, 60);
});
