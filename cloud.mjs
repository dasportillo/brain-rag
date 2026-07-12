// Team sync client (Brain-RAG Teams). PRIVACY CONTRACT, enforced here by construction:
// the sync payload is built ONLY from the memories table — chunks/transcripts are never
// read by this module, so raw history cannot leave the machine through this path.
// Memories marked private=1 stay local (searchable locally; excluded from sync).
//
//   brain-rag cloud login    # paste endpoint + API key (stored in BRAIN_DIR/cloud.json, 0600)
//   brain-rag cloud sync     # push new/changed non-private memories (incremental)
//   brain-rag cloud sync --review   # show exactly what WOULD be pushed, push nothing
//   brain-rag cloud auto on|off     # toggle auto-sync (ON by default after login)
//   brain-rag cloud status   # endpoint, org, seats, pending count, auto mode
//   brain-rag cloud logout   # remove the local credential
//
// Auto-sync (the product default): the MCP server calls autoSync() right after
// save_memories, so new team-safe knowledge flows without anyone running commands.
// The controls live where they don't add friction: private:true at write time keeps
// a memory local forever; retract in the dashboard unpublishes after the fact.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDb, blobToVec, BRAIN_DIR } from './store.mjs';

const CONF = join(BRAIN_DIR, 'cloud.json');

export function loadCloudConfig(path = CONF) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Memories that WOULD sync: non-private, active-or-retired alike (the team sees status),
// new or changed since the last push. Pure query — reused by sync, --review and status.
export function pendingMemories(db) {
  return db.prepare(`
    SELECT id, type, project, title, content, confidence, status, source_session, source_messages,
           entities, embedding, updated_at
    FROM memories
    WHERE private = 0 AND (synced_at IS NULL OR updated_at > synced_at)
    ORDER BY id
  `).all();
}

// DB row -> push payload item. The stored embedding blob is reused verbatim (Float32 ->
// number[]), so sync NEVER loads the embedding model. Rows without an embedding are
// skipped (cannot be searched cloud-side) and reported.
export function toPushItem(row) {
  if (!row.embedding) return null;
  const parse = (s) => { try { return s == null ? undefined : JSON.parse(s); } catch { return undefined; } };
  return {
    local_id: row.id,
    type: row.type,
    project: row.project,
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    status: row.status,
    entities: parse(row.entities),
    source_session: row.source_session ?? undefined,
    source_messages: parse(row.source_messages),
    embedding: Array.from(blobToVec(row.embedding)),
  };
}

async function api(conf, path, body, method = 'POST', { timeoutMs } = {}) {
  const res = await fetch(conf.endpoint.replace(/\/$/, '') + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Push core shared by CLI sync and autoSync: batches pending rows, marks synced,
// reports rejects (rejected rows stay pending so they resurface until fixed or
// marked private).
async function pushPending(conf, db, { timeoutMs, onReject } = {}) {
  const items = pendingMemories(db).map(toPushItem);
  const skipped = items.filter(i => i === null).length;
  const payload = items.filter(Boolean);
  const mark = db.prepare('UPDATE memories SET synced_at = ? WHERE id = ?');
  let pushed = 0, rejected = 0;
  for (let i = 0; i < payload.length; i += 50) {
    const batch = payload.slice(i, i + 50);
    const { results } = await api(conf, '/v1/memories/push', { memories: batch }, 'POST', { timeoutMs });
    const now = new Date().toISOString();
    results.forEach((r, j) => {
      if (r.action === 'rejected') { rejected++; onReject?.(batch[j], r); }
      else { pushed++; mark.run(now, batch[j].local_id); }
    });
  }
  return { pushed, rejected, skipped };
}

// Best-effort auto-sync for the save_memories hook: silent, bounded, and it must
// NEVER break a save — offline just leaves rows pending for the next attempt.
export async function autoSync(db) {
  const conf = loadCloudConfig();
  if (!conf || conf.auto === false) return null;
  try {
    return await pushPending(conf, db, { timeoutMs: 4000 });
  } catch {
    return { pushed: 0, rejected: 0, skipped: 0, offline: true };
  }
}

async function login() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const endpoint = (await rl.question('Team endpoint URL (e.g. https://api.brainteams.dev): ')).trim();
  const apiKey = (await rl.question('API key (brk_…): ')).trim();
  rl.close();
  if (!/^https?:\/\//.test(endpoint) || !/^brk_[a-f0-9]{40}$/.test(apiKey)) {
    console.error('✗ need a valid URL and a brk_ key'); process.exitCode = 1; return;
  }
  const me = await api({ endpoint, apiKey }, '/v1/me', null, 'GET');
  mkdirSync(BRAIN_DIR, { recursive: true });
  writeFileSync(CONF, JSON.stringify({ endpoint, apiKey, auto: true }, null, 2) + '\n', { mode: 0o600 });
  console.log(`✔ connected to "${me.org.name}" (${me.org.plan}) as ${me.user.email} — saved ${CONF}`);
  console.log('  auto-sync ON: new non-private memories push to the team as they are saved');
  console.log("  ('brain-rag cloud auto off' to disable; private:true always stays local)");
}

function setAuto(mode) {
  const conf = loadCloudConfig();
  if (!conf) { console.error('✗ not connected — run: brain-rag cloud login'); process.exitCode = 1; return; }
  if (!['on', 'off'].includes(mode)) { console.error('usage: brain-rag cloud auto <on|off>'); process.exitCode = 1; return; }
  writeFileSync(CONF, JSON.stringify({ ...conf, auto: mode === 'on' }, null, 2) + '\n', { mode: 0o600 });
  console.log(mode === 'on'
    ? '✔ auto-sync ON — new non-private memories push as they are saved'
    : '✔ auto-sync OFF — nothing leaves this machine until you run: brain-rag cloud sync');
}

async function sync({ review = false } = {}) {
  const conf = loadCloudConfig();
  if (!conf) { console.error('✗ not connected — run: brain-rag cloud login'); process.exitCode = 1; return; }
  const db = openDb();

  if (review) {
    const items = pendingMemories(db).map(toPushItem);
    const skipped = items.filter(i => i === null).length;
    const payload = items.filter(Boolean);
    console.log(`cloud sync --review: ${payload.length} memory(ies) WOULD be pushed${skipped ? `, ${skipped} skipped (no embedding)` : ''}. Nothing sent.\n`);
    for (const m of payload) console.log(`  [${m.type}] ${m.project} · ${m.title}`);
    console.log('\n(only these distilled memories leave the machine — never transcripts or chunks; mark one private via save_memories {private: true} to exclude it)');
    return;
  }

  const { pushed, rejected, skipped } = await pushPending(conf, db, {
    onReject: (item, r) => console.error(`  ✗ rejected: ${item.title} — ${r.error}`),
  });
  if (!pushed && !rejected) { console.log(`✔ nothing to sync${skipped ? ` (${skipped} without embedding skipped)` : ''}`); return; }
  console.log(`✔ synced ${pushed} memory(ies)${rejected ? `, ${rejected} rejected (fix locally and re-sync)` : ''}${skipped ? `, ${skipped} skipped (no embedding)` : ''}`);
}

async function status() {
  const conf = loadCloudConfig();
  if (!conf) { console.log('not connected (brain-rag cloud login)'); return; }
  const db = openDb();
  const pending = pendingMemories(db).length;
  try {
    const me = await api(conf, '/v1/me', null, 'GET');
    console.log(`org: ${me.org.name} (${me.org.plan}) · you: ${me.user.email} · members: ${me.members.length}`);
  } catch (e) { console.log(`endpoint unreachable: ${e.message}`); }
  console.log(`endpoint: ${conf.endpoint}\nauto-sync: ${conf.auto === false ? 'off' : 'on'}\npending to sync: ${pending}`);
}

export async function main() {
  const [action, arg] = process.argv.slice(2);
  const review = process.argv.includes('--review');
  switch (action) {
    case 'login':  await login(); break;
    case 'sync':   await sync({ review }); break;
    case 'auto':   setAuto(arg); break;
    case 'status': await status(); break;
    case 'logout': if (existsSync(CONF)) rmSync(CONF); console.log('✔ disconnected'); break;
    default:
      console.log('usage: brain-rag cloud <login|sync|auto on|off|status|logout>  (sync --review = dry run)');
      if (action) process.exitCode = 1;
  }
}
