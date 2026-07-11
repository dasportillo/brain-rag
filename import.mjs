// Backfill EXISTING conversations (Claude Code transcripts + Codex rollouts) into the brain:
// opt them into keep.list, then ingest. The brain is opt-in, so past conversations aren't
// indexed until you import them.
//   brain-rag import            # import ALL previous conversations
//   brain-rag import <filter>   # only paths/projects matching <filter> (substring)
//   brain-rag import --dry      # preview what would be imported — writes nothing, embeds nothing
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { walkJsonl, codexHeadCwd, gitRootName, ADAPTERS, CODEX_SESSIONS } from './transcripts.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const filter = args.find(a => !a.startsWith('--')) || null;

const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
const KEEP = join(BRAIN_DIR, 'keep.list');

// Grouping label: Claude → the dashified project dir; Codex → the repo of the rollout's
// recorded cwd (read from the file head, no full parse).
const projOf = (f) => f.match(/\/projects\/([^/]+)\//)?.[1]
  || (f.startsWith(CODEX_SESSIONS) ? `${gitRootName(codexHeadCwd(f)) ?? '?'} (codex)` : '?');

let files = ADAPTERS.flatMap(a => walkJsonl(a.root));
// Codex rollout paths are date/uuid-named, so match the filter against the project label too.
if (filter) files = files.filter(f => f.includes(filter) || projOf(f).includes(filter));

if (!files.length) {
  console.log(`No transcripts${filter ? ` matching "${filter}"` : ''} found under ${ADAPTERS.map(a => a.root).join(' or ')}.`);
  process.exit(0);
}
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
