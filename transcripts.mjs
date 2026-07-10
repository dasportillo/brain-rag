// Parse, chunk, and redact Claude Code .jsonl transcripts.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

// FALLBACK project name, from the dashified directory Claude Code uses:
//   /Users/x/.claude/projects/-Users-you-project-my-project/<sess>.jsonl
// -> "my-project"
// Only used when a transcript has no cwd (older transcripts); gitRootName is the primary source.
export function projectFromPath(filePath) {
  const m = filePath.match(/\/projects\/([^/]+)\//);
  if (!m) return 'unknown';
  return m[1].replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '') || m[1];
}

// PRIMARY project name: name a project by its GIT REPO, not the folder path — so the same repo is ONE
// project no matter which subdirectory Claude was launched in (…/repo and …/repo/src/x both → "repo").
// Walk up from the session's real cwd to the nearest .git; the project is that repo folder's name.
// Universal across OS/layout (no assumption about where projects live, unlike the dashified fallback).
// Falls back to the cwd's own basename when it isn't inside a repo. basename is a pure string op, so
// this still returns the repo name even if the folder was since deleted (only the .git probe needs disk).
export function gitRootName(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) return basename(cwd); // reached the filesystem root: not inside a repo
    dir = parent;
  }
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
  const desc = inp.command || inp.file_path || inp.path || inp.pattern || inp.url || inp.query || inp.description || '';
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
