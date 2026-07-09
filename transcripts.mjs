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
    .replace(/xox[baprs]-[0-9A-Za-z-]{10,}/g, '[SLACK_TOKEN_REDACTED]')
    .replace(/-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[GH_TOKEN_REDACTED]');
}

// Yields the useful turns (user text + assistant text blocks), dropping noise.
export function* parseTurns(filePath) {
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
      const text = obj.message.content.trim();
      if (!text || isNoise(text)) continue;
      yield { role: 'user', text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null };
    } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter(b => b && b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n')
        .trim();
      if (!text) continue;
      yield { role: 'assistant', text, ts: obj.timestamp ?? null, session: obj.sessionId ?? null };
    }
  }
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
