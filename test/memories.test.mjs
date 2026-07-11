// Unit tests for Layer 2 (the memory store): migration v2, saveMemory's conservative
// dedup/supersede policy, and hybrid searchMemories. Temp DB, hand-crafted embeddings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'brain-mem-'));
process.env.BRAIN_DIR = dir;
process.env.BRAIN_DB = join(dir, 'brain.db');

const { openDb, saveMemory, searchMemories, MEMORY_TYPES } = await import('../store.mjs');

const vec = (a, b) => { const v = new Array(8).fill(0); v[0] = a; v[1] = b; return v; };
const db = openDb();

test('migration v2: memories schema present, user_version = 2, idempotent reopen', () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(openDb().prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(MEMORY_TYPES.length, 16);
});

test('saveMemory: create → hybrid search finds it (accent-insensitive lexical)', () => {
  const r = saveMemory(db, {
    type: 'decision', project: 'projA', title: 'Tarifas: usar MONTOS_FIJOS para contratos de valor fijo',
    content: 'La auditoría VCO se dispara por MONTOS_FIJOS cuando la modalidad no es por evento.',
    confidence: 0.9, source_session: 'sess-1', source_messages: ['uuid-1', 'uuid-2'], entities: ['MIDI', 'VCO'],
  }, vec(1, 0));
  assert.equal(r.action, 'created');
  // query vector orthogonal — only the lexical leg can find it
  const hits = searchMemories(db, vec(0, 1), { project: 'projA', queryText: 'auditoria montos_fijos' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, r.id);
  assert.equal(hits[0].source_session, 'sess-1');
});

test('saveMemory: same project+type+title refreshes in place (no duplicate)', () => {
  const r = saveMemory(db, {
    type: 'decision', project: 'projA', title: '  tarifas: usar montos_fijos PARA contratos de valor fijo ',
    content: 'Actualizado: también aplica a paquetes quirúrgicos.',
  }, vec(1, 0.1));
  assert.equal(r.action, 'updated');
  const hits = searchMemories(db, vec(1, 0), { project: 'projA', queryText: 'montos_fijos' });
  assert.equal(hits.length, 1, 'still one memory');
  assert.match(hits[0].content, /quirúrgicos/);
});

test('saveMemory: explicit supersedes retires the old memory; search hides it by default', () => {
  const old = searchMemories(db, vec(1, 0), { project: 'projA' })[0];
  const r = saveMemory(db, {
    type: 'decision', project: 'projA', title: 'Tarifas: MONTOS_FIJOS reemplazado por reglas por modalidad',
    content: 'Desde julio las tarifas fijas se resuelven con blocking_pac_rule, no MONTOS_FIJOS.',
    supersedes: old.id,
  }, vec(0.9, 0.4));
  assert.equal(r.superseded, old.id);
  const active = searchMemories(db, vec(1, 0), { project: 'projA', queryText: 'montos_fijos' });
  assert.ok(!active.some(h => h.id === old.id), 'superseded memory hidden from default search');
  const any = searchMemories(db, vec(1, 0), { project: 'projA', queryText: 'montos_fijos', status: 'any' });
  assert.equal(any.find(h => h.id === old.id)?.status, 'superseded');
  assert.equal(any.find(h => h.id === r.id)?.supersedes, old.id, 'link preserved');
});

test('saveMemory: similar-but-different title creates new and only WARNS (never auto-retires)', () => {
  const base = saveMemory(db, {
    type: 'architecture', project: 'projB', title: 'Ledger: hash chain para auditoría',
    content: 'Cada evento del ledger encadena SHA-256 del anterior.',
  }, vec(0, 1));
  const r = saveMemory(db, {
    type: 'architecture', project: 'projB', title: 'Ledger: cadena de hashes inmutable',
    content: 'El ledger usa encadenamiento de hashes y Object Lock.',
  }, vec(0.05, 0.998)); // cosine ~0.998 vs base — clearly similar
  assert.equal(r.action, 'created');
  assert.ok(r.similar?.some(s => s.id === base.id), 'similarity reported to the caller');
  const both = searchMemories(db, vec(0, 1), { project: 'projB' });
  assert.equal(both.length, 2, 'both stay active — the agent decides, not the cosine');
});

test('saveMemory: unknown type or status throws', () => {
  assert.throws(() => saveMemory(db, { type: 'vibes', project: 'p', title: 't', content: 'c' }, vec(1, 0)), /unknown memory type/);
  assert.throws(() => saveMemory(db, { type: 'fact', status: 'gone', project: 'p', title: 't', content: 'c' }, vec(1, 0)), /unknown status/);
});

test('searchMemories: type filter narrows results', () => {
  const decisions = searchMemories(db, vec(1, 0), { project: 'projA', type: 'decision', status: 'any' });
  assert.ok(decisions.length >= 2);
  assert.ok(decisions.every(h => h.type === 'decision'));
  assert.equal(searchMemories(db, vec(1, 0), { project: 'projA', type: 'incident' }).length, 0);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
