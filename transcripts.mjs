// Parse, chunk, and redact session transcripts from every registered host adapter:
//   - claude-code: Claude Code project transcripts (~/.claude/projects/**/*.jsonl)
//   - codex:       Codex session rollouts          (~/.codex/sessions/**/rollout-*.jsonl)
// Every adapter normalizes to the same { turns, title, cwd } shape, so everything downstream
// (chunking, redaction, embeddings, store) is host-agnostic. Adding a third agent = one
// registerAdapter() call (see ADAPTERS below and docs/ADAPTERS.md) — no dispatch code changes.
import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';

export const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
export const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

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
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root: not inside a repo
    dir = parent;
  }
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
  const desc = inp.command || inp.cmd || inp.file_path || inp.path || inp.pattern || inp.url || inp.query || inp.description || '';
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

// The cwd of a Codex rollout without parsing the whole file: session_meta is always the
// first line and cwd appears before the (huge) base_instructions blob.
export function codexHeadCwd(filePath) {
  const m = fileHead(filePath).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
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
// Adapter registry — the ONE place that knows which agents write transcripts.
// ---------------------------------------------------------------------------
// An adapter describes one agent's session store:
//   name                    — stable id ('claude-code', 'codex', …)
//   root                    — absolute dir the agent writes sessions under
//   detect(filePath)        — cheap format sniff (path or file head; never a full parse)
//   parse(filePath)         — normalize to { turns, title, cwd }
//   currentSessionCwdMatch(filePath, cwd, root) — does this file belong to a session
//     launched from `cwd`? (root is passed so tests can re-root an adapter)
//   probeCap (optional)     — when the cwd match costs I/O (reads the file head), only the
//     newest N files are probed in findCurrentTranscript; omit for pure-string matches.
// Everything generic (dispatch, discovery, current-session lookup) iterates ADAPTERS, so a
// third agent is one registerAdapter() call — see docs/ADAPTERS.md for the recipe.
export const ADAPTERS = [];
export function registerAdapter(adapter) {
  ADAPTERS.push(adapter);
  return adapter;
}

// Claude Code nests transcripts under the cwd with '/' and '_' replaced by '-'.
const dashify = (cwd) => String(cwd).replace(/[/_]/g, '-');

// Detection order = specificity: codex first (its first line IS a definitive marker), then
// claude-code (per-line session fields — also parseSession's fallback, so a miss is harmless).
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

// One entry point for every format: registry lookup via detect. Undetected files get the
// claude-code parser — the historical default, and harmless on foreign .jsonl (yields no turns).
export function parseSession(filePath) {
  const adapter = ADAPTERS.find(a => a.detect(filePath));
  return adapter ? adapter.parse(filePath) : parseTranscript(filePath);
}

// All .jsonl transcripts under a root (any adapter's store); [] when the root doesn't exist.
export function walkJsonl(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkJsonl(p) : (e.name.endsWith('.jsonl') ? [p] : []);
  });
}

// The transcript being written RIGHT NOW: the newest .jsonl across every adapter's store,
// preferring candidates that belong to this cwd so a busy parallel session in another
// project doesn't steal the match. Used by keep_session and mark-current.
// { claudeRoot, codexRoot } re-root the two built-in adapters (the historical test surface).
export function findCurrentTranscript(cwd, { claudeRoot = CLAUDE_PROJECTS, codexRoot = CODEX_SESSIONS } = {}) {
  const overrides = { 'claude-code': claudeRoot, codex: codexRoot };
  const all = [], matched = [];
  for (const a of ADAPTERS) {
    const root = overrides[a.name] ?? a.root;
    const files = walkJsonl(root);
    all.push(...files);
    // Cap-aware probe: when the cwd match reads the file (probeCap set), only the newest
    // probeCap files are checked; pure-string matches check everything.
    let probe = files;
    const cap = a.probeCap ?? Infinity;
    if (files.length > cap) {
      probe = files.map(f => ({ f, m: statSync(f).mtimeMs }))
        .sort((x, y) => y.m - x.m).slice(0, cap).map(x => x.f);
    }
    for (const f of probe) if (a.currentSessionCwdMatch(f, cwd, root)) matched.push(f);
  }
  const newest = (files) => {
    let best = null, bestM = -1;
    for (const f of files) {
      const m = statSync(f).mtimeMs;
      if (m > bestM) { bestM = m; best = f; }
    }
    return best;
  };
  // Prefer transcripts that provably belong to this cwd; only when NO store can be matched
  // (e.g. the MCP server was launched with an unrelated cwd) fall back to pure recency
  // across everything. Null when no store has transcripts at all.
  return newest(matched) ?? newest(all);
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
