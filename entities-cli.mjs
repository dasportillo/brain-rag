// CLI view of the heuristic entity graph (v1.0).
//   brain-rag entities                          top entities by mentions
//   brain-rag entities --project X              same, scoped to one project (alias-aware)
//   brain-rag entities <name>                   one entity: projects, recency, co-occurring
//   brain-rag entities --backfill [--limit N]   link entities for EXISTING chunks (idempotent)
import { openDb, linkEntities, entityStats, entityLookup } from './store.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
const project = val('--project', null);
const LIMIT = Number(val('--limit', Infinity));
// the first bare token that is neither a flag nor a flag's value = the entity name to look up
const name = args.find((a, i) => !a.startsWith('--') && !['--project', '--limit'].includes(args[i - 1])) ?? null;

const db = openDb();

if (has('--backfill')) {
  // One-shot backfill for chunks ingested BEFORE the entity graph existed. Idempotent:
  // entities dedupe via INSERT OR IGNORE inside linkEntities, and any chunk that already has
  // a mention row is skipped — so re-runs (or a partial --limit run resumed later) only
  // process what's left. --limit counts PROCESSED (non-skipped) chunks: skipped chunks are
  // free, so a resumed limited run advances past everything already linked instead of
  // re-scanning the same window and stopping. Chunks with no extractable entities are
  // re-processed each run; that's a few regexes per chunk, cheap enough to not warrant a
  // "seen" marker.
  const hasMention = db.prepare('SELECT 1 FROM entity_mentions WHERE chunk_id = ? LIMIT 1');
  const rows = db.prepare('SELECT id, project, ts, text FROM chunks ORDER BY id').all();
  let scanned = 0, skipped = 0, processed = 0, linkedChunks = 0, mentions = 0;
  db.exec('BEGIN');
  for (const r of rows) {
    if (processed >= LIMIT) break;
    scanned++;
    if (hasMention.get(r.id)) { skipped++; continue; }
    processed++;
    const n = linkEntities(db, { chunkId: r.id, project: r.project, ts: r.ts, text: r.text });
    if (n) { linkedChunks++; mentions += n; }
  }
  db.exec('COMMIT');
  const totals = db.prepare('SELECT (SELECT COUNT(*) FROM entities) e, (SELECT COUNT(*) FROM entity_mentions) m').get();
  console.log(`✔ backfill: ${scanned} chunks scanned, ${skipped} already linked (skip), ` +
    `${linkedChunks} chunks linked, ${mentions} mentions added — graph now: ${totals.e} entities, ${totals.m} mentions`);
  process.exit(0);
}

if (name) {
  const info = entityLookup(db, name);
  if (!info) {
    console.log(`No entity "${name}" in the graph. Names are stored verbatim as extracted — try the exact form, or run without a name for the overview.`);
    process.exit(1);
  }
  console.log(`\n${info.entity.name} [${info.entity.kind}] — ${info.mentionCount} mentions, last ${info.recentTs?.slice(0, 10) ?? '?'}\n`);
  console.log(`projects: ${info.projects.map(p => `${p.project} (${p.n})`).join(' · ') || '—'}`);
  if (info.coOccurring.length) {
    console.log(`co-occurs: ${info.coOccurring.map(c => `${c.name} [${c.kind}] ×${c.n}`).join(' · ')}`);
  }
  for (const m of info.recentMentions) {
    console.log(`\n[${m.ts?.slice(0, 10) ?? '?'}] ${m.project}\n   ${m.text.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
  }
} else {
  const rows = entityStats(db, { project, limit: 30 });
  if (!rows.length) {
    console.log(`Entity graph is empty${project ? ` for "${project}"` : ''}. New ingests link automatically; run 'brain-rag entities --backfill' for existing chunks.`);
    process.exit(0);
  }
  console.log(`\ntop entities${project ? ` [${project}]` : ''} (kind · name · mentions · projects · last)\n`);
  for (const r of rows) {
    console.log(`  ${r.kind.padEnd(12)} ${r.name.padEnd(44)} ${String(r.mentions).padStart(5)}  ${String(r.projects).padStart(2)}  ${r.last_ts?.slice(0, 10) ?? '?'}`);
  }
}
