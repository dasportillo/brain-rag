// v0.8 "automatic extraction" — BATCH memory extraction over already-indexed sessions.
// Per session, a headless `claude -p` reads a COMPACT digest (built from the session's chunks in
// the DB — never the raw transcript, which can be megabytes) plus the project's open TODOs, and
// prints a JSON array of memories; we validate and save them. The agent extracts, this module
// stores — the same division of labor as the in-session /distill (see distill-prompt.mjs).
//
//   brain-rag distill                      # up to 10 not-yet-distilled sessions, newest first
//   brain-rag distill --project X         # only that project's sessions (alias-aware)
//   brain-rag distill --session <path>    # one specific transcript (re-distills even if done)
//   brain-rag distill --limit N           # sessions per run (default 10 — each run costs tokens)
//   brain-rag distill --dry               # list what WOULD run; spends nothing
//   brain-rag distill --hook              # SessionEnd mode: distill the session from hook stdin
//
// NO top-level side effects: cli.mjs calls main(); tests import the pure helpers below.
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, aliasMembers, saveMemory, MEMORY_TYPES, BRAIN_DIR } from './store.mjs';
import { headlessDistillPrompt } from './distill-prompt.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, dep-free)
// ---------------------------------------------------------------------------

// Digest budget: enough signal to extract from, bounded cost per session. Per-section caps keep
// one oversized part (a huge compaction summary) from starving the rest — the actions trace at
// the END must survive, it's the strongest "what was actually done" signal.
const CAP_TOTAL = 12000;
const CAP_SUMMARY = 6000;
const CAP_USER = 1500;
const CAP_ACTIONS = 2500;

// Compact extraction input from a session's chunk rows ({ role, text }, in insertion order):
// title → the LAST 'summary' chunk (compaction recaps are progressive; the last is the complete
// one) → first + last user turns (intent at start, state at end) → the 'actions' trace.
// Assistant prose is deliberately omitted: the summary already condenses it at ~10x less bloat.
export function buildDistillInput(rows, title) {
  const clip = (t, n) => (t.length > n ? t.slice(0, n).trimEnd() + ' …' : t);
  const sections = [];
  if (title) sections.push(`# Session: ${title}`);
  const summary = [...rows].reverse().find(r => r.role === 'summary');
  if (summary) sections.push('## Summary\n' + clip(summary.text, CAP_SUMMARY));
  const users = rows.filter(r => r.role === 'user');
  if (users.length) sections.push('## First user message\n' + clip(users[0].text, CAP_USER));
  if (users.length > 1) sections.push('## Last user message\n' + clip(users[users.length - 1].text, CAP_USER));
  const actions = rows.find(r => r.role === 'actions');
  if (actions) sections.push('## ' + clip(actions.text, CAP_ACTIONS)); // text starts "Actions taken in this session:"
  const out = sections.join('\n\n');
  return out.length > CAP_TOTAL ? out.slice(0, CAP_TOTAL) : out;
}

// The project's open TODO memories, appended to the digest so the extractor can CLOSE them:
// a resolved TODO comes back as a memory with supersedes:<id> and retires (see distill-prompt.mjs).
export function formatOpenTodos(todos) {
  if (!todos?.length) return '';
  return '\n\n## Open TODOs for this project (if the session resolved one, emit its resolution with supersedes:<id>)\n'
    + todos.map(t => `- #${t.id} ${t.title} — ${String(t.content).replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n');
}

// Every balanced [...] substring that parses as a JSON array, left to right. String-aware
// (brackets inside "a[i]" don't count), and a malformed candidate just moves the scan on.
function* jsonArrays(text) {
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(i, j + 1));
          if (Array.isArray(v)) yield v;
        } catch { /* not JSON — keep scanning from the next '[' */ }
        break;
      }
    }
  }
}

// One extractor output item -> a clean memory object, or null. Whitelists fields (junk keys from
// the model never reach saveMemory) and validates each: unknown type / empty title/content kill
// the item; a bad OPTIONAL field is just dropped (better a memory without confidence than none).
function validMemory(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (!MEMORY_TYPES.includes(m.type)) return null;
  if (typeof m.title !== 'string' || !m.title.trim()) return null;
  if (typeof m.content !== 'string' || !m.content.trim()) return null;
  const out = { type: m.type, title: m.title.trim(), content: m.content.trim() };
  const conf = Number(m.confidence);
  if (m.confidence != null && Number.isFinite(conf) && conf >= 0 && conf <= 1) out.confidence = conf;
  if (Array.isArray(m.entities)) {
    const e = m.entities.filter(x => typeof x === 'string' && x.trim());
    if (e.length) out.entities = e;
  }
  if (Array.isArray(m.source_messages)) {
    const s = m.source_messages.filter(x => typeof x === 'string' && x.trim());
    if (s.length) out.source_messages = s;
  }
  const sup = Number(m.supersedes);
  if (m.supersedes != null && Number.isInteger(sup) && sup > 0) out.supersedes = sup;
  return out;
}

// DEFENSIVE parse of the extractor's output: models fence, preface, and postfix despite
// "OUTPUT ONLY". Scan every JSON array in the text and return the first that yields at least one
// valid memory (a stray "[]" in prose can't shadow the real payload); nothing valid -> [].
export function parseMemoriesJson(text) {
  if (typeof text !== 'string' || !text) return [];
  for (const arr of jsonArrays(text)) {
    const valid = arr.map(validMemory).filter(Boolean);
    if (valid.length) return valid;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Runtime (only reached via main() — never on import)
// ---------------------------------------------------------------------------

const KEEP_FILE = join(BRAIN_DIR, 'keep.list');
// Provenance key for a session row: the session id when the transcript recorded one, else the
// file's basename (they coincide for Claude transcripts, which are named <sessionId>.jsonl).
const sessionRef = (row) => row.session ?? basename(row.path, '.jsonl');
// ALL keys this session's memories may be filed under (pure; exported for tests). The MCP server
// records basename(transcript) as source_session — for Codex rollouts that's
// "rollout-<ts>-<uuid>" while row.session is the bare uuid — so the already-distilled skip must
// match EITHER key, or a Codex session distilled in-session via /distill wouldn't be recognized
// and the batch would re-pay its tokens (and re-save near-duplicate memories).
export const sessionRefs = (row) => [...new Set([row.session, basename(row.path, '.jsonl')])].filter(Boolean);

function hasClaude() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function openTodos(db, project) {
  const members = aliasMembers(project);
  if (!members.length) return [];
  return db.prepare(
    `SELECT id, title, content FROM memories WHERE project IN (${members.map(() => '?').join(',')}) AND type = 'todo' AND status = 'active'`
  ).all(...members);
}

// Distill ONE indexed session: digest -> headless claude -> parse -> embed -> save.
// Returns a one-line human summary (both the CLI loop and the hook log print it).
async function distillSession(db, row) {
  const chunks = db.prepare('SELECT role, text FROM chunks WHERE path = ? ORDER BY id').all(row.path);
  if (!chunks.length) return 'skipped (no indexed chunks — run ingest first)';
  const todos = openTodos(db, row.project);
  const input = buildDistillInput(chunks, row.title) + formatOpenTodos(todos);
  // 5-min timeout: a wedged extraction must not pin a background hook forever.
  const out = execFileSync('claude', ['-p', headlessDistillPrompt(input), '--output-format', 'json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  // --output-format json wraps the answer: {"type":"result","result":"<the model's text>", …}.
  // Unwrap when possible; parseMemoriesJson copes with raw text either way.
  let text = out;
  try { const o = JSON.parse(out); if (o && typeof o.result === 'string') text = o.result; } catch { /* raw text */ }
  const memories = parseMemoriesJson(text);
  if (!memories.length) return 'no durable memories extracted';
  // supersedes may only retire an OPEN TODO we actually showed — a hallucinated id must not
  // silently retire unrelated live knowledge (saveMemory would obey it).
  const todoIds = new Set(todos.map(t => t.id));
  for (const m of memories) if (m.supersedes && !todoIds.has(m.supersedes)) delete m.supersedes;

  const { embed } = await import('./embed.mjs'); // lazy: only the real save path loads the model
  const vecs = await embed(memories.map(m => `${m.title}\n${m.content}`));
  const lines = memories.map((m, i) => {
    const r = saveMemory(db, { ...m, project: row.project, source_session: sessionRef(row) }, vecs[i]);
    return `#${r.id} ${r.action} [${m.type}] ${m.title}${r.superseded ? ` (retired #${r.superseded})` : ''}`;
  });
  return `${memories.length} memories\n    ` + lines.join('\n    ');
}

// SessionEnd hook mode. A hook must NEVER break the host: every missing prerequisite (not
// opted in, no claude CLI, session not indexed) and every error ends in a quiet exit 0.
async function hookMain() {
  try {
    let data = {};
    try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty stdin */ }
    const tp = data.transcript_path;
    if (!tp) return;
    const kept = existsSync(KEEP_FILE) ? readFileSync(KEEP_FILE, 'utf8').split('\n').map(s => s.trim()) : [];
    if (!kept.includes(tp)) return; // extraction is opt-in, exactly like indexing
    if (!hasClaude()) return;
    const db = openDb();
    // The SessionEnd ingest hook runs in the background too — this session's chunks may not be
    // committed yet. Poll briefly (we're backgrounded ourselves, so waiting blocks nobody).
    for (let i = 0; i < 10 && !db.prepare('SELECT 1 FROM chunks WHERE path = ? LIMIT 1').get(tp); i++) {
      await new Promise(res => setTimeout(res, 3000));
    }
    const row = db.prepare('SELECT path, project, session, title FROM sessions WHERE path = ?').get(tp);
    if (!row) return;
    console.log(`[distill --hook] ${new Date().toISOString()} ${row.project} · ${row.path}`);
    console.log('  ' + await distillSession(db, row));
  } catch (e) {
    console.error(`[distill --hook] swallowed: ${e.message}`); // logged for distill.log, never rethrown
  }
  // NO process.exit() here: after the embedder loads, an explicit exit aborts onnxruntime's
  // native threads mid-teardown (SIGABRT, "mutex lock failed"). A natural return exits 0.
}

export async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f, d) => (has(f) ? args[args.indexOf(f) + 1] : d);
  if (has('--hook')) return hookMain();

  const project = val('--project', null);
  const session = val('--session', null);
  const limit = Number(val('--limit', 10));
  const db = openDb();

  let rows = db.prepare('SELECT path, project, session, title FROM sessions ORDER BY mtime DESC').all();
  if (project) { const m = new Set(aliasMembers(project)); rows = rows.filter(r => m.has(r.project)); }
  if (session) rows = rows.filter(r => r.path === session || r.path.includes(session));
  // Skip sessions that already produced memories: repeated runs walk the backlog instead of
  // re-paying tokens. An explicit --session re-distills on purpose.
  if (!session) {
    const done = new Set(db.prepare('SELECT DISTINCT source_session s FROM memories WHERE source_session IS NOT NULL').all().map(r => r.s));
    rows = rows.filter(r => !sessionRefs(r).some(ref => done.has(ref)));
  }
  const batch = rows.slice(0, limit);
  if (!batch.length) { console.log('distill: nothing to do (no matching un-distilled sessions).'); return; }

  if (has('--dry')) {
    console.log(`distill (dry): ${batch.length} session(s) would run — each spawns a headless 'claude -p', which COSTS TOKENS:`);
    for (const r of batch) console.log(`  ${r.project} · ${r.title ?? sessionRef(r)} · ${r.path}`);
    if (rows.length > batch.length) console.log(`  … ${rows.length - batch.length} more beyond --limit ${limit}`);
    return;
  }
  if (!hasClaude()) {
    console.error("distill: 'claude' CLI not found — install Claude Code, or distill in-session with /distill.");
    process.exit(1);
  }
  for (const r of batch) {
    try {
      console.log(`▸ ${r.project} · ${r.title ?? sessionRef(r)}\n  ${await distillSession(db, r)}`);
    } catch (e) {
      console.error(`✗ ${r.path} — ${e.message}`);
    }
  }
}
