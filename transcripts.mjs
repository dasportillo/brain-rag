// Parse, chunk, and redact session transcripts from every registered host adapter:
//   - claude-code: Claude Code project transcripts (~/.claude/projects/**/*.jsonl)
//   - codex:       Codex session rollouts          (~/.codex/sessions/**/rollout-*.jsonl)
//   - opencode:    opencode sessions               (~/.local/share/opencode/opencode.db, SQLite)
// Every adapter normalizes to the same { turns, title, cwd } shape, so everything downstream
// (chunking, redaction, embeddings, store) is host-agnostic. Adding another agent = one
// registerAdapter() call (see ADAPTERS below and docs/ADAPTERS.md) — no dispatch code changes.
import './quiet.mjs'; // the opencode adapter reads SQLite: silence node:sqlite's ExperimentalWarning
import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';

export const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
export const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');
// opencode keeps every session in one SQLite file under its XDG data dir.
export const OPENCODE_DB = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');

// FALLBACK project name, from the dashified directory Claude Code uses:
//   /Users/x/.claude/projects/-Users-you-project-my-project/<sess>.jsonl
// -> "my-project"
// Only used when a transcript has no cwd (older transcripts); gitRootName is the primary source.
export function projectFromPath(filePath) {
  const m = filePath.match(/\/projects\/([^/]+)\//);
  if (!m) return 'unknown';
  return m[1].replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '') || m[1];
}

// The .git walk itself: nearest ancestor containing .git, as an ABSOLUTE path, or null when the
// cwd isn't inside a repo. Shared by gitRootName (project naming) and always.mjs (the standing
// opt-in stores repo ROOTS, so any subdir of a listed repo matches).
export function gitRoot(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) return worktreeMainRoot(dotGit) ?? dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root: not inside a repo
    dir = parent;
  }
}

// A linked WORKTREE has a `.git` FILE ("gitdir: <main>/.git/worktrees/<name>") instead of a
// directory. Naming the project after the worktree folder fragments one repo into many
// throwaway "projects" (Claude Code generates worktrees under <repo>/.claude/worktrees/<random>;
// measured 2026-09-21: 3 sessions of smd-rips filed under mutable-knitting-cherny & co, issue #30).
// Resolve to the MAIN repo root: the parent of the `.git` dir the pointer names. Falls back to the
// path shape when the pointer is unreadable; null = a regular repo (caller keeps `dir`).
function worktreeMainRoot(dotGit) {
  try {
    if (!statSync(dotGit).isFile()) return null;
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (m) {
      const gitdir = m[1].trim(); // …/<main>/.git/worktrees/<name>
      const wt = gitdir.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
      if (wt) return wt[1];
    }
  } catch { /* unreadable pointer: fall through to the path shape */ }
  const shape = dirname(dotGit).match(/^(.*)\/\.claude\/worktrees\/[^/]+$/);
  return shape ? shape[1] : null;
}

// PRIMARY project name: name a project by its GIT REPO, not the folder path — so the same repo is ONE
// project no matter which subdirectory Claude was launched in (…/repo and …/repo/src/x both → "repo").
// Walk up from the session's real cwd to the nearest .git; the project is that repo folder's name.
// Universal across OS/layout (no assumption about where projects live, unlike the dashified fallback).
// Falls back to the cwd's own basename when it isn't inside a repo. basename is a pure string op, so
// this still returns the repo name even if the folder was since deleted (only the .git probe needs disk).
export function gitRootName(cwd) {
  if (!cwd) return null;
  return basename(gitRoot(cwd) ?? cwd);
}

// Noise we do NOT want in the index (command wrappers, local stdout, harness reminders).
function isNoise(text) {
  const t = text.trimStart();
  // command wrappers, local stdout, harness reminders and notifications (tool/task) = noise
  return /^<(command-name|command-message|command-args|local-command|bash-|system-reminder|user-prompt-submit|task-notification|tool-notification)/.test(t)
    || /^\[SYSTEM NOTIFICATION/.test(t);
}

// Redact obvious secrets: the corpus contains JWTs, AWS keys, etc.
export function redact(text) {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT_REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[GOOGLE_KEY_REDACTED]')
    .replace(/sk-(?:proj-|ant-)?[A-Za-z0-9]{20,}/g, '[API_KEY_REDACTED]')       // OpenAI / Anthropic-style
    .replace(/xox[baprs]-[0-9A-Za-z-]{10,}/g, '[SLACK_TOKEN_REDACTED]')
    .replace(/gh[opsur]_[A-Za-z0-9]{30,}/g, '[GH_TOKEN_REDACTED]')              // ghp_/gho_/ghu_/ghs_/ghr_
    .replace(/-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/(:\/\/[^:@\s/]+:)[^@\s/]{3,}@/g, '$1[SECRET_REDACTED]@')          // password in a URL (user:pass@host)
    .replace(/(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b(["'\s]*[:=]["'\s]*)[^\s"'`]{6,}/gi, '$1$2[SECRET_REDACTED]'); // KEY=value / KEY: value (also DB_PASSWORD=…)
}

// A compact, low-noise descriptor of a tool call: "ToolName: <command|file|pattern|url|query>".
// It turns raw tool_use blocks into a searchable trace of what was DONE, without pulling in full
// tool inputs (which are huge and may contain secrets — redaction still runs on the result at ingest).
function toolAction(block) {
  const name = block.name || 'tool';
  const inp = block.input || {};
  const desc = inp.command || inp.cmd || inp.file_path || inp.filePath || inp.path || inp.pattern || inp.url || inp.query || inp.description || '';
  const d = String(desc).replace(/\s+/g, ' ').trim().slice(0, 100);
  return d ? `${name}: ${d}` : name;
}

// Reads a transcript once and returns { turns, title }:
//   turns  — user + assistant text; context-compaction summaries tagged role 'summary'; and one
//            role 'actions' turn per session — a compact trace of tool calls (files/commands/searches).
//   title  — the session's ai-title ("what this session was about"), or null.
// Noise (command wrappers, harness reminders) and raw `thinking` blocks are dropped.
export function parseTranscript(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const turns = [];
  let title = null;
  const actions = [];
  const seenAction = new Set();
  let lastTs = null, sessionId = null, cwd = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.timestamp) lastTs = obj.timestamp;
    if (!cwd && obj.cwd) cwd = obj.cwd; // real launch dir → used to name the project by its git repo

    if (obj.type === 'ai-title' && obj.aiTitle) {
      title = obj.aiTitle.trim() || title; // keep the latest title in the file
    } else if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
      const text = obj.message.content.trim();
      if (!text || isNoise(text)) continue;
      // A compaction summary is a system-written recap, not the user's words: tag it 'summary'.
      const role = obj.isCompactSummary ? 'summary' : 'user';
      turns.push({ role, text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null });
    } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const blocks = obj.message.content;
      const text = blocks
        .filter(b => b && b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n')
        .trim();
      if (text) turns.push({ role: 'assistant', text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null });
      // accumulate the tool calls (what was done) into a per-session action trace
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        const a = toolAction(b);
        if (!seenAction.has(a)) { seenAction.add(a); actions.push(a); }
      }
    }
  }
  // one compact "actions" turn per session — high-signal for "what did we do", low bloat (deduped, capped).
  if (actions.length) {
    turns.push({ role: 'actions', text: 'Actions taken in this session:\n' + actions.slice(0, 100).join('\n'), ts: lastTs, session: sessionId });
  }
  return { turns, title, cwd };
}

// ---------------------------------------------------------------------------
// Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
// ---------------------------------------------------------------------------

// Codex-injected user-role items that are NOT the user's words (harness config, env dumps).
function isCodexNoise(text) {
  const t = text.trimStart();
  return /^<(turn_aborted|environment_context|user_instructions|permissions|subagent_notification|\/?image)/.test(t)
    || t.startsWith('# AGENTS.md instructions')
    || t.startsWith('# Context from my IDE setup');
}

// Codex has no in-file title; ~/.codex/session_index.jsonl maps session id -> thread_name.
// Loaded lazily ONCE per process (ingest parses many rollouts in a row).
let codexTitles = null;
function codexTitle(sessionId, indexPath = join(homedir(), '.codex', 'session_index.jsonl')) {
  if (!sessionId) return null;
  if (!codexTitles) {
    codexTitles = new Map();
    if (existsSync(indexPath)) {
      for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.id && o.thread_name) codexTitles.set(o.id, o.thread_name);
        } catch { /* skip bad line */ }
      }
    }
  }
  return codexTitles.get(sessionId) ?? null;
}

// First bytes of a file without reading it whole (rollout first lines embed the full
// base_instructions blob, and discovery may probe many files).
function fileHead(filePath, n = 2048) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8', 0, read);
  } finally { closeSync(fd); }
}

// A rollout's first line is its session_meta — that's the format marker.
export function isCodexRollout(filePath) {
  return fileHead(filePath, 256).includes('"type":"session_meta"');
}

// The cwd of a transcript WITHOUT parsing the whole file (they can be megabytes): both hosts
// write a "cwd" field near the top — Codex in its first-line session_meta (before the huge
// base_instructions blob), Claude Code on every user/assistant line. Reads only the head.
export function headCwd(filePath, n = 2048) {
  const m = fileHead(filePath, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}
export const codexHeadCwd = (filePath) => headCwd(filePath);

// Cheap project label for a transcript — the same rule ingest applies after a full parse
// (git repo of the cwd, else the dashified path), fed from the file head (or the adapter's own
// cheap cwd lookup). Lets discovery over hundreds of transcripts (onboard, import) group by
// project without parsing any of them.
export function sessionProject(filePath) {
  const a = adapterFor(filePath);
  const cwd = a?.cwdOf ? a.cwdOf(filePath) : headCwd(filePath, 16384);
  return (cwd && gitRootName(cwd)) || projectFromPath(filePath);
}

// Codex counterpart of parseTranscript — same { turns, title, cwd } shape.
// Only response_item lines are read: event_msg lines duplicate them for the UI, and
// role 'developer' items are harness config, not conversation.
export function parseCodexRollout(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const turns = [];
  const actions = [];
  const seenAction = new Set();
  let cwd = null, sessionId = null, lastTs = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ?? null;
    if (ts) lastTs = ts;
    const p = obj.payload || {};

    if (obj.type === 'session_meta') {
      if (!cwd && p.cwd) cwd = p.cwd;
      if (!sessionId && (p.id || p.session_id)) sessionId = p.id || p.session_id;
    } else if (obj.type === 'response_item' && p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue;
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter(c => c && (c.type === 'input_text' || c.type === 'output_text') && c.text)
        .map(c => c.text).join('\n').trim();
      if (!text) continue;
      if (p.role === 'user' && (isNoise(text) || isCodexNoise(text))) continue;
      turns.push({ role: p.role, text, ts, session: sessionId });
    } else if (obj.type === 'response_item' && p.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(p.arguments || '{}'); } catch { /* keep name-only action */ }
      const a = toolAction({ name: p.name, input });
      if (!seenAction.has(a)) { seenAction.add(a); actions.push(a); }
    } else if (obj.type === 'response_item' && p.type === 'custom_tool_call') {
      const a = toolAction({ name: p.name, input: { description: p.input } });
      if (!seenAction.has(a)) { seenAction.add(a); actions.push(a); }
    } else if (obj.type === 'compacted' && typeof p.message === 'string' && p.message.trim()) {
      // Codex compaction recap — same role as Claude's isCompactSummary turns.
      turns.push({ role: 'summary', text: p.message.trim(), ts, session: sessionId });
    }
  }
  if (actions.length) {
    turns.push({ role: 'actions', text: 'Actions taken in this session:\n' + actions.slice(0, 100).join('\n'), ts: lastTs, session: sessionId });
  }
  return { turns, title: codexTitle(sessionId), cwd };
}

// ---------------------------------------------------------------------------
// opencode sessions (~/.local/share/opencode/opencode.db — SQLite, opencode ≥ 1.x)
// ---------------------------------------------------------------------------
// opencode has no per-session file: every session lives in one SQLite database (tables
// `session`, `message`, `part`). Everything else in brain-rag is keyed by a transcript PATH
// (keep.list, sessions.path, chunks.path), so each session gets a stable virtual path:
//   <opencode.db>#<session id>      e.g. /Users/me/.local/share/opencode/opencode.db#ses_f502…
// The database is only ever opened READ-ONLY; opencode keeps writing to it while we read (WAL).

export const opencodePath = (dbPath, sessionId) => `${dbPath}#${sessionId}`;
export function splitOpencodePath(p) {
  const m = String(p).match(/^(.*\.db)#(ses_[A-Za-z0-9]+)$/);
  return m ? { dbPath: m[1], sessionId: m[2] } : null;
}
export const isOpencodePath = (p) => splitOpencodePath(p) !== null;

const opencodeDbs = new Map(); // dbPath -> DatabaseSync (read-only), one per process
function openOpencodeDb(dbPath) {
  let db = opencodeDbs.get(dbPath);
  if (!db) {
    // getBuiltinModule = a synchronous, lazy load: hosts that never touch opencode never load SQLite here.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    opencodeDbs.set(dbPath, db);
  }
  return db;
}

// Per-session metadata from the latest listing: { cwd, parentId, mtimeMs, size }. list()
// refreshes it on every call (the MCP server is long-lived; a stale cache would hide new
// sessions), and stat/cwd fall back to a direct query for a path the listing hasn't seen.
const opencodeMeta = new Map();

// mtime = the newest write anywhere in the session (session row, messages or parts); size = the
// bytes of its message + part payloads. Together they play the (mtime, bytes) role a transcript
// file's stat plays for ingest's "unchanged → skip" check.
const OPENCODE_META_SQL = `
  SELECT s.id, s.directory, s.parent_id,
    MAX(s.time_updated,
        COALESCE((SELECT MAX(time_updated) FROM message m WHERE m.session_id = s.id), 0),
        COALESCE((SELECT MAX(time_updated) FROM part p WHERE p.session_id = s.id), 0)) AS mtime,
    COALESCE((SELECT SUM(LENGTH(data)) FROM message m WHERE m.session_id = s.id), 0)
      + COALESCE((SELECT SUM(LENGTH(data)) FROM part p WHERE p.session_id = s.id), 0) AS size
  FROM session s`;

const toMeta = (r) => ({ cwd: r.directory ?? null, parentId: r.parent_id ?? null, mtimeMs: Number(r.mtime) || 0, size: Number(r.size) || 0 });

export function listOpencodeSessions(dbPath = OPENCODE_DB) {
  if (!existsSync(dbPath)) return [];
  let rows;
  try { rows = openOpencodeDb(dbPath).prepare(OPENCODE_META_SQL).all(); }
  catch { return []; } // not an opencode DB we understand (older/newer schema): index nothing rather than guess
  return rows.map(r => {
    const p = opencodePath(dbPath, r.id);
    opencodeMeta.set(p, toMeta(r));
    return p;
  });
}

function opencodeSessionMeta(p) {
  const hit = opencodeMeta.get(p);
  if (hit) return hit;
  const ref = splitOpencodePath(p);
  if (!ref || !existsSync(ref.dbPath)) return null;
  try {
    const r = openOpencodeDb(ref.dbPath).prepare(`${OPENCODE_META_SQL} WHERE s.id = ?`).get(ref.sessionId);
    if (!r) return null;
    const meta = toMeta(r);
    opencodeMeta.set(p, meta);
    return meta;
  } catch { return null; }
}

// opencode's placeholder titles carry no meaning ("New session - 2026-09-17T13:51:50.321Z").
const placeholderTitle = (t) => !t || /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(t);
const jsonOr = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const isoOf = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// opencode counterpart of parseTranscript — same { turns, title, cwd } shape.
//   user messages      → their text parts, minus synthetic/ignored ones (harness-injected: the
//                        "Continue if you have next steps…" nudge after a compaction, tool echoes)
//   assistant messages → their text parts; a compaction run (summary:true / mode:'compaction')
//                        becomes role 'summary', like Claude's isCompactSummary turns
//   tool parts         → the per-session actions trace (same "Tool: <command|file|…>" style)
// Reasoning, step-start/step-finish, patch and file parts are dropped.
export function parseOpencodeSession(p) {
  const ref = splitOpencodePath(p);
  const empty = { turns: [], title: null, cwd: null };
  if (!ref || !existsSync(ref.dbPath)) return empty;
  const db = openOpencodeDb(ref.dbPath);
  const s = db.prepare('SELECT title, directory FROM session WHERE id = ?').get(ref.sessionId);
  if (!s) return empty;

  const msgs = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId);
  const partsByMsg = new Map();
  for (const row of db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id').all(ref.sessionId)) {
    const part = jsonOr(row.data, null);
    if (!part) continue;
    if (!partsByMsg.has(row.message_id)) partsByMsg.set(row.message_id, []);
    partsByMsg.get(row.message_id).push(part);
  }

  const turns = [];
  const actions = [];
  const seenAction = new Set();
  let lastTs = null;
  const session = ref.sessionId;

  for (const m of msgs) {
    const info = jsonOr(m.data, {});
    const ts = isoOf(info.time?.created ?? Number(m.time_created));
    if (ts) lastTs = ts;
    const parts = partsByMsg.get(m.id) ?? [];
    const text = parts
      .filter(pt => pt.type === 'text' && pt.text && !pt.synthetic && !pt.ignored)
      .map(pt => pt.text).join('\n').trim();

    if (info.role === 'user') {
      if (text && !isNoise(text)) turns.push({ role: 'user', text, ts, session });
    } else if (info.role === 'assistant') {
      if (text) {
        const role = (info.summary === true || info.mode === 'compaction') ? 'summary' : 'assistant';
        turns.push({ role, text, ts, session });
      }
      for (const pt of parts) {
        if (pt.type !== 'tool' || !pt.tool) continue;
        // opencode's built-in tools are lowercase (bash, read, edit); capitalize so the trace reads
        // like the other hosts' ("Bash: …") and an actions search matches across all of them.
        const name = pt.tool.charAt(0).toUpperCase() + pt.tool.slice(1);
        const a = toolAction({ name, input: pt.state?.input });
        if (!seenAction.has(a)) { seenAction.add(a); actions.push(a); }
      }
    }
  }
  if (actions.length) {
    turns.push({ role: 'actions', text: 'Actions taken in this session:\n' + actions.slice(0, 100).join('\n'), ts: lastTs, session });
  }
  return { turns, title: placeholderTitle(s.title) ? null : s.title.trim(), cwd: s.directory ?? null };
}

// ---------------------------------------------------------------------------
// Which host launched THIS process?
// ---------------------------------------------------------------------------
// keep_session / /brain must mark the session of the agent that called them — not just the newest
// transcript in the cwd, which may belong to another agent running in parallel on the same repo.
// opencode exports OPENCODE_PID to its MCP servers; checking it is an ANCESTOR (not just present)
// keeps a Claude session started from an opencode terminal — which inherits the variable — honest.
// Claude Code exports CLAUDECODE=1 to its MCP servers (no pid), so it is the weaker signal.
export function isAncestorPid(pid, { start = process.pid, ppidOf = defaultPpidOf, maxDepth = 12 } = {}) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 1) return false;
  let cur = start;
  for (let i = 0; i < maxDepth && cur > 1; i++) {
    const parent = ppidOf(cur);
    if (!parent) return false;
    if (parent === target) return true;
    cur = parent;
  }
  return false;
}
function defaultPpidOf(pid) {
  if (process.platform === 'win32') return null;
  if (pid === process.pid) return process.ppid;
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || null; }
  catch { return null; }
}

export function hostAdapterName(env = process.env, { isAncestor = isAncestorPid } = {}) {
  if (env.OPENCODE_PID && isAncestor(env.OPENCODE_PID)) return 'opencode';
  if (env.CLAUDECODE === '1') return 'claude-code';
  return null; // Codex exports nothing identifying: fall back to recency across every store
}

// ---------------------------------------------------------------------------
// Adapter registry — the ONE place that knows which agents write transcripts.
// ---------------------------------------------------------------------------
// An adapter describes one agent's session store:
//   name                    — stable id ('claude-code', 'codex', 'opencode', …)
//   root                    — where the agent writes sessions (a dir of .jsonl, or a DB file)
//   detect(path)            — cheap format sniff (path or file head; never a full parse)
//   parse(path)             — normalize to { turns, title, cwd }
//   currentSessionCwdMatch(path, cwd, root) — does this session belong to one launched from
//     `cwd`? (root is passed so tests can re-root an adapter)
//   probeCap (optional)     — when the cwd match costs I/O (reads the file head), only the
//     newest N files are probed in findCurrentTranscript; omit for pure-string matches.
// Optional, for stores that are NOT one .jsonl file per session (opencode: one SQLite DB):
//   list(root)              — every session path in the store (default: walkJsonl(root))
//   stat(path)              — { mtimeMs, size } of a session (default: fs.statSync)
//   exists(path)            — is the session still there? (default: fs.existsSync)
//   cwdOf(path)             — the session's cwd without a full parse (default: the file head)
//   current: false          — skip a session in findCurrentTranscript (e.g. a subagent child)
// Everything generic (dispatch, discovery, current-session lookup) iterates ADAPTERS, so another
// agent is one registerAdapter() call — see docs/ADAPTERS.md for the recipe.
export const ADAPTERS = [];
export function registerAdapter(adapter) {
  ADAPTERS.push(adapter);
  return adapter;
}

// Claude Code nests transcripts under the cwd with '/' and '_' replaced by '-'.
const dashify = (cwd) => String(cwd).replace(/[/_]/g, '-');

// Detection order = specificity: opencode first (its virtual path is a pure-string marker, and it
// must win before any adapter tries to open "<db>#<id>" as a file), then codex (its first line IS
// a definitive marker), then claude-code (per-line session fields — also parseSession's fallback,
// so a miss is harmless).
registerAdapter({
  name: 'opencode',
  root: OPENCODE_DB,
  detect: isOpencodePath,
  parse: parseOpencodeSession,
  list: (root) => listOpencodeSessions(root),
  stat: (p) => {
    const m = opencodeSessionMeta(p);
    if (!m) throw Object.assign(new Error(`opencode session not found: ${p}`), { code: 'ENOENT' });
    return { mtimeMs: m.mtimeMs, size: m.size };
  },
  exists: (p) => {
    const ref = splitOpencodePath(p);
    if (!ref || !existsSync(ref.dbPath)) return false;
    try { return !!openOpencodeDb(ref.dbPath).prepare('SELECT 1 FROM session WHERE id = ?').get(ref.sessionId); }
    catch { return true; } // DB busy/unreadable right now: never report "gone" (ingest would prune it)
  },
  cwdOf: (p) => opencodeSessionMeta(p)?.cwd ?? null,
  // A child session is a subagent run (opencode's task tool), never the conversation the user is in.
  currentSessionCwdMatch: (p, cwd) => {
    const m = opencodeSessionMeta(p);
    return !!m && !m.parentId && m.cwd === cwd;
  },
});
registerAdapter({
  name: 'codex',
  root: CODEX_SESSIONS,
  detect: isCodexRollout, // first line is its session_meta — unambiguous
  parse: parseCodexRollout,
  currentSessionCwdMatch: (filePath, cwd) => codexHeadCwd(filePath) === cwd,
  probeCap: 200, // the cwd match reads the file head — probe only the newest N rollouts
});
registerAdapter({
  name: 'claude-code',
  root: CLAUDE_PROJECTS,
  // No single-line marker like codex's; every transcript line carries session ids instead.
  detect: (filePath) => /"(sessionId|parentUuid|leafUuid)"/.test(fileHead(filePath, 512)),
  parse: parseTranscript,
  // Pure string check (no I/O): the file lives under the dashified-cwd project dir.
  currentSessionCwdMatch: (filePath, cwd, root = CLAUDE_PROJECTS) =>
    filePath.startsWith(join(root, dashify(cwd)) + '/'),
});

// The adapter that owns a path, or null. A detect that throws (a .jsonl deleted since it was
// listed) counts as "not mine" — callers fall back to the plain-file defaults.
export function adapterFor(p) {
  for (const a of ADAPTERS) {
    try { if (a.detect(p)) return a; } catch { /* unreadable: not this adapter */ }
  }
  return null;
}

// One entry point for every format: registry lookup via detect. Undetected files get the
// claude-code parser — the historical default, and harmless on foreign .jsonl (yields no turns).
export function parseSession(filePath) {
  const adapter = adapterFor(filePath);
  return adapter ? adapter.parse(filePath) : parseTranscript(filePath);
}

// Every session path across every adapter's store (absent stores contribute nothing).
export function listSessions(adapters = ADAPTERS) {
  return adapters.flatMap(a => (a.list ? a.list(a.root) : walkJsonl(a.root)));
}
// { mtimeMs, size } of any session path — a file's stat, or the adapter's equivalent.
export function sessionStat(p) {
  const a = adapterFor(p);
  return a?.stat ? a.stat(p) : statSync(p);
}
// Is the session still in its store? (ingest prunes the index entries of the ones that aren't)
export function sessionExists(p) {
  const a = isOpencodePath(p) ? adapterFor(p) : null; // plain files never need a detect probe
  return a?.exists ? a.exists(p) : existsSync(p);
}
// The session id a path stands for — what memories record as source_session. Claude names its
// transcripts <sessionId>.jsonl; opencode's virtual path carries the id after the '#'.
export function sessionRefOf(p) {
  const oc = splitOpencodePath(p);
  return oc ? oc.sessionId : basename(String(p), '.jsonl');
}

// All .jsonl transcripts under a root (any adapter's store); [] when the root doesn't exist.
export function walkJsonl(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkJsonl(p) : (e.name.endsWith('.jsonl') ? [p] : []);
  });
}

// The transcript being written RIGHT NOW: the newest session across every adapter's store,
// preferring candidates that belong to this cwd so a busy parallel session in another
// project doesn't steal the match — and, when the launching agent is known (hostAdapterName),
// candidates from THAT agent, so a parallel session of another agent on the same repo doesn't
// steal it either. Used by keep_session and mark-current.
// { claudeRoot, codexRoot, opencodeRoot } re-root the built-in adapters (the test surface);
// `host` overrides the detected launching agent (null = recency across every store).
export function findCurrentTranscript(cwd, {
  claudeRoot = CLAUDE_PROJECTS, codexRoot = CODEX_SESSIONS, opencodeRoot = OPENCODE_DB,
  host = hostAdapterName(),
} = {}) {
  const overrides = { 'claude-code': claudeRoot, codex: codexRoot, opencode: opencodeRoot };
  const all = [], matched = [], hostMatched = [];
  const mtime = new Map();
  for (const a of ADAPTERS) {
    const root = overrides[a.name] ?? a.root;
    const files = a.list ? a.list(root) : walkJsonl(root);
    const statOf = (f) => (a.stat ? a.stat(f) : statSync(f)).mtimeMs;
    for (const f of files) mtime.set(f, statOf(f));
    all.push(...files);
    // Cap-aware probe: when the cwd match reads the file (probeCap set), only the newest
    // probeCap files are checked; pure-string matches check everything.
    let probe = files;
    const cap = a.probeCap ?? Infinity;
    if (files.length > cap) {
      probe = [...files].sort((x, y) => mtime.get(y) - mtime.get(x)).slice(0, cap);
    }
    for (const f of probe) {
      if (!a.currentSessionCwdMatch(f, cwd, root)) continue;
      matched.push(f);
      if (a.name === host) hostMatched.push(f);
    }
  }
  const newest = (files) => {
    let best = null, bestM = -1;
    for (const f of files) {
      const m = mtime.get(f);
      if (m > bestM) { bestM = m; best = f; }
    }
    return best;
  };
  // Most specific first: this agent + this cwd; then any agent in this cwd; only when NO store
  // can be matched (e.g. the MCP server was launched with an unrelated cwd) fall back to pure
  // recency across everything. Null when no store has transcripts at all.
  return newest(hostMatched) ?? newest(matched) ?? newest(all);
}

// Splits a long text into ~size-char windows with overlap.
// NOTE (measured result): we tried ~900-char chunks split on lines and the eval REGRESSED
// 80%→70% (it diluted exact-term chunks like the groups-claim bug). Reverted to 1800.
export function chunkText(text, size = 1800, overlap = 200) {
  if (text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}
