// Ingesta INCREMENTAL de todos los transcripts de la máquina hacia el store.
//
// Cómo actualiza (la parte clave):
//   - Cada sesión = un archivo .jsonl. Guardamos su (mtime, bytes) en la tabla `sessions`.
//   - En cada corrida, por archivo:
//       * si no cambió (mismo mtime y bytes) -> SKIP (no re-embebe nada).
//       * si es nuevo o creció (sesión activa) -> borra sus chunks viejos y re-indexa SOLO ese.
//   - Resultado: la primera corrida indexa todo; las siguientes solo tocan lo nuevo/cambiado.
//
// Uso:
//   node ingest.mjs               # incremental, con embeddings
//   node ingest.mjs --no-embed    # solo parsea/chunkea/guarda (rápido, sin modelo)
//   node ingest.mjs --limit 5     # procesa hasta 5 sesiones (para probar)
//   node ingest.mjs --stats       # muestra el estado del índice y sale
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, vecToBlob, stats } from './store.mjs';
import { parseTurns, projectFromPath, chunkText, redact } from './transcripts.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
const LIMIT = Number(val('--limit', Infinity));
const NO_EMBED = has('--no-embed');
const FORCE = has('--force'); // re-procesa aunque no haya cambiado (p.ej. para backfill de embeddings)

function findTranscripts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findTranscripts(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const db = openDb();

if (has('--stats')) {
  console.log(stats(db));
  process.exit(0);
}

// El embedder se importa perezosamente: sin --no-embed no cargamos el modelo.
let embed = null;
if (!NO_EMBED) ({ embed } = await import('./embed.mjs'));

const files = findTranscripts(PROJECTS);
const getSession    = db.prepare('SELECT mtime, bytes FROM sessions WHERE path = ?');
const delChunks     = db.prepare('DELETE FROM chunks WHERE path = ?');
const insChunk      = db.prepare('INSERT INTO chunks(path,project,session,ts,role,text,embedding) VALUES(?,?,?,?,?,?,?)');
const upsertSession = db.prepare(`
  INSERT INTO sessions(path,project,session,mtime,bytes,chunks,indexed_at) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET
    project=excluded.project, session=excluded.session, mtime=excluded.mtime,
    bytes=excluded.bytes, chunks=excluded.chunks, indexed_at=excluded.indexed_at`);

let processed = 0, skipped = 0, totalChunks = 0;

for (const file of files) {
  if (processed >= LIMIT) break;
  const st = statSync(file);
  const mtime = Math.floor(st.mtimeMs);
  const prev = getSession.get(file);
  if (!FORCE && prev && prev.mtime === mtime && prev.bytes === st.size) { skipped++; continue; }

  const project = projectFromPath(file);
  const records = [];
  for (const turn of parseTurns(file)) {
    for (const piece of chunkText(redact(turn.text))) {
      // descartar chunks minúsculos (narración tipo "Let me check X" antes de un tool call)
      if (piece.trim().length < 80) continue;
      records.push({ session: turn.session, ts: turn.ts, role: turn.role, text: piece });
    }
  }

  let embeddings = [];
  if (embed && records.length) embeddings = await embed(records.map(r => r.text));

  db.exec('BEGIN');
  delChunks.run(file);
  records.forEach((r, i) => {
    const blob = embeddings[i] ? vecToBlob(embeddings[i]) : null;
    insChunk.run(file, project, r.session ?? null, r.ts ?? null, r.role, r.text, blob);
  });
  upsertSession.run(file, project, records[0]?.session ?? null, mtime, st.size, records.length, new Date().toISOString());
  db.exec('COMMIT');

  processed++;
  totalChunks += records.length;
  if (processed % 10 === 0 || records.length > 200) {
    console.log(`  [${processed}] ${project} — ${records.length} chunks`);
  }
}

console.log(`\n✔ ingest: ${processed} procesadas, ${skipped} sin cambios (skip), ${totalChunks} chunks nuevos${NO_EMBED ? ' (sin embeddings)' : ''}`);
console.log(stats(db));
