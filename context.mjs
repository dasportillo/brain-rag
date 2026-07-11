// CONTEXT BUILDER (v0.9): assembles the "session start" package for a project — curated state
// note → active decisions → recent knowledge → open TODOs → potential conflicts → sources —
// entirely from what is ALREADY stored. No embedding calls, no model load: with Layer 2
// populated this is assembly, not research, so it is deterministic, testable, and fast enough
// for a SessionStart hook (<1 s including node startup).
//
// Consumed three ways:
//   - server.mjs `get_context` MCP tool (wraps the text as evidence)
//   - `brain-rag context [project]` (plain CLI print)
//   - `brain-rag context --hook`   (SessionStart injection — prints ONLY for repos with brain data)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, canonicalProject, aliasMembers, wrapEvidence, blobToVec, dot, BRAIN_DIR } from './store.mjs';
import { gitRootName } from './transcripts.mjs';

// Budget is in TOKENS, approximated as chars/4 — good enough for a context budget, and it keeps
// this module free of any tokenizer dependency.
export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

// Per-section caps: the context is a briefing, not a dump — the sources footer carries the ids,
// so anything clipped here is one search_context away.
const CAP_DECISIONS = 6;
const CAP_KNOWLEDGE = 6;
const CAP_TODOS = 10;
const CAP_CONFLICTS = 5;
const CONFLICT_COS = 0.88; // same-type actives at/above this cosine are "probably the same knowledge twice"
const MEM_LINE_CHARS = 300; // per-memory content excerpt (one line each → clipping stays line-safe)

const flat = (s) => s.replace(/\s+/g, ' ').trim();

// One memory = ONE line (id + type + date, like server.mjs renders memories) so the budget
// clipper can drop whole memories, never split one mid-thought. Titles are flattened too:
// a model-written title with a newline would otherwise smuggle a line break into the "line"
// and break both the bullet rendering and the whole-line clipping guarantee.
function memLine(m) {
  const c = flat(m.content);
  const body = c.length > MEM_LINE_CHARS ? c.slice(0, MEM_LINE_CHARS).trimEnd() + '…' : c;
  return `- #${m.id} [${m.type}] ${flat(m.title)} · ${m.updated_at?.slice(0, 10) ?? '?'} — ${body}`;
}

// Every ACTIVE memory for the project (all alias members), newest first. `id DESC` breaks the
// same-millisecond ties a batch save produces, keeping "newest first" deterministic.
function activeMemories(db, project) {
  const members = aliasMembers(project);
  if (!members.length) return [];
  return db.prepare(`
    SELECT id, type, title, content, supersedes, updated_at, embedding FROM memories
    WHERE status = 'active' AND project IN (${members.map(() => '?').join(',')})
    ORDER BY updated_at DESC, id DESC
  `).all(...members);
}

// Pairs of ACTIVE memories of the SAME project+type whose embeddings are near-duplicates
// (cosine >= CONFLICT_COS) with NEITHER superseding the other — i.e. two things claiming to be
// current truth about the same topic. This is SIGNAL, not judgment: the store never retires
// knowledge on similarity alone (see saveMemory), so the agent resolves via supersedes.
// Newest pairs first, capped at 5. O(n²) per type — the memory store stays small by design.
export function detectConflicts(db, project) {
  const rows = activeMemories(db, project).filter(r => r.embedding);
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push({ ...r, vec: blobToVec(r.embedding) });
  }
  const lite = (m) => ({ id: m.id, type: m.type, title: flat(m.title), updated_at: m.updated_at }); // flat: titles render on one-line bullets
  const out = [];
  for (const [type, mems] of byType) {
    for (let i = 0; i < mems.length; i++) {
      for (let j = i + 1; j < mems.length; j++) {
        const a = mems[i], b = mems[j]; // rows come newest-first, so a is the newer of the pair
        if (a.supersedes === b.id || b.supersedes === a.id) continue; // explicitly linked ≠ conflict
        const cos = dot(a.vec, b.vec);
        if (cos < CONFLICT_COS) continue;
        out.push({ a: lite(a), b: lite(b),
          reason: `both ACTIVE [${type}] with cosine ${cos.toFixed(2)} — likely the same knowledge twice; neither supersedes the other` });
      }
    }
  }
  // newest-first across types (by the newer member of each pair; pairs inherit the newest-first
  // row order within a type, so this only has to arbitrate across types)
  const newest = (c) => c.a.updated_at ?? '';
  return out.sort((x, y) => newest(y).localeCompare(newest(x))).slice(0, CAP_CONFLICTS);
}

// Gate for the SessionStart hook: inject ONLY where the brain knows the repo at all —
// a curated state note, distilled memories, or indexed transcript chunks. A hook that printed
// on unknown repos would spam every session. Pure (db + name in, boolean out) so it's testable.
export function shouldInject(db, project) {
  if (!project) return false;
  const p = canonicalProject(project);
  if (existsSync(join(BRAIN_DIR, 'state', `${p}.md`))) return true;
  const members = aliasMembers(project);
  const ph = members.map(() => '?').join(',');
  if (db.prepare(`SELECT 1 FROM memories WHERE project IN (${ph}) LIMIT 1`).get(...members)) return true;
  if (db.prepare(`SELECT 1 FROM chunks   WHERE project IN (${ph}) LIMIT 1`).get(...members)) return true;
  return false;
}

// Keep whole lines while they fit; '…' marks the cut (only when it itself fits). Never mid-line.
function clipLines(lines, budgetChars) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1; // +1 = the newline it costs in the render
    if (used + cost > budgetChars) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length < lines.length && used + 2 <= budgetChars) kept.push('…');
  return kept;
}

// Assemble the context package for a project. Returns { text, sources }:
//   text    — the ordered, budgeted Markdown briefing ('' when the project has no state AND no memories)
//   sources — { stateFile, memoryIds }: exactly what the text was built from (the footer's data)
// Budget (TOKENS ≈ chars/4) is enforced by clipping section BODIES proportionally to their size —
// headers and the sources footer always survive, and no line is ever cut in half.
export function buildContext(db, project, { budget = 3500 } = {}) {
  const p = canonicalProject(project);
  const sources = { stateFile: null, memoryIds: [] };
  const sections = []; // [{ header, lines }] in the fixed briefing order

  // (a) curated state note — the human-approved "where I am today" leads.
  const stateFile = join(BRAIN_DIR, 'state', `${p}.md`);
  if (existsSync(stateFile)) {
    sources.stateFile = stateFile;
    const lines = readFileSync(stateFile, 'utf8').split('\n').map(l => l.trimEnd());
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    sections.push({ header: '## State', lines });
  }

  // (b)–(d) Layer 2, partitioned: decisions carry the "why we do it this way", TODOs are the
  // open loop, everything else active+recent is supporting knowledge.
  const all = activeMemories(db, p);
  const decisions = all.filter(m => m.type === 'decision').slice(0, CAP_DECISIONS);
  const todos = all.filter(m => m.type === 'todo').slice(0, CAP_TODOS);
  const others = all.filter(m => m.type !== 'decision' && m.type !== 'todo').slice(0, CAP_KNOWLEDGE);
  const used = new Set();
  const pushMems = (header, mems) => {
    if (!mems.length) return;
    sections.push({ header, lines: mems.map(memLine) });
    for (const m of mems) used.add(m.id);
  };
  pushMems('## Active decisions', decisions);
  pushMems('## Recent knowledge', others);
  pushMems('## Open TODOs', todos);

  // (e) conflicts — surfaced, never silently blended; the agent resolves via supersedes.
  const conflicts = detectConflicts(db, p);
  if (conflicts.length) {
    sections.push({
      header: '## Potential conflicts (resolve via save_memories supersedes)',
      lines: conflicts.map(c => `- #${c.a.id} "${c.a.title}" vs #${c.b.id} "${c.b.title}" — ${c.reason}`),
    });
    for (const c of conflicts) { used.add(c.a.id); used.add(c.b.id); }
  }

  sources.memoryIds = [...used].sort((x, y) => x - y);
  if (!sections.length) return { text: '', sources }; // nothing curated → the caller decides the fallback

  // (f) one-line sources footer — the citation trail for everything above.
  const footer = 'Sources: ' + [
    sources.stateFile ? `state/${p}.md` : null,
    sources.memoryIds.length ? `memories ${sources.memoryIds.map(i => `#${i}`).join(' ')}` : null,
  ].filter(Boolean).join(' · ');

  // Budget: headers + footer are fixed cost (always kept); bodies share what remains
  // proportionally to their unclipped size, whole lines only.
  const budgetChars = Math.max(0, budget) * 4;
  const bodyLen = (s) => s.lines.reduce((n, l) => n + l.length + 1, 0);
  const fixed = sections.reduce((n, s) => n + s.header.length + 2, 0) + footer.length + 2; // +2 ≈ newline + blank separator
  const bodyTotal = sections.reduce((n, s) => n + bodyLen(s), 0);
  let final = sections;
  if (fixed + bodyTotal > budgetChars) {
    const avail = Math.max(0, budgetChars - fixed);
    final = sections.map(s => ({ header: s.header, lines: clipLines(s.lines, Math.floor(avail * bodyLen(s) / bodyTotal)) }));
  }
  const text = final.map(s => [s.header, ...s.lines].join('\n')).join('\n\n') + '\n\n' + footer;
  return { text, sources };
}

// CLI entry (`brain-rag context [project] [--hook]`). Exported instead of run-on-import so tests
// can import the pure helpers above without side effects (same pattern as distill.mjs/always.mjs).
export async function main() {
  const argv = process.argv.slice(2);
  const hook = argv.includes('--hook');

  if (hook) {
    // SessionStart hook: hooks inject stdout into the session, so print the context ONLY for
    // repos the brain knows — and NEVER fail (a broken hook would degrade every session start).
    try {
      let data = {};
      try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty/invalid stdin */ }
      const project = gitRootName(data.cwd || process.cwd());
      const db = openDb();
      if (project && shouldInject(db, project)) {
        const { text } = buildContext(db, canonicalProject(project));
        if (text) {
          console.log(wrapEvidence(text, `the brain's assembled context for "${canonicalProject(project)}"`));
        } else {
          // brain data exists but nothing curated yet (chunks only): a one-line pointer beats
          // silence — the model learns the brain knows this repo without any context bloat.
          console.log(`[brain] "${canonicalProject(project)}" has indexed history but no curated state or memories yet — use search_context / get_state to recover past context.`);
        }
      }
    } catch { /* never break session start */ }
    // NO process.exit(): stdout to a pipe is async on POSIX, so exiting here could truncate the
    // very context this hook exists to inject. Nothing keeps the loop alive (sqlite/fs are sync),
    // so returning exits 0 naturally once stdout has flushed.
    process.exitCode = 0;
    return;
  }

  const project = argv.find(a => !a.startsWith('--')) || gitRootName(process.cwd());
  const db = openDb();
  const p = canonicalProject(project);
  const { text } = buildContext(db, p);
  console.log(text || `No brain context for "${p}" (no state note, no memories). Run 'brain-rag stats' / list projects via the MCP server if the name looks off.`);
}
