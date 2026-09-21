// CONSOLIDATE (issue #26) — the judge that cleans up after bulk distillation.
//
// `onboard` / batch `distill` extract each session in isolation, so a repo with hundreds of
// sessions yields near-duplicate memories, decisions still `active` next to the one that replaced
// them, and TODOs a later session resolved without closing. saveMemory only dedups on exact
// title; the similarity WARNING it emits (cosine >= 0.90) has no reader in headless mode.
//
// Division of labor, same as distill: the SERVER is deterministic (it proposes candidate clusters
// and applies verdicts), the AGENT judges (a headless `claude -p` per cluster). Nothing is ever
// deleted — losers are retired to `superseded` and stay searchable with status:any.
//
//   brain-rag consolidate --project X            # judge + apply for one project (alias-aware)
//   brain-rag consolidate --project X --dry      # list clusters only; spends NOTHING
//   brain-rag consolidate --project X --review   # judge, then approve each verdict before applying
//   brain-rag consolidate --all-projects         # every project with >= 2 active memories
//   brain-rag consolidate ... --model M          # judge model (default: sonnet)
//   brain-rag consolidate ... --concurrency N    # parallel judges (default 2)
//   brain-rag consolidate ... --limit N          # clusters per run
//   brain-rag consolidate ... --sim T --lex T    # candidate thresholds (see clusterMemories)
//
// Why two signals for candidates: multilingual-e5-small clusters cosine HIGH (tangential
// technical text ~0.78-0.82, a genuine match ~0.85+; measured in brain-rag-cloud 2026-07-12), so
// a cosine threshold alone over-groups badly. Cosine AND lexical overlap must both agree for a
// pair to be PROPOSED — and proposing is all the server does; the judge decides.
//
// Importing runs nothing (tests import the pure helpers); main() runs via cli.mjs.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { MEMORY_TYPES, blobToVec } from './store.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, dep-free)
// ---------------------------------------------------------------------------

export const DEFAULT_SIM = 0.85; // cosine floor to PROPOSE a pair
export const DEFAULT_LEX = 0.15; // token-Jaccard floor to PROPOSE a pair
export const MAX_CLUSTER = 6;    // judge input stays small and focused

// Bilingual stopwords: enough to keep "the / de / que" from creating lexical overlap on their own.
const STOP = new Set(('the a an and or of to in on for with is are was were be by as at from that this it its ' +
  'el la los las un una unos unas y o de del al en con por para es son fue ser como que se su sus lo le ' +
  'not no si sí pero más mas muy ya hay este esta esto ese esa eso').split(' '));

// Lowercased, diacritics-stripped word set (length >= 3, stopwords removed) — the lexical leg.
export function tokenSet(text) {
  return new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/).filter(w => w.length >= 3 && !STOP.has(w)));
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }; // stored vectors are unit-norm

// Two memories may be judged together when they share a type — or when one is a TODO, because
// a TODO's natural partner is the non-TODO memory that resolved it.
export const comparable = (a, b) => a.type === b.type || a.type === 'todo' || b.type === 'todo';

// Propose clusters of near-duplicate ACTIVE memories of ONE project. rows carry {id, type, title,
// content, embedding: number[]|Float32Array|null, updated_at, ...}. A pair is linked when it is
// comparable AND cosine >= sim AND Jaccard >= lex; clusters are the connected components with
// >= 2 members, split into slices of `maxSize` (newest first) so each judge call stays small.
// Returns [{ key, members }] with members ordered newest → oldest; key = sorted ids joined.
export function clusterMemories(rows, { sim = DEFAULT_SIM, lex = DEFAULT_LEX, maxSize = MAX_CLUSTER } = {}) {
  const items = rows.filter(r => r.embedding).map(r => ({ r, tok: tokenSet(`${r.title} ${r.content}`) }));
  const parent = new Map(items.map(({ r }) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (!comparable(A.r, B.r)) continue;
      if (cosine(A.r.embedding, B.r.embedding) < sim) continue;
      if (jaccard(A.tok, B.tok) < lex) continue;
      union(A.r.id, B.r.id);
    }
  }
  const groups = new Map();
  for (const { r } of items) { const root = find(r.id); (groups.get(root) ?? groups.set(root, []).get(root)).push(r); }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) || b.id - a.id);
    for (let i = 0; i < members.length; i += maxSize) {
      const slice = members.slice(i, i + maxSize);
      if (slice.length >= 2) out.push({ key: clusterKey(slice.map(m => m.id)), members: slice });
    }
  }
  return out.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
}
export const clusterKey = (ids) => [...ids].map(Number).sort((a, b) => a - b).join(',');

// The judge sees every member in full, newest first, with dates — recency is the tie-breaker it
// needs to tell "superseded" from "duplicate".
export function buildJudgeInput(cluster) {
  return cluster.members.map(m =>
    `### #${m.id} [${m.type}] updated ${String(m.updated_at ?? '').slice(0, 10)}${m.created_at ? ` (created ${String(m.created_at).slice(0, 10)})` : ''}\n` +
    `title: ${m.title}\n${m.content}`).join('\n\n');
}

export function judgePrompt(input) {
  return `You are the consolidation judge for a developer team's "second brain" (a store of distilled engineering memories: decisions, bugs, solutions, facts, todos). Below is a CLUSTER of memories from ONE project that a similarity heuristic flagged as possibly redundant. The heuristic over-proposes on purpose: many clusters are NOT redundant. Decide what is true and output ONE verdict.

Verdicts:
- "keep": the memories are genuinely different knowledge (or the same topic seen from different angles worth keeping). Default when in doubt — retiring real knowledge is worse than a duplicate.
- "supersede": the same fact/decision, SAME type, and ONE member is the current, most complete version; the others are older or partial takes. Give keep_id and retire the rest.
- "merge": the same fact/decision, SAME type, but no single member is complete — write ONE merged memory (that type; stable title; self-contained content that unifies the facts, keeps every WHY, and states the current state) and retire those members.
- "close_todo": a todo member was RESOLVED by another (non-todo) member. Give resolved_by and retire the todo(s).

Rules:
- Types are boundaries. supersede and merge only combine memories of the SAME type. A fact/architecture/workflow note that stands on its own (e.g. where some code lives) is never folded into a todo, bug or incident memory — it must outlive them. When a cluster mixes types, the only options are keep or close_todo.
- close_todo only when a member explicitly states that the todo's action was DONE or DECIDED. A bug report, a finding, or an investigation note about the same topic does NOT close a todo that asks to decide or apply a fix.
- Never retire a memory that holds facts absent from the survivor. Never invent facts. Dates matter: newer usually wins on state, older may still hold the WHY. Ids must come from the cluster.

Think it through in "reason" FIRST, then commit to the verdict. OUTPUT ONLY a JSON object, no prose, no fences:
  {"reason":"...","verdict":"keep"}
  {"reason":"...","verdict":"supersede","keep_id":<id>,"retire":[<ids>]}
  {"reason":"...","verdict":"merge","merged":{"type":"<${MEMORY_TYPES.join('|')}>","title":"...","content":"...","confidence":0.0-1.0,"entities":["..."]},"retire":[<ids>]}
  {"reason":"...","verdict":"close_todo","resolved_by":<id>,"retire":[<todo ids>]}

--- CLUSTER ---
${input}`;
}

// Every balanced {...} substring that parses as a JSON object, left to right (string-aware).
function* jsonObjects(text) {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const v = JSON.parse(text.slice(i, j + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) yield v; } catch { /* keep scanning */ }
        break;
      }
    }
  }
}

// DEFENSIVE parse of the judge's output against the cluster it judged: every id must belong to
// the cluster, a survivor can't also be retired, a merge needs real content, close_todo may only
// retire todos — and TYPES ARE BOUNDARIES: supersede/merge may only retire members of the
// survivor's / merged type (measured 2026-09-21: sonnet folded a standalone code-location fact
// into a merged todo; the fact would have retired with the todo). Anything malformed or left
// with nothing valid to retire → null (the cluster is left alone, never half-applied).
export function parseVerdict(text, cluster) {
  if (typeof text !== 'string' || !text) return null;
  const ids = new Set(cluster.members.map(m => m.id));
  const byId = new Map(cluster.members.map(m => [m.id, m]));
  const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(Number))].filter(n => Number.isInteger(n) && ids.has(n)) : []);
  const reason = (o) => (typeof o.reason === 'string' ? o.reason.trim().slice(0, 500) : '');
  for (const o of jsonObjects(text)) {
    switch (o.verdict) {
      case 'keep':
        return { verdict: 'keep', reason: reason(o) };
      case 'supersede': {
        const keep_id = Number(o.keep_id);
        if (!ids.has(keep_id)) continue;
        const keepType = byId.get(keep_id).type;
        const retire = idList(o.retire).filter(id => id !== keep_id && byId.get(id).type === keepType);
        if (!retire.length) continue;
        return { verdict: 'supersede', keep_id, retire, reason: reason(o) };
      }
      case 'merge': {
        const m = o.merged;
        if (!m || typeof m !== 'object') continue;
        if (typeof m.title !== 'string' || !m.title.trim() || typeof m.content !== 'string' || !m.content.trim()) continue;
        const types = cluster.members.map(x => x.type).filter(t => t !== 'todo');
        const type = MEMORY_TYPES.includes(m.type) ? m.type : (types[0] ?? cluster.members[0].type);
        let retire = idList(o.retire);
        if (!retire.length) retire = [...ids];
        retire = retire.filter(id => byId.get(id).type === type).sort((a, b) => a - b);
        if (retire.length < 2) continue; // a "merge" of one memory is not a merge
        const conf = Number(m.confidence);
        const merged = { type, title: m.title.trim(), content: m.content.trim() };
        if (m.confidence != null && Number.isFinite(conf) && conf >= 0 && conf <= 1) merged.confidence = conf;
        if (Array.isArray(m.entities)) { const e = m.entities.filter(x => typeof x === 'string' && x.trim()); if (e.length) merged.entities = e; }
        return { verdict: 'merge', merged, retire, reason: reason(o) };
      }
      case 'close_todo': {
        const resolved_by = Number(o.resolved_by);
        const retire = idList(o.retire).filter(id => id !== resolved_by && byId.get(id)?.type === 'todo');
        if (!ids.has(resolved_by) || byId.get(resolved_by)?.type === 'todo' || !retire.length) continue;
        return { verdict: 'close_todo', resolved_by, retire, reason: reason(o) };
      }
      default: continue;
    }
  }
  return null;
}

// Provenance union of a set of members: every session any of them drew from.
export function unionSources(members) {
  const out = new Set();
  for (const m of members) {
    if (m.source_session) out.add(m.source_session);
    try { for (const s of JSON.parse(m.sources ?? '[]')) if (s) out.add(s); } catch { /* malformed → ignore */ }
  }
  return [...out];
}
const unionJson = (members, field) => {
  const out = new Set();
  for (const m of members) { try { for (const x of JSON.parse(m[field] ?? '[]')) if (x) out.add(x); } catch { /* ignore */ } }
  return [...out];
};

// ---------------------------------------------------------------------------
// DB-facing (tested with a temp DB and injected embed)
// ---------------------------------------------------------------------------

export function activeMemories(db, project) {
  return db.prepare(`SELECT id, type, project, title, content, confidence, status, supersedes, source_session,
      source_messages, sources, entities, embedding, created_at, updated_at
    FROM memories WHERE project = ? AND status = 'active' ORDER BY updated_at DESC, id DESC`).all(project)
    .map(r => ({ ...r, embedding: r.embedding ? blobToVec(r.embedding) : null }));
}

export function alreadyJudged(db, key) {
  return !!db.prepare('SELECT 1 FROM consolidations WHERE member_ids = ? LIMIT 1').get(key);
}

// Apply ONE validated verdict inside a transaction and record it in the ledger.
// Returns { verdict, result_id?, retired: [ids] }.
export async function applyVerdict(db, cluster, verdict, { embed } = {}) {
  const { saveMemory, retireMemories } = await import('./store.mjs');
  const project = cluster.members[0].project;
  const byId = new Map(cluster.members.map(m => [m.id, m]));
  const now = new Date().toISOString();
  const ledger = (result_id) => db.prepare(
    'INSERT INTO consolidations(project, member_ids, verdict, result_id, reason, judged_at) VALUES (?,?,?,?,?,?)')
    .run(project, cluster.key, verdict.verdict, result_id ?? null, verdict.reason || null, now);
  const inherit = db.prepare('UPDATE memories SET supersedes = COALESCE(supersedes, ?), sources = ?, updated_at = ? WHERE id = ?');

  if (verdict.verdict === 'keep') {
    ledger(null);
    return { verdict: 'keep', retired: [] };
  }

  if (verdict.verdict === 'supersede' || verdict.verdict === 'close_todo') {
    const survivorId = verdict.verdict === 'supersede' ? verdict.keep_id : verdict.resolved_by;
    const survivor = byId.get(survivorId);
    const losers = verdict.retire.map(id => byId.get(id)).filter(Boolean);
    db.exec('BEGIN');
    try {
      const retired = retireMemories(db, verdict.retire);
      // The survivor inherits the losers' provenance and points at the newest one it replaced,
      // and its updated_at moves so team sync re-pushes the enriched row.
      inherit.run(losers[0]?.id ?? null, JSON.stringify(unionSources([survivor, ...losers])), now, survivorId);
      ledger(survivorId);
      db.exec('COMMIT');
      return { verdict: verdict.verdict, result_id: survivorId, retired: retired ? verdict.retire : [] };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // merge: embed the new text, insert (saveMemory), retire the members. If the merged title
  // exactly matches a member, saveMemory REFRESHES that row instead — it becomes the survivor.
  const embedFn = embed ?? (await import('./embed.mjs')).embed;
  const [vec] = await embedFn([`${verdict.merged.title}\n${verdict.merged.content}`]);
  const members = verdict.retire.map(id => byId.get(id)).filter(Boolean);
  const newest = members[0];
  const entities = [...new Set([...(verdict.merged.entities ?? []), ...unionJson(members, 'entities')])];
  const mem = {
    ...verdict.merged, project,
    entities: entities.length ? entities : undefined,
    source_session: newest?.source_session ?? null,
    sources: unionSources(members),
    source_messages: unionJson(members, 'source_messages').slice(0, 6) || undefined,
    supersedes: undefined,
  };
  db.exec('BEGIN');
  try {
    const r = saveMemory(db, mem, vec);
    const toRetire = verdict.retire.filter(id => id !== r.id);
    retireMemories(db, toRetire);
    db.prepare('UPDATE memories SET supersedes = COALESCE(supersedes, ?), updated_at = ? WHERE id = ?')
      .run(toRetire[0] ?? null, now, r.id);
    ledger(r.id);
    db.exec('COMMIT');
    return { verdict: 'merge', result_id: r.id, retired: toRetire, refreshed: r.action === 'updated' };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Judge every un-judged cluster of a project with a bounded pool, then apply (unless dry, or
// `approve` says no). `run` = extractor (prompt, {model}) → text (injectable; default = the
// distill runner). Returns { clusters, judged, applied, skipped, failed, retired, results }.
export async function consolidateProject(db, project, {
  model, concurrency = 2, limit = Infinity, dry = false, sim, lex, run, embed, approve, onCluster,
} = {}) {
  const rows = activeMemories(db, project);
  const clusters = clusterMemories(rows, { sim, lex }).filter(c => !alreadyJudged(db, c.key)).slice(0, limit);
  const totals = { clusters: clusters.length, judged: 0, applied: 0, skipped: 0, failed: 0, retired: 0, results: [] };
  if (dry || !clusters.length) { totals.results = clusters.map(c => ({ cluster: c })); return totals; }

  const runFn = run ?? (await import('./distill.mjs')).runClaude;
  const verdicts = new Array(clusters.length);
  let next = 0;
  const worker = async () => {
    while (next < clusters.length) {
      const i = next++;
      try {
        const out = await runFn(judgePrompt(buildJudgeInput(clusters[i])), { model });
        let text = out;
        try { const o = JSON.parse(out); if (o && typeof o.result === 'string') text = o.result; } catch { /* raw */ }
        verdicts[i] = parseVerdict(text, clusters[i]) ?? { verdict: 'keep', reason: 'judge output unusable — left alone', unusable: true };
        totals.judged++;
      } catch (e) { verdicts[i] = { error: e.message }; totals.failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, clusters.length)) }, worker));

  // Apply sequentially (verdicts may touch the same rows; review prompts are one at a time).
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i], v = verdicts[i];
    if (v.error) { totals.results.push({ cluster, error: v.error }); onCluster?.(cluster, { error: v.error }); continue; }
    if (v.unusable) { totals.results.push({ cluster, verdict: v, skipped: true }); totals.skipped++; onCluster?.(cluster, v, { skipped: true }); continue; }
    if (approve && v.verdict !== 'keep' && !(await approve(cluster, v))) {
      totals.results.push({ cluster, verdict: v, skipped: true }); totals.skipped++; onCluster?.(cluster, v, { skipped: true }); continue;
    }
    const res = await applyVerdict(db, cluster, v, { embed });
    totals.applied++; totals.retired += res.retired.length;
    totals.results.push({ cluster, verdict: v, result: res });
    onCluster?.(cluster, v, res);
  }
  return totals;
}

// Projects with at least two active memories (candidates for --all-projects).
export function consolidatableProjects(db) {
  return db.prepare("SELECT project, COUNT(*) n FROM memories WHERE status = 'active' GROUP BY project HAVING n >= 2 ORDER BY n DESC").all();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const describeVerdict = (v) => {
  switch (v.verdict) {
    case 'keep': return `keep — ${v.reason || 'different knowledge'}`;
    case 'supersede': return `supersede — #${v.keep_id} stays, retire #${v.retire.join(', #')}${v.reason ? ` — ${v.reason}` : ''}`;
    case 'merge': return `merge → "${v.merged.title}" [${v.merged.type}], retire #${v.retire.join(', #')}${v.reason ? ` — ${v.reason}` : ''}`;
    case 'close_todo': return `close_todo — #${v.retire.join(', #')} resolved by #${v.resolved_by}${v.reason ? ` — ${v.reason}` : ''}`;
    default: return JSON.stringify(v);
  }
};
const describeCluster = (c) => c.members.map(m => `      #${m.id} [${m.type}] ${m.title}`).join('\n');

export async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
  const { openDb, aliasMembers } = await import('./store.mjs');
  const { hasClaude } = await import('./distill.mjs');
  const db = openDb();

  const dry = has('--dry'), review = has('--review');
  const model = val('--model', 'sonnet');
  const concurrency = Number(val('--concurrency', 2));
  const limit = Number(val('--limit', Infinity));
  const sim = Number(val('--sim', DEFAULT_SIM)), lex = Number(val('--lex', DEFAULT_LEX));

  let projects;
  if (has('--all-projects')) projects = consolidatableProjects(db).map(p => p.project);
  else if (val('--project', null)) projects = aliasMembers(val('--project'));
  else { console.error('consolidate: pass --project <name> or --all-projects.'); process.exit(1); }

  if (!dry && !hasClaude()) { console.error("consolidate: 'claude' CLI not found — the judge runs through it."); process.exit(1); }
  let approve = null;
  if (review && !dry) {
    if (!stdin.isTTY) { console.error('consolidate: --review needs a terminal.'); process.exit(1); }
    const rl = createInterface({ input: stdin, output: stdout });
    approve = async (c, v) => {
      console.log(`\n  cluster ${c.key}\n${describeCluster(c)}\n  → ${describeVerdict(v)}`);
      const a = (await rl.question('  apply? [y/N] ')).trim().toLowerCase();
      return a === 'y' || a === 'yes';
    };
    process.on('exit', () => rl.close());
  }

  const grand = { clusters: 0, judged: 0, applied: 0, skipped: 0, failed: 0, retired: 0 };
  for (const project of projects) {
    const t = await consolidateProject(db, project, {
      model, concurrency, limit, dry, sim, lex, approve,
      onCluster: approve ? null : (c, v, res) => {
        console.log(`  cluster ${c.key}\n${describeCluster(c)}`);
        if (res?.error) console.log(`    ✗ ${res.error}`);
        else console.log(`    → ${describeVerdict(v)}${res?.skipped ? ' (skipped)' : ''}${res?.result_id && v.verdict === 'merge' ? ` → #${res.result_id}` : ''}`);
      },
    });
    if (!t.clusters) { console.log(`▸ ${project}: no candidate clusters${dry ? '' : ' left to judge'}.`); continue; }
    console.log(`▸ ${project}: ${t.clusters} candidate cluster(s)${dry ? ' (dry — not judged)' : ''}`);
    if (dry) for (const { cluster } of t.results) console.log(`  cluster ${cluster.key}\n${describeCluster(cluster)}`);
    for (const k of Object.keys(grand)) grand[k] += t[k];
  }
  if (dry) console.log(`\n(dry run — ${grand.clusters} cluster(s) would be judged, one 'claude -p --model ${model}' each; nothing written, nothing spent)`);
  else console.log(`\n✔ consolidate: ${grand.judged} judged · ${grand.applied} applied · ${grand.retired} retired · ${grand.skipped} skipped · ${grand.failed} failed`);
}
