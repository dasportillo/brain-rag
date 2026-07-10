// Parse, chunk, and redact Claude Code .jsonl transcripts.
import { readFileSync } from 'node:fs';

// The project name comes from the dashified directory Claude Code uses:
//   /Users/x/.claude/projects/-Users-you-project-my-project/<sess>.jsonl
// -> "my-project"
export function projectFromPath(filePath) {
  const m = filePath.match(/\/projects\/([^/]+)\//);
  if (!m) return 'unknown';
  return m[1].replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '') || m[1];
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

// Reads a transcript once and returns { turns, title }:
//   turns  — the useful turns (user + assistant text), plus context-compaction summaries
//            tagged role 'summary' (they are system-written recaps, not the user's words).
//   title  — the session's ai-title ("what this session was about"), or null.
// Noise (command wrappers, harness reminders) is dropped.
export function parseTranscript(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const turns = [];
  let title = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'ai-title' && obj.aiTitle) {
      title = obj.aiTitle.trim() || title; // keep the latest title in the file
    } else if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
      const text = obj.message.content.trim();
      if (!text || isNoise(text)) continue;
      // A compaction summary is a system-written recap, not the user's words: tag it 'summary'.
      const role = obj.isCompactSummary ? 'summary' : 'user';
      turns.push({ role, text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null });
    } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter(b => b && b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n')
        .trim();
      if (!text) continue;
      turns.push({ role: 'assistant', text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null });
    }
  }
  return { turns, title };
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
