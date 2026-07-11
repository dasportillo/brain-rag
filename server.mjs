// GLOBAL MCP server: exposes your second brain to Claude Code and Codex in any project.
// Register with:  claude mcp add brain --scope user -- npx -y brain-rag serve
//            or:  codex mcp add brain -- npx -y brain-rag serve
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { openDb, searchChunks, listProjects, canonicalProject, recentActivity, wrapEvidence, BRAIN_DIR,
  saveMemory, searchMemories, MEMORY_TYPES, MEMORY_STATUSES } from './store.mjs';
import { buildContext } from './context.mjs';
import { gitRootName, findCurrentTranscript } from './transcripts.mjs';
import { embedOne, embed } from './embed.mjs';

const db = openDb();

// Cap per-hit text so a long chunk (e.g. a whole compaction summary) doesn't flood the model's
// context. Summaries get a larger budget since they are the coherent recap.
const clip = (t, n) => (t && t.length > n) ? t.slice(0, n).trimEnd() + ` … [+${t.length - n} chars]` : t;

const server = new McpServer(
  { name: 'brain', version: '0.8.1' },
  {
    instructions: [
      "This server is the user's \"second brain\": persistent memory of all their work",
      '(indexed history of Claude Code & Codex conversations + curated per-project state).',
      '',
      'WHEN TO USE IT (proactively, even if not asked with these exact words):',
      '- FIRST thing to call when starting work in a known repo: get_context(project) — the assembled',
      '  briefing (state + active decisions + recent knowledge + open TODOs + potential conflicts).',
      '  One call replaces get_state + several searches for session start / "where did I leave off" / ramp-up.',
      '- When the user asks about the STATE of something: "where did I leave off?", "give me the state of X",',
      '  "what do you know about this project?", "what state is X in?".',
      '  -> get_state(project) for the curated state.',
      '- When they ask about DECISIONS or PAST WORK: "what did we decide about Y?", "how did I solve Z?",',
      '  "what did we do with the ledger?", "search the brain for…". -> search_context(query).',
      '- BEFORE assuming there is no prior context on a project/decision: call search_context first.',
      '- When starting on an unfamiliar repo, a get_state/search_context gives the ramp-up context.',
      '- When wrapping up work, or asked to save/update the state: synthesize a concise note',
      '  (Now / In flight / Decisions / Blockers / Next) and call save_state(content, project).',
      '- When THIS conversation produced something worth remembering (a decision, a fix, a design,',
      '  non-obvious project context): call keep_session so it gets saved, AND distill the durable',
      '  pieces into save_memories (a decision with its why, a bug root cause, a solution). The brain',
      '  is OPT-IN, so an un-kept chat is lost. Do NOT keep trivial / throwaway / exploratory chats.',
      '',
      'TOOLS: get_context(project?) = the assembled session-start context (state note + active decisions + recent knowledge + open TODOs + conflicts, budgeted and cited) — call it FIRST in a known repo.',
      'get_state(project?) = curated "where I am today"; if no note exists it returns recent activity (NOT curated) — synthesize + save_state to persist.',
      'save_state(content, project?) = write/refresh that curated note (overwrites; drop reverted decisions).',
      'save_memories(memories[]) = write distilled, self-contained knowledge (typed: decision/bug/solution/…) with provenance; same title refreshes, supersedes:<id> retires outdated knowledge.',
      'keep_session() = save THIS conversation to the brain (call proactively when it is worth remembering).',
      'search_context(query, project?, since?, role?) = searches the WHOLE history (hybrid: semantic + exact-term). Put exact identifiers in the query verbatim — they match lexically. role:"summary" finds dense session recaps; role:"actions" finds what was done (commands/files).',
      '',
      'NAME GOTCHA: the cwd is "dashified" (new_test -> new-test). If get_state finds nothing,',
      'run list_projects to get the exact name and retry.',
    ].join('\n'),
  }
);

// The current session's project = the git repo of the cwd (matches how ingest names projects).
function currentProject() {
  return gitRootName(process.cwd());
}

// Best-effort session id for memory provenance: the transcript being written right now is
// named after the session (Claude: <sessionId>.jsonl · Codex: rollout-…-<id>.jsonl).
function currentSessionRef() {
  const t = findCurrentTranscript(process.cwd());
  return t ? basename(t, '.jsonl') : null;
}

server.tool(
  'get_context',
  'Assembles the FULL working context for a project in ONE call: curated state note + active decisions + recent knowledge + open TODOs + potential conflicts, size-budgeted with a sources footer. USE IT FIRST at session start, when the user asks "where did I leave off?", or to ramp up on a known repo — one call replaces get_state + several search_context calls. Model-free and instant. Falls back to recent activity when the project has no curated data yet.',
  { project: z.string().optional().describe('project; defaults to the current cwd') },
  async ({ project }) => {
    const p = canonicalProject(project || currentProject());
    const { text } = buildContext(db, p);
    if (text) {
      return { content: [{ type: 'text', text: wrapEvidence(text, 'the assembled project context') }] };
    }
    // No state note and no memories: same graceful fallback as get_state (recent raw activity,
    // clearly marked NOT curated) — a known-but-uncurated repo is an invitation, not an error.
    const recent = recentActivity(db, p, { days: 30, limit: 30 });
    const fallback = recent.length
      ? wrapEvidence(`No curated state or memories for "${p}" — showing recent activity instead (NOT curated; synthesize + save_state / save_memories to build the real context):\n\n` +
        recent.map(r => `[${r.ts?.slice(0, 10) ?? '?'} ${r.role}] ${clip(r.text.replace(/\s+/g, ' ').trim(), 400)}`).join('\n'))
      : `No brain data for "${p}" (no state note, no memories, no recent indexed activity). If the name is off, run list_projects for the exact one; use save_state / save_memories to start the context.`;
    return { content: [{ type: 'text', text: fallback }] };
  }
);

server.tool(
  'search_context',
  'Searches the history of work conversations (all projects). Returns the most relevant chunks with project/date. USE IT when the user asks "what did we decide about X?", "how did I solve Y?", "what did we do with Z?", "search the brain for…", or before assuming there is no prior context on a topic. Recovers past decisions and work.',
  {
    query: z.string().describe('what to search for, in natural language; INCLUDE exact identifiers verbatim (error strings, function names, ARNs) — the lexical leg matches them precisely'),
    project: z.string().optional().describe('filter to one project; omit to search all'),
    k: z.number().optional().describe('number of results (default 8)'),
    since: z.string().optional().describe('minimum ISO date, e.g. 2026-06-01'),
    role: z.enum(['user', 'assistant', 'summary', 'actions']).optional().describe("filter by turn type: 'summary' = compaction recaps (dense session overviews), 'actions' = commands/files touched, 'user'/'assistant' = the conversation itself"),
    layer: z.enum(['both', 'raw', 'memories']).optional().describe("'both' (default) = distilled memories first, then raw history; 'memories' = only the distilled layer; 'raw' = only transcript chunks"),
  },
  async ({ query, project, k = 8, since, role, layer = 'both' }) => {
    const qvec = await embedOne(query);
    // Layer 2 first: distilled memories are curated knowledge — shown above raw hits.
    const mems = layer !== 'raw'
      ? searchMemories(db, qvec, { project: project ?? null, k: layer === 'memories' ? k : Math.min(4, k), queryText: query })
      : [];
    const memBlock = mems.length
      ? '## Distilled memories (curated Layer 2 — prefer these; they carry status & provenance)\n\n' +
        mems.map(m => `★ #${m.id} [${m.type}] ${m.title} · ${m.project} · conf ${m.confidence} · ${m.updated_at?.slice(0, 10)}${m.supersedes ? ` · supersedes #${m.supersedes}` : ''}\n${clip(m.content, 800)}`).join('\n\n')
      : '';
    if (layer === 'memories') {
      return { content: [{ type: 'text', text: mems.length ? wrapEvidence(memBlock, 'the distilled memory store') : 'No memories match.' }] };
    }
    const hits = searchChunks(db, qvec, { project: project ?? null, k, since: since ?? null, queryText: query, role: role ?? null });
    // Temporal-version signal: warn when a hit has a newer near-duplicate, or mark the latest of a set.
    const versionNote = (h) => h.outdatedBy
      ? ` · ⚠️ SUPERSEDED — newer related entry on ${h.outdatedBy}`
      : (h.supersedes?.length ? ` · ✅ latest of ${new Set(h.supersedes).size + 1} versions (older: ${[...new Set(h.supersedes)].join(', ')})` : '');
    // Cross-project facet: announce when results blend projects — the same term can mean
    // different things per project (false friends), and an inline blend goes unnoticed.
    const facetLine = hits.facet
      ? `📂 Results span ${hits.facet.length} projects: ` +
        hits.facet.map(f => `${f.project} (${f.n})`).join(' · ') +
        `. The same term can mean different things per project — if some look off-topic, pass project: to scope.\n\n`
      : '';
    const rawBlock = hits.length
      ? (memBlock ? '## Raw history\n\n' : '') + facetLine +
        hits.map(h => `### ${h.project} · ${h.ts?.slice(0, 10) ?? '?'} · ${h.role}${h.title ? ` · "${h.title}"` : ''} (score ${h.score.toFixed(3)})${versionNote(h)}\n${clip(h.text, h.role === 'summary' ? 2000 : 1200)}`).join('\n\n')
      : '';
    const body = [memBlock, rawBlock].filter(Boolean).join('\n\n');
    return { content: [{ type: 'text', text: body ? wrapEvidence(body) : 'No results.' }] };
  }
);

server.tool(
  'save_memories',
  'Saves DISTILLED knowledge into the memory store (Layer 2) — durable facts, not conversation chunks. USE IT PROACTIVELY when this session produces something worth keeping: a decision (+why), a bug root cause, a solution, an architecture fact, a preference, a lesson. Each memory must be SELF-CONTAINED (readable without the conversation). Same title = refresh in place; pass supersedes:<id> to retire an outdated memory (the response warns about similar existing ones).',
  {
    memories: z.array(z.object({
      type: z.enum(MEMORY_TYPES),
      title: z.string().describe('short, specific, STABLE — saving the same title again refreshes that memory'),
      content: z.string().describe('self-contained: the fact/decision itself + the why + minimal context'),
      project: z.string().optional().describe('defaults to the current repo'),
      confidence: z.number().min(0).max(1).optional().describe('default 0.8'),
      status: z.enum(MEMORY_STATUSES).optional().describe("default 'active'; use 'experimental' for tentative knowledge"),
      supersedes: z.number().optional().describe('id of the memory this one replaces — retires it'),
      entities: z.array(z.string()).optional().describe('projects/services/resources this touches (e.g. ["efy3", "Aurora"])'),
      source_messages: z.array(z.string()).optional().describe('short verbatim quotes or ids from THIS conversation backing the memory'),
    })).min(1),
  },
  async ({ memories }) => {
    const vecs = await embed(memories.map(m => `${m.title}\n${m.content}`));
    const session = currentSessionRef();
    const lines = memories.map((m, i) => {
      try {
        const r = saveMemory(db, { ...m, project: m.project || currentProject(), source_session: session }, vecs[i]);
        return `✔ #${r.id} ${r.action} · [${m.type}] ${m.title}`
          + (r.superseded ? ` · retired #${r.superseded}` : '')
          + (r.similar ? ` · ⚠️ similar to ${r.similar.map(s => `#${s.id} "${s.title}"`).join(', ')} — if one is now outdated, save again with supersedes:<id>` : '');
      } catch (e) {
        return `✗ [${m.type}] ${m.title} — ${e.message}`;
      }
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
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
  'Returns the curated CURRENT state of a project (state/<project>.md), the precise source of "where I am today". USE IT when the user asks "where did I leave off?", "give me the state of X", "what state is X in?", "what do you know about this project?". If no curated note exists it falls back to recent indexed activity (clearly marked NOT curated) — synthesize it and save_state to persist the real note.',
  { project: z.string().optional().describe('project; defaults to the current cwd') },
  async ({ project }) => {
    const p = canonicalProject(project || currentProject());
    const file = join(BRAIN_DIR, 'state', `${p}.md`);
    if (existsSync(file)) {
      return { content: [{ type: 'text', text: wrapEvidence(readFileSync(file, 'utf8'), `the curated state note for "${p}"`) }] };
    }
    // No curated note: fall back to recent indexed activity so the caller gets raw material
    // instead of a dead end. Clearly marked as NOT curated — it's history, not a state note.
    const recent = recentActivity(db, p, { days: 30, limit: 30 });
    const text = recent.length
      ? wrapEvidence(`No curated state for "${p}" — showing recent activity instead (NOT curated; synthesize and save_state to fix that):\n\n` +
        recent.map(r => `[${r.ts?.slice(0, 10) ?? '?'} ${r.role}] ${clip(r.text.replace(/\s+/g, ' ').trim(), 400)}`).join('\n'))
      : `No curated state for "${p}" and no recent indexed activity. If the name is off, run list_projects for the exact one; use save_state to create the note.`;
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'save_state',
  'Writes/overwrites the curated CURRENT-STATE note for a project (state/<project>.md) — the precise "where I am today" layer that get_state serves. USE IT when the user asks to save/update the state, or at the end of a work session to persist decisions and current status. Pass a concise Markdown note (Now / In flight / Decisions / Blockers / Next). It OVERWRITES the previous note, so include everything still true — that is how reverted decisions get removed instead of resurfacing in search.',
  {
    content: z.string().describe('the full state note in Markdown (overwrites the previous one)'),
    project: z.string().optional().describe('project; defaults to the current cwd'),
  },
  async ({ content, project }) => {
    const p = canonicalProject(project || currentProject());
    const dir = join(BRAIN_DIR, 'state');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${p}.md`);
    writeFileSync(file, content.endsWith('\n') ? content : content + '\n');
    return { content: [{ type: 'text', text: `Saved state for "${p}" → ${file} (${content.length} chars).` }] };
  }
);

server.tool(
  'keep_session',
  'Marks THIS conversation to be saved into the brain (indexed when the session ends). The brain is OPT-IN — nothing is saved unless kept, so an un-kept chat is lost. USE IT PROACTIVELY, without being asked, when this conversation produced something worth remembering later: a decision, a solution/fix, a design, or non-obvious context about a project. Do NOT call it for trivial, throwaway, or purely exploratory chats. Idempotent.',
  {},
  async () => {
    // Works from BOTH hosts: the current session is the transcript being written right
    // now, whether it lives under ~/.claude/projects or ~/.codex/sessions.
    const newest = findCurrentTranscript(process.cwd());
    if (!newest) return { content: [{ type: 'text', text: 'No transcript found for the current session.' }] };
    const keep = join(homedir(), '.claude', 'brain', 'keep.list');
    const kept = existsSync(keep) ? readFileSync(keep, 'utf8').split('\n').map(s => s.trim()) : [];
    if (kept.includes(newest)) return { content: [{ type: 'text', text: 'This session is already marked to be saved.' }] };
    mkdirSync(join(homedir(), '.claude', 'brain'), { recursive: true });
    appendFileSync(keep, newest + '\n');
    return { content: [{ type: 'text', text: 'Saved. This conversation will be indexed into the brain when it ends.' }] };
  }
);

await server.connect(new StdioServerTransport());
