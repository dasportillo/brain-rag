// ONBOARD — turn a developer's EXISTING history into team memory in one guided run.
//
// The situation: a dev joins a team that adopts Brain-RAG Teams. They already have months of
// Claude Code / Codex transcripts on disk, and the team store starts empty. This command chains
// the whole ramp-up, with the two guards a raw `import` + `distill` loop lacks:
//   - project SELECTION is mandatory — personal repos must never be distilled into the company's
//     store (with auto-sync on, everything distilled flows to the team);
//   - the token cost is shown BEFORE anything is spent, and extraction runs on a cheap model.
//
//   brain-rag onboard                            # interactive: pick projects, confirm, run
//   brain-rag onboard --projects a,b [--yes]     # non-interactive selection (names from --dry)
//   brain-rag onboard --all --yes                # every project (you have been warned)
//   brain-rag onboard --dry                      # list projects + estimate; writes nothing, spends nothing
//   brain-rag onboard --limit N                  # cap distilled sessions (newest first; rerun to continue)
//   brain-rag onboard --concurrency N            # parallel extractions (default 3)
//   brain-rag onboard --model M                  # extraction model (default: sonnet)
//   brain-rag onboard --no-sync                  # keep memories local even if `cloud login` ran
//   brain-rag onboard --consolidate              # after distilling, judge near-duplicates (consolidate.mjs)
//
// Steps: discover → select → plan (+cost) → confirm → import (keep.list + ingest) → distill
// (concurrent, resumable, newest first) → [consolidate] → team sync → report. Every step is
// idempotent, so a rerun picks up where an interrupted run stopped. Consolidation runs BEFORE
// the sync on purpose: the team receives the cleaned set, not the raw one.
//
// Importing runs nothing (tests import the pure helpers); main() runs via cli.mjs.
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { walkJsonl, ADAPTERS, sessionProject } from './transcripts.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, dep-free)
// ---------------------------------------------------------------------------

// Group transcript paths by project label. `labelOf` is injectable (tests pass a map; the real
// run reads each file's head). Sorted by session count, descending. Each group carries the newest
// mtime seen (via `mtimeOf`) so the listing can show recency.
export function groupByProject(files, { labelOf = sessionProject, mtimeOf = (f) => statSync(f).mtimeMs } = {}) {
  const groups = new Map();
  for (const f of files) {
    const label = labelOf(f) || 'unknown';
    const g = groups.get(label) ?? { project: label, files: [], newest: 0 };
    g.files.push(f);
    const mt = mtimeOf(f) || 0;
    if (mt > g.newest) g.newest = mt;
    groups.set(label, g);
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length || a.project.localeCompare(b.project));
}

// Resolve a selection against the discovered groups. Accepts 1-based numbers from the printed
// list ("1,3"), project names (case-insensitive, exact), or "all". Returns { groups, unknown }
// so the caller can refuse a selection with typos instead of silently distilling the wrong repo.
export function resolveSelection(input, groups) {
  const tokens = String(input ?? '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!tokens.length) return { groups: [], unknown: [] };
  if (tokens.some(t => t.toLowerCase() === 'all')) return { groups: [...groups], unknown: [] };
  const byName = new Map(groups.map(g => [g.project.toLowerCase(), g]));
  const picked = new Set(), unknown = [];
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= groups.length) { picked.add(groups[n - 1]); continue; }
    const g = byName.get(t.toLowerCase());
    if (g) picked.add(g); else unknown.push(t);
  }
  return { groups: [...picked], unknown };
}

// Rough per-session token profile of one headless extraction: the digest is capped at 12k chars
// (~3.5k tokens) + the prompt scaffold (~1k) + the Claude Code CLI's own system prompt that every
// `claude -p` call carries (~14k, measured 2026-09-21), and the output is a small JSON array.
// Prices are the first-party API rates per 1M tokens (input, output) for the aliases `claude -p`
// accepts; an unknown model is priced like sonnet. This is an ESTIMATE shown before spending — a
// Claude Code subscription draws from the plan instead of billing per token, so it is an upper
// bound there.
export const EST_TOKENS = { input: 19000, output: 1000 };
const PRICES = {
  haiku: [1, 5],
  sonnet: [2, 10],
  opus: [5, 25],
};
export function estimateCost(sessions, model = 'sonnet') {
  const key = Object.keys(PRICES).find(k => String(model ?? '').toLowerCase().includes(k)) ?? 'sonnet';
  const [pin, pout] = PRICES[key];
  const perSession = (EST_TOKENS.input * pin + EST_TOKENS.output * pout) / 1e6;
  return { sessions, perSession, total: perSession * sessions, priced_as: key };
}

// What the run will actually do, given the selected groups and the current state. Pure: keep,
// done and indexed are Sets of transcript paths (caller reads them from keep.list and the DB).
//   toKeep     — selected transcripts not yet in keep.list (import will add them)
//   toDistill  — selected transcripts that have not produced memories yet (capped by limit).
//                Newest first so a partial run lands the CURRENT knowledge before the old.
export function planRun(groups, { keep, done, mtimeOf = (f) => statSync(f).mtimeMs, limit = Infinity } = {}) {
  const selected = groups.flatMap(g => g.files);
  const toKeep = selected.filter(f => !keep.has(f));
  const undistilled = selected.filter(f => !done.has(f) && !done.has(basename(f, '.jsonl')));
  undistilled.sort((a, b) => mtimeOf(b) - mtimeOf(a));
  const toDistill = undistilled.slice(0, limit);
  return { selected, toKeep, toDistill, beyondLimit: undistilled.length - toDistill.length };
}

export const fmtUsd = (n) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);
const fmtAge = (ms) => {
  if (!ms) return '';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : d < 60 ? `${d} days ago` : `${Math.floor(d / 30)} months ago`;
};

// ---------------------------------------------------------------------------
// Runtime (only reached via main())
// ---------------------------------------------------------------------------

export async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
  const DRY = has('--dry');
  const YES = has('--yes');
  const ALL = has('--all');
  const NO_SYNC = has('--no-sync');
  const CONSOLIDATE = has('--consolidate');
  const projectsArg = val('--projects', null);
  const limit = Number(val('--limit', Infinity));
  const concurrency = Number(val('--concurrency', 3));
  const model = val('--model', 'sonnet');

  // Lazy runtime imports: store.mjs reads BRAIN_DIR at load and cloud/distill pull it in — keep
  // the pure helpers above importable in tests without touching the real brain.
  const { openDb, BRAIN_DIR } = await import('./store.mjs');
  const { undistilledSessions, distillBatch, formatDistillResult, hasClaude } = await import('./distill.mjs');
  const { loadCloudConfig, pendingMemories, autoSync } = await import('./cloud.mjs');
  const KEEP = join(BRAIN_DIR, 'keep.list');

  // 1. Discover — every transcript of every host, grouped by project from the file head.
  const files = ADAPTERS.flatMap(a => walkJsonl(a.root));
  if (!files.length) {
    console.log(`onboard: no transcripts found under ${ADAPTERS.map(a => a.root).join(' or ')} — nothing to bring over.`);
    return;
  }
  const groups = groupByProject(files);
  console.log(`onboard: ${files.length} transcripts across ${groups.length} projects on this machine\n`);
  groups.forEach((g, i) => console.log(`  ${String(i + 1).padStart(3)}. ${g.project.padEnd(40)} ${String(g.files.length).padStart(4)} sessions   ${fmtAge(g.newest)}`));

  // 2. Select — mandatory. Whatever is selected is what may reach the team.
  let selection;
  if (ALL) selection = { groups, unknown: [] };
  else if (projectsArg != null) selection = resolveSelection(projectsArg, groups);
  else if (DRY) selection = { groups, unknown: [] }; // dry with no selection = show the full picture
  else if (!stdin.isTTY) {
    console.error('\nonboard: no terminal to ask which projects to include — pass --projects a,b (names or numbers above) or --all.');
    process.exit(1);
  } else {
    console.log('\nOnly the projects you pick are imported and distilled — and, if this machine is connected to a team,');
    console.log('their memories are what the team receives. Leave personal repos out.');
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question('Projects to include (numbers or names, comma-separated, or "all"): ');
    rl.close();
    selection = resolveSelection(answer, groups);
  }
  if (selection.unknown.length) {
    console.error(`onboard: unknown project(s): ${selection.unknown.join(', ')} — use the names or numbers listed above.`);
    process.exit(1);
  }
  if (!selection.groups.length) { console.log('onboard: nothing selected — exiting.'); return; }

  // 3. Plan — against the current state (keep.list + DB), so reruns show only what's left.
  const db = openDb();
  const keep = new Set(existsSync(KEEP) ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);
  const done = new Set(db.prepare('SELECT DISTINCT source_session s FROM memories WHERE source_session IS NOT NULL').all().map(r => r.s));
  const plan = planRun(selection.groups, { keep, done, limit });
  const cost = estimateCost(plan.toDistill.length, model);
  const cloud = NO_SYNC ? null : loadCloudConfig();
  const selectedProjects = new Set(selection.groups.map(g => g.project));
  // Memories already pending from OTHER projects would ride the same sync — say so, never surprise.
  const strayPending = cloud ? pendingMemories(db).filter(m => !selectedProjects.has(m.project)) : [];

  console.log(`\nPlan for ${selection.groups.length} project(s): ${selection.groups.map(g => g.project).join(', ')}`);
  console.log(`  import   ${plan.toKeep.length} transcript(s) to index (${plan.selected.length - plan.toKeep.length} already opted in)`);
  console.log(`  distill  ${plan.toDistill.length} session(s) via headless 'claude -p --model ${model}', ${concurrency} in parallel${plan.beyondLimit ? ` (${plan.beyondLimit} more beyond --limit ${limit})` : ''}`);
  console.log(`           ≈ ${fmtUsd(cost.total)} at API rates (${fmtUsd(cost.perSession)}/session, priced as ${cost.priced_as}; a Claude Code subscription draws from your plan instead)`);
  if (CONSOLIDATE) console.log(`  consolidate  judge near-duplicate memories per project before syncing (one 'claude -p' per candidate cluster)`);
  if (cloud) console.log(`  sync     memories → team store at ${cloud.endpoint}${cloud.auto === false ? ' (auto-sync is OFF — run `brain-rag cloud sync` afterwards)' : ''}`);
  else if (NO_SYNC) console.log('  sync     skipped (--no-sync): memories stay local');
  else console.log("  sync     not connected — memories stay local. Later: 'brain-rag cloud login' then 'brain-rag cloud sync'");
  if (strayPending.length) {
    console.log(`  ⚠ ${strayPending.length} already-pending memor${strayPending.length === 1 ? 'y' : 'ies'} from OTHER projects would sync too (${[...new Set(strayPending.map(m => m.project))].join(', ')}).`);
    console.log('    Pass --no-sync to keep everything local, or mark them private first.');
  }

  if (DRY) { console.log('\n(dry run — nothing written, nothing spent)'); return; }
  if (plan.toDistill.length && !hasClaude()) {
    console.error("\nonboard: 'claude' CLI not found — install Claude Code first (the extraction runs through it).");
    process.exit(1);
  }
  if (!YES) {
    if (!stdin.isTTY) { console.error('\nonboard: pass --yes to run without a terminal.'); process.exit(1); }
    const rl = createInterface({ input: stdin, output: stdout });
    const ok = (await rl.question('\nProceed? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ok !== 'y' && ok !== 'yes') { console.log('onboard: cancelled.'); return; }
  }

  // 4. Import — opt the selected transcripts in, then index everything in keep.list.
  if (plan.toKeep.length) {
    mkdirSync(BRAIN_DIR, { recursive: true });
    appendFileSync(KEEP, plan.toKeep.join('\n') + '\n');
    console.log(`\n✔ added ${plan.toKeep.length} transcript(s) to keep.list`);
  }
  console.log('▸ indexing (first run downloads the embedding model)…');
  // ingest.mjs reads its own flags from process.argv; strip ours so --limit/--dry never leak into it.
  process.argv = process.argv.slice(0, 2);
  await import('./ingest.mjs');

  // 5. Distill — only the selected transcripts, newest first, resumable across reruns.
  const paths = new Set(plan.toDistill);
  const rows = undistilledSessions(db, { paths });
  let totals = { done: 0, failed: 0, memories: 0 };
  if (rows.length) {
    console.log(`\n▸ distilling ${rows.length} session(s), ${concurrency} at a time (model: ${model})…`);
    let n = 0;
    totals = await distillBatch(db, rows, {
      concurrency, model,
      onResult: (r, res) => {
        n++;
        const head = `[${n}/${rows.length}] ${r.project} · ${r.title ?? basename(r.path, '.jsonl')}`;
        if (res.error) console.error(`  ✗ ${head} — ${res.error}`);
        else console.log(`  ${head}\n    ${formatDistillResult(res)}`);
      },
    });
  } else {
    console.log('\n▸ nothing left to distill for the selected projects.');
  }

  // 5b. Consolidate (opt-in) — judge near-duplicates in the projects we just fed, BEFORE the sync
  // so the team receives the cleaned set. Project names come from the DB rows (the authority),
  // not from the discovery labels.
  let consolidated = null;
  if (CONSOLIDATE) {
    const { consolidateProject, describeVerdict } = await import('./consolidate.mjs');
    const dbProjects = [...new Set(db.prepare(`SELECT DISTINCT project FROM sessions WHERE path IN (${[...paths].map(() => '?').join(',') || 'NULL'})`)
      .all(...paths).map(r => r.project))];
    consolidated = { clusters: 0, applied: 0, retired: 0, skipped: 0, failed: 0 };
    for (const p of dbProjects) {
      const t = await consolidateProject(db, p, {
        model, concurrency,
        onCluster: (c, v, res) => console.log(`  ${p} · cluster ${c.key} → ${res?.error ? `✗ ${res.error}` : describeVerdict(v)}${res?.skipped ? ' (skipped)' : ''}`),
      });
      if (t.clusters) console.log(`▸ consolidate ${p}: ${t.clusters} cluster(s) judged, ${t.applied} applied, ${t.retired} retired`);
      for (const k of Object.keys(consolidated)) consolidated[k] += t[k] ?? 0;
    }
    if (!consolidated.clusters) console.log('\n▸ consolidate: no near-duplicate clusters found.');
  }

  // 6. Sync — same best-effort contract as the SessionEnd hook.
  let team = null;
  if (cloud) {
    team = await autoSync(db);
    if (team?.pushed) console.log(`\n☁ synced ${team.pushed} memor${team.pushed === 1 ? 'y' : 'ies'} to the team store`);
    if (team?.rejected) console.log(`☁ ${team.rejected} rejected by the team store`);
    if (team?.offline) console.log('☁ team endpoint unreachable — memories kept pending; rerun `brain-rag cloud sync` when online');
    if (team === null) console.log('\n☁ auto-sync is off — run `brain-rag cloud sync` to push the new memories');
  }

  // 7. Report.
  console.log(`\n✔ onboard: ${plan.toKeep.length} imported · ${totals.done} distilled (${totals.failed} failed) · ${totals.memories} memories${consolidated ? ` · ${consolidated.retired} consolidated away` : ''}${team?.pushed ? ` · ${team.pushed} synced` : ''}`);
  if (plan.beyondLimit) console.log(`  ${plan.beyondLimit} older session(s) not distilled yet — rerun 'brain-rag onboard' to continue.`);
  if (totals.failed) console.log('  failed sessions are retried on the next run (they produced no memories).');
  if (!consolidated && totals.memories) console.log("  bulk distillation leaves near-duplicates — 'brain-rag consolidate --project <name> --dry' shows them; --consolidate does it inline next time.");
  console.log("  keep it growing: 'brain-rag always add' inside each team repo keeps every future session there.");
}
