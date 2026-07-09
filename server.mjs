// MCP server GLOBAL: expone tu segundo cerebro a Claude Code en cualquier proyecto.
// Se registra con:  claude mcp add brain --scope user -- node ~/.claude/brain/server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, searchChunks, listProjects, BRAIN_DIR } from './store.mjs';
import { embedOne } from './embed.mjs';

const db = openDb();
const server = new McpServer({ name: 'brain', version: '0.1.0' });

// Auto-detecta el proyecto actual desde el cwd (mismo dashificado que usa Claude Code).
function currentProject() {
  const dashed = '-' + process.cwd().replace(/^\//, '').replace(/\//g, '-');
  return dashed.replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '');
}

server.tool(
  'search_context',
  'Busca en el histórico de conversaciones de trabajo (todos los proyectos). Devuelve los fragmentos más relevantes con proyecto/fecha. Usalo para recuperar qué se decidió o se estuvo trabajando sobre un tema.',
  {
    query: z.string().describe('qué buscar, en lenguaje natural'),
    project: z.string().optional().describe('filtrar a un proyecto; omitir para buscar en todos'),
    k: z.number().optional().describe('cantidad de resultados (default 8)'),
    since: z.string().optional().describe('fecha ISO mínima, ej 2026-06-01'),
  },
  async ({ query, project, k = 8, since }) => {
    const qvec = await embedOne(query);
    const hits = searchChunks(db, qvec, { project: project ?? null, k, since: since ?? null, queryText: query });
    const text = hits.length
      ? hits.map(h => `### ${h.project} · ${h.ts?.slice(0, 10) ?? '?'} · ${h.role} (score ${h.score.toFixed(3)})\n${h.text}`).join('\n\n')
      : 'Sin resultados.';
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'list_projects',
  'Lista los proyectos indexados en el segundo cerebro, con nº de sesiones/chunks y última actividad.',
  {},
  async () => {
    const rows = listProjects(db);
    const text = rows.map(r => `- ${r.project}: ${r.sessions} sesiones, ${r.chunks} chunks, última ${r.last_activity?.slice(0, 10) ?? '?'}`).join('\n');
    return { content: [{ type: 'text', text: text || 'Índice vacío.' }] };
  }
);

server.tool(
  'get_state',
  'Devuelve el ESTADO ACTUAL curado de un proyecto (state/<project>.md), la fuente precisa de "en qué estoy parado hoy". Si no existe, avisa.',
  { project: z.string().optional().describe('proyecto; por defecto el del cwd actual') },
  async ({ project }) => {
    const p = project || currentProject();
    const file = join(BRAIN_DIR, 'state', `${p}.md`);
    const text = existsSync(file)
      ? readFileSync(file, 'utf8')
      : `No hay estado curado para "${p}". Creá ${file} para fijarlo.`;
    return { content: [{ type: 'text', text }] };
  }
);

await server.connect(new StdioServerTransport());
