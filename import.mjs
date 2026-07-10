// Backfill EXISTING Claude Code transcripts into the brain: opt them into keep.list, then ingest.
// The brain is opt-in, so past conversations aren't indexed until you import them.
//   brain-rag import            # import ALL previous conversations
//   brain-rag import <filter>   # only paths/projects matching <filter> (substring)
//   brain-rag import --dry      # preview what would be imported — writes nothing, embeds nothing
import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const filter = args.find(a => !a.startsWith('--')) || null;

const PROJECTS = join(homedir(), '.claude', 'projects');
const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const KEEP = join(BRAIN_DIR, 'keep.list');

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

let files = walk(PROJECTS);
if (filter) files = files.filter(f => f.includes(filter));

if (!files.length) {
  console.log(`No transcripts${filter ? ` matching "${filter}"` : ''} found under ${PROJECTS}.`);
  process.exit(0);
}

const projOf = (f) => f.match(/\/projects\/([^/]+)\//)?.[1] || '?';
const byProj = {};
for (const f of files) byProj[projOf(f)] = (byProj[projOf(f)] || 0) + 1;
const existing = new Set(existsSync(KEEP) ? readFileSync(KEEP, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);
const fresh = files.filter(f => !existing.has(f));

console.log(`import${filter ? ` (filter "${filter}")` : ''}: ${files.length} transcripts · ${Object.keys(byProj).length} projects · ${fresh.length} new, ${files.length - fresh.length} already opted in`);

if (DRY) {
  for (const [p, n] of Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(n).padStart(4)}  ${p}`);
  console.log('\n(dry run — nothing written, nothing embedded)');
  process.exit(0);
}

if (fresh.length) {
  mkdirSync(BRAIN_DIR, { recursive: true });
  appendFileSync(KEEP, fresh.join('\n') + '\n');
  console.log(`✔ added ${fresh.length} transcript(s) to keep.list — embedding now (first run downloads the model)…\n`);
} else {
  console.log('nothing new to add — re-running ingest to catch any grown sessions…\n');
}
await import('./ingest.mjs'); // indexes everything in keep.list, skipping unchanged files
