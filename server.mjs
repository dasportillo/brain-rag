// GLOBAL MCP server: exposes your second brain to Claude Code in any project.
// Register with:  claude mcp add brain --scope user -- node ~/.claude/brain/server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, searchChunks, listProjects, BRAIN_DIR } from './store.mjs';
import { embedOne } from './embed.mjs';

const db = openDb();
const server = new McpServer(
  { name: 'brain', version: '0.1.0' },
  {
    instructions: [
      "This server is the user's \"second brain\": persistent memory of all their work",
      '(indexed history of Claude Code conversations + curated per-project state).',
      '',
      'WHEN TO USE IT (proactively, even if not asked with these exact words):',
      '- When the user asks about the STATE of something: "where did I leave off?", "give me the state of X",',
      '  "what do you know about this project?", "what state is X in?".',
      '  -> get_state(project) for the curated state.',
      '- When they ask about DECISIONS or PAST WORK: "what did we decide about Y?", "how did I solve Z?",',
      '  "what did we do with the ledger?", "search the brain for…". -> search_context(query).',
      '- BEFORE assuming there is no prior context on a project/decision: call search_context first.',
      '- When starting on an unfamiliar repo, a get_state/search_context gives the ramp-up context.',
      '',
      'TOOLS: get_state(project?) = curated "where I am today"; if missing, say so and offer to create it.',
      'search_context(query, project?, since?) = searches the WHOLE history. list_projects() = what is indexed and how fresh.',
      '',
      'NAME GOTCHA: the cwd is "dashified" (new_test -> new-test). If get_state finds nothing,',
      'run list_projects to get the exact name and retry.',
    ].join('\n'),
  }
);

// Auto-detect the current project from the cwd (same dashification Claude Code uses).
function currentProject() {
  const dashed = '-' + process.cwd().replace(/^\//, '').replace(/\//g, '-');
  return dashed.replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '');
}

server.tool(
  'search_context',
  'Searches the history of work conversations (all projects). Returns the most relevant chunks with project/date. USE IT when the user asks "what did we decide about X?", "how did I solve Y?", "what did we do with Z?", "search the brain for…", or before assuming there is no prior context on a topic. Recovers past decisions and work.',
  {
    query: z.string().describe('what to search for, in natural language'),
    project: z.string().optional().describe('filter to one project; omit to search all'),
    k: z.number().optional().describe('number of results (default 8)'),
    since: z.string().optional().describe('minimum ISO date, e.g. 2026-06-01'),
  },
  async ({ query, project, k = 8, since }) => {
    const qvec = await embedOne(query);
    const hits = searchChunks(db, qvec, { project: project ?? null, k, since: since ?? null, queryText: query });
    const text = hits.length
      ? hits.map(h => `### ${h.project} · ${h.ts?.slice(0, 10) ?? '?'} · ${h.role} (score ${h.score.toFixed(3)})\n${h.text}`).join('\n\n')
      : 'No results.';
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'list_projects',
  'Lists the projects indexed in the second brain, with session/chunk counts and last activity.',
  {},
  async () => {
    const rows = listProjects(db);
    const text = rows.map(r => `- ${r.project}: ${r.sessions} sessions, ${r.chunks} chunks, last ${r.last_activity?.slice(0, 10) ?? '?'}`).join('\n');
    return { content: [{ type: 'text', text: text || 'Index empty.' }] };
  }
);

server.tool(
  'get_state',
  'Returns the curated CURRENT state of a project (state/<project>.md), the precise source of "where I am today". USE IT when the user asks "where did I leave off?", "give me the state of X", "what state is X in?", "what do you know about this project?". If it does not exist, say so and offer to create it.',
  { project: z.string().optional().describe('project; defaults to the current cwd') },
  async ({ project }) => {
    const p = project || currentProject();
    const file = join(BRAIN_DIR, 'state', `${p}.md`);
    const text = existsSync(file)
      ? readFileSync(file, 'utf8')
      : `No curated state for "${p}". Create ${file} to set it.`;
    return { content: [{ type: 'text', text }] };
  }
);

await server.connect(new StdioServerTransport());
