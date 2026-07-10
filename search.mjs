// Command-line search (to test the RAG without the MCP).
//   node search.mjs "how the users documents bridge works"
//   node search.mjs --project my-project "audit hash chain"
import { openDb, searchChunks } from './store.mjs';
import { embedOne } from './embed.mjs';

const args = process.argv.slice(2);
const pi = args.indexOf('--project');
const project = pi >= 0 ? args[pi + 1] : null;
const skip = new Set(pi >= 0 ? [pi, pi + 1] : []);
const query = args.filter((_, i) => !skip.has(i)).join(' ').trim();

if (!query) { console.error('usage: node search.mjs [--project X] "query"'); process.exit(1); }

const db = openDb();
const qvec = await embedOne(query);
const hits = searchChunks(db, qvec, { project, k: 8, queryText: query });

console.log(`\n🔎 "${query}"${project ? ` [${project}]` : ''}\n`);
const versionNote = (h) => h.outdatedBy
  ? `  ⚠️ superseded → newer on ${h.outdatedBy}`
  : (h.supersedes?.length ? `  ✅ latest of ${new Set(h.supersedes).size + 1} (older: ${[...new Set(h.supersedes)].join(', ')})` : '');
for (const h of hits) {
  const when = h.ts ? h.ts.slice(0, 10) : '?';
  console.log(`[${h.score.toFixed(3)}] ${h.project} · ${when} · ${h.role}${h.title ? ` · "${h.title}"` : ''}${versionNote(h)}`);
  console.log(`   ${h.text.replace(/\s+/g, ' ').slice(0, 220)}\n`);
}
