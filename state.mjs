// Gather RECENT activity for a project from the brain, as raw material to synthesize its
// "current state" note (state/<project>.md, served by the MCP get_state tool).
//
//   node state.mjs --list                 # projects with activity
//   node state.mjs <project> [--limit 80] [--days 30]
//
// Prints the most recent chunks for the project in chronological order (oldest→newest), deduped.
// An LLM turns this into a concise state note; get_state then serves that note verbatim.
import { openDb, listProjects } from './store.mjs';

const args = process.argv.slice(2);
const valOf = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const db = openDb();

if (args.includes('--list') || args.length === 0) {
  for (const p of listProjects(db)) {
    console.log(`${p.last_activity?.slice(0, 10) ?? '?'}  ${String(p.sessions).padStart(3)} sess  ${p.project}`);
  }
  process.exit(0);
}

const project = args[0];
const limit = Number(valOf('--limit', 80));
const days = Number(valOf('--days', 30));
const cutoff = new Date(Date.now() - days * 86400000).toISOString();

// resolve project name (exact, else unique LIKE match)
let proj = project;
const exact = db.prepare('SELECT 1 FROM chunks WHERE project = ? LIMIT 1').get(project);
if (!exact) {
  const like = db.prepare('SELECT DISTINCT project FROM chunks WHERE project LIKE ?').all(`%${project}%`);
  if (like.length === 1) proj = like[0].project;
  else if (like.length > 1) { console.error(`ambiguous "${project}": ${like.map(r => r.project).join(', ')}`); process.exit(1); }
  else { console.error(`no activity for "${project}"`); process.exit(1); }
}

const rows = db.prepare(
  'SELECT ts, role, text FROM chunks WHERE project = ? AND ts >= ? ORDER BY ts DESC LIMIT ?'
).all(proj, cutoff, limit);

// dedup + chronological
const seen = new Set();
const chron = rows.filter(r => {
  const k = r.text.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (seen.has(k)) return false; seen.add(k); return true;
}).reverse();

console.log(`# Recent activity — ${proj}  (last ${days}d, ${chron.length} snippets)\n`);
for (const r of chron) {
  console.log(`[${r.ts?.slice(0, 10) ?? '?'} ${r.role}] ${r.text.replace(/\s+/g, ' ').trim().slice(0, 500)}\n`);
}
