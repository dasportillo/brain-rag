// RETITLE (issue #38) — shorten the long titles of memories that were distilled before the
// one-claim-per-memory rules landed (#34).
//
// Measured on a real 413-memory brain: 46 titles over 90 characters, 12 bodies over 1200. The
// dominant defect is the TITLE, so this command only touches titles — and that is the whole
// point. Every data-destroying bug in the parked `rewrite` command (#35) lived in the path that
// SPLITS a memory into several: pieces born without the `private` flag, a colliding title
// overwriting someone else's memory through saveMemory's refresh path, a piece burying the
// original. A title pass creates no rows: it is an UPDATE by id, so none of those paths exist.
//
//   brain-rag retitle                      # every active memory with a title over 90 chars
//   brain-rag retitle --project X          # one project (alias-aware)
//   brain-rag retitle --over 80            # a stricter threshold
//   brain-rag retitle --dry                # print BEFORE/AFTER, write nothing (still costs a call)
//   brain-rag retitle --limit N --batch 20 --model sonnet --yes
//
// No idempotency marker is needed: the length filter IS the marker. A title that came back short
// is not selected again, and one the model failed to shorten correctly is retried — which is the
// behaviour you want from a repair pass.
//
// Importing runs nothing (tests import the pure helpers); main() runs via cli.mjs.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, dep-free)
// ---------------------------------------------------------------------------

export const DEFAULT_OVER = 90;   // "too long" — p50 of a healthy corpus is well under this
export const DEFAULT_BATCH = 20;  // memories per headless call
export const TARGET = 60;         // what the distiller rules ask for

// Split into batches. Batching is the cost fix: every `claude -p` carries ~14k tokens of the
// CLI's own system prompt, so one call per memory costs ~40x what one call per 20 does.
export function chunkBatches(items, size = DEFAULT_BATCH) {
  const n = Number.isFinite(size) && size >= 1 ? Math.floor(size) : DEFAULT_BATCH;
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// What the model sees: id, type, the long title, and enough body to know what the memory claims.
// The body is capped — the model is choosing a title, not reading an essay.
export function buildRetitleInput(rows, { bodyCap = 600 } = {}) {
  return rows.map((r) => {
    const body = r.content.length > bodyCap ? r.content.slice(0, bodyCap).trimEnd() + ' …' : r.content;
    return `### id ${r.id} · ${r.type}\ncurrent title (${r.title.length} chars): ${r.title}\nbody: ${body}`;
  }).join('\n\n');
}

export function retitlePrompt(input, { target = TARGET } = {}) {
  return `You are shortening the TITLES of a developer team's stored memories. Each memory below has a title that is too long — it was written as a summary when it should be a claim.

For each one, write a better title and change NOTHING else. A good title:
- is a short CLAIM, under ${target} characters — what is true, not what the memory is about;
- carries NO identifiers: no app ids, ARNs, hashes, PR numbers, file paths, version numbers. Those already live in the body;
- is in the SAME LANGUAGE as the existing title. Never translate;
- keeps the specific subject (the project, service or rule it is about) so it is still findable;
- reads on its own in a list, to someone who was not in the session.

Do not rewrite the body. Do not split a memory. Do not invent facts that are not in the body.
If a title is already fine as it is, return it unchanged.

OUTPUT ONLY a JSON array, no prose, no markdown fences:
  [{"id": <id>, "title": "..."}]

--- MEMORIES ---
${input}`;
}

// Every balanced [...] substring that parses as a JSON array, left to right (string-aware), so a
// fenced or prefaced answer still yields its payload. Same defensive shape as distill.mjs.
function* jsonArrays(text) {
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) {
        try { const v = JSON.parse(text.slice(i, j + 1)); if (Array.isArray(v)) yield v; } catch { /* keep scanning */ }
        break;
      }
    }
  }
}

// Parse the model's answer against the batch it was given, and REFUSE anything that is not an
// improvement. A title is only accepted when it belongs to this batch, is non-empty, is shorter
// than what it replaces, and is not still over the threshold — so a lazy or hallucinated answer
// leaves the memory alone instead of making it worse.
export function parseTitles(text, batch, { over = DEFAULT_OVER } = {}) {
  const byId = new Map(batch.map((r) => [r.id, r]));
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  for (const arr of jsonArrays(text)) {
    for (const el of arr) {
      if (!el || typeof el !== 'object') continue;
      const id = Number(el.id);
      const title = typeof el.title === 'string' ? el.title.trim() : '';
      const row = byId.get(id);
      if (!row || !title || out.has(id)) continue;      // foreign id, empty, or already answered
      if (title === row.title) continue;                 // unchanged: nothing to write
      if (title.length >= row.title.length) continue;    // not shorter: not an improvement
      if (title.length > over) continue;                 // still too long: leave it for a retry
      out.set(id, title);
    }
    if (out.size) return out; // first array that yields something usable wins
  }
  return out;
}

export const formatBeforeAfter = (row, title) =>
  `  #${row.id} ${row.project} · ${row.type}\n    - ${row.title.length}: ${row.title}\n    + ${title.length}: ${title}`;

// ---------------------------------------------------------------------------
// DB-facing
// ---------------------------------------------------------------------------

// Active memories whose title is longer than `over`, longest first so a --limit run fixes the
// worst offenders. `project` is alias-aware, like every other project filter in this package.
export function selectLongTitles(db, { project = null, over = DEFAULT_OVER, limit = Infinity, aliasMembers }) {
  let sql = "SELECT id, project, type, title, content FROM memories WHERE status = 'active' AND LENGTH(title) > ?";
  const params = [over];
  if (project) {
    const m = aliasMembers(project);
    sql += ` AND project IN (${m.map(() => '?').join(',')})`;
    params.push(...m);
  }
  sql += ' ORDER BY LENGTH(title) DESC, id';
  const rows = db.prepare(sql).all(...params);
  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

// Apply one new title: UPDATE by id. No row is created, so the private flag, created_at,
// provenance and the supersedes chain are untouched by construction. updated_at moves so the next
// `cloud sync` pushes the new title up; the FTS index follows through its UPDATE OF title trigger.
// The embedding is recomputed because the stored vector covers `title\ncontent`.
export function applyTitle(db, { id, title, embedding, vecToBlob, linkEntities, project, content }) {
  const now = new Date().toISOString();
  db.prepare('UPDATE memories SET title = ?, embedding = COALESCE(?, embedding), updated_at = ? WHERE id = ?')
    .run(title, embedding ? vecToBlob(embedding) : null, now, id);
  // Entity mentions are derived from the text, and the title is part of it: re-link so the graph
  // does not keep mentions that only existed in the words we just removed.
  db.prepare('DELETE FROM entity_mentions WHERE memory_id = ?').run(id);
  linkEntities(db, { memoryId: id, project, ts: now, text: `${title}\n${content}` });
  return { id, title };
}

// Run the whole pass. `run` (the headless extractor) and `embed` are injectable so tests never
// spawn a model. Returns { selected, calls, changed, skipped, results }.
export async function retitleAll(db, rows, {
  batch = DEFAULT_BATCH, over = DEFAULT_OVER, model, dry = false, run, embed, deps, onBatch,
} = {}) {
  const totals = { selected: rows.length, calls: 0, changed: 0, skipped: 0, results: [] };
  if (!rows.length) return totals;
  const runFn = run ?? (await import('./distill.mjs')).runClaude;

  for (const group of chunkBatches(rows, batch)) {
    let text = '';
    try {
      const out = await runFn(retitlePrompt(buildRetitleInput(group)), { model });
      text = out;
      try { const o = JSON.parse(out); if (o && typeof o.result === 'string') text = o.result; } catch { /* raw */ }
    } catch (e) {
      totals.skipped += group.length;
      onBatch?.({ error: e.message, size: group.length });
      continue;
    }
    totals.calls++;
    const titles = parseTitles(text, group, { over });
    const accepted = group.filter((r) => titles.has(r.id));
    totals.skipped += group.length - accepted.length;

    if (!dry && accepted.length) {
      const { vecToBlob, linkEntities } = deps ?? (await import('./store.mjs'));
      const embedFn = embed ?? (await import('./embed.mjs')).embed;
      const vecs = await embedFn(accepted.map((r) => `${titles.get(r.id)}\n${r.content}`));
      accepted.forEach((r, i) => applyTitle(db, {
        id: r.id, title: titles.get(r.id), embedding: vecs[i], vecToBlob, linkEntities,
        project: r.project, content: r.content,
      }));
    }
    totals.changed += accepted.length;
    for (const r of accepted) totals.results.push({ row: r, title: titles.get(r.id) });
    onBatch?.({ size: group.length, accepted: accepted.length });
  }
  return totals;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  // A flag with no value (or a non-numeric one) must not silently mean "everything" — that is how
  // a one-key typo turns a 20-memory trial into the whole corpus.
  const val = (f, d) => {
    if (!has(f)) return d;
    const v = args[args.indexOf(f) + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${f} needs a value`);
    return v;
  };
  const num = (f, d) => {
    const v = val(f, null);
    if (v === null) return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${f} must be a number (got "${v}")`);
    return n;
  };

  const { openDb, aliasMembers } = await import('./store.mjs');
  const { hasClaude } = await import('./distill.mjs');
  const dry = has('--dry');
  const over = num('--over', DEFAULT_OVER);
  const batch = num('--batch', DEFAULT_BATCH);
  const limit = num('--limit', Infinity);
  const model = val('--model', 'sonnet');
  const project = val('--project', null);

  const db = openDb();
  const rows = selectLongTitles(db, { project, over, limit, aliasMembers });
  if (!rows.length) {
    console.log(`retitle: nothing to do — no active memory has a title over ${over} characters${project ? ` in ${project}` : ''}.`);
    return;
  }
  const calls = chunkBatches(rows, batch).length;
  console.log(`retitle: ${rows.length} memor${rows.length === 1 ? 'y' : 'ies'} with a title over ${over} chars${project ? ` in ${project}` : ''}`);
  console.log(`  ${calls} headless call(s) of up to ${batch} each, model ${model} — this COSTS TOKENS${dry ? ' (yes, even with --dry: the new titles have to come from somewhere)' : ''}`);

  if (!hasClaude()) {
    console.error("retitle: 'claude' CLI not found — install Claude Code first.");
    process.exit(1);
  }
  if (!has('--yes')) {
    if (!stdin.isTTY) { console.error('retitle: pass --yes to run without a terminal.'); process.exit(1); }
    const rl = createInterface({ input: stdin, output: stdout });
    const ok = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ok !== 'y' && ok !== 'yes') { console.log('retitle: cancelled.'); return; }
  }

  const t = await retitleAll(db, rows, {
    batch, over, model, dry,
    onBatch: (b) => { if (b.error) console.error(`  ✗ batch of ${b.size} failed — ${b.error}`); },
  });
  for (const { row, title } of t.results) console.log(formatBeforeAfter(row, title));
  console.log(`\n${dry ? '(dry run — nothing written) ' : '✔ '}${t.calls} call(s) · ${t.changed} retitled · ${t.skipped} left alone`);
  if (t.skipped) console.log('  left alone = the model returned nothing usable for them (not shorter, still too long, or malformed). They stay selected for a later run.');
}
