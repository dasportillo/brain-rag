// Parseo, chunking y redacción de los transcripts .jsonl de Claude Code.
import { readFileSync } from 'node:fs';

// El nombre del proyecto sale del directorio dashificado que usa Claude Code:
//   /Users/x/.claude/projects/-Users-you-project-my-project/<sess>.jsonl
// -> "my-project"
export function projectFromPath(filePath) {
  const m = filePath.match(/\/projects\/([^/]+)\//);
  if (!m) return 'unknown';
  return m[1].replace(/^-Users-[^-]+-project-/, '').replace(/^-+/, '') || m[1];
}

// Ruido que NO queremos en el índice (wrappers de comandos, stdout local, reminders del harness).
function isNoise(text) {
  const t = text.trimStart();
  // wrappers de comandos, stdout local, reminders y notificaciones del harness (tool/task) = ruido
  return /^<(command-name|command-message|command-args|local-command|bash-|system-reminder|user-prompt-submit|task-notification|tool-notification)/.test(t)
    || /^\[SYSTEM NOTIFICATION/.test(t);
}

// Redacción de secretos obvios: el corpus tiene JWTs, keys AWS, etc.
export function redact(text) {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT_REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]')
    .replace(/xox[baprs]-[0-9A-Za-z-]{10,}/g, '[SLACK_TOKEN_REDACTED]')
    .replace(/-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[GH_TOKEN_REDACTED]');
}

// Genera los turnos útiles (user en texto + bloques text del assistant), descartando ruido.
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

// Corta un texto largo en ventanas de ~size chars con solape (chunk semántico simple).
export function chunkText(text, size = 1800, overlap = 200) {
  if (text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}
