// opencode host wiring: where its global config lives, and a COMMENT-PRESERVING edit of that
// config to register / unregister the `brain` MCP server.
//
// opencode has no `mcp remove`, and its `mcp add` is interactive, so install/uninstall edit the
// global config file directly. That file is usually JSONC (opencode.jsonc) and people keep notes
// in it as comments, so a JSON.parse → JSON.stringify round-trip would silently delete them. The
// edit here is TEXTUAL instead: comments and trailing commas are blanked with spaces (offsets stay
// aligned with the original), a tiny parser finds the byte ranges of `mcp` / `mcp.brain`, and only
// those ranges are spliced. The result is re-parsed before it is returned — a splice that would
// produce invalid config is refused, never written.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const opencodeConfigDir = ({ home = homedir(), env = process.env } = {}) =>
  // XDG only applies to the REAL home: a test passing a throwaway home must never reach the user's.
  (env.XDG_CONFIG_HOME && home === homedir()) ? join(env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode');

// opencode merges config.json, opencode.json and opencode.jsonc from its config dir; we edit the
// one the user already has (jsonc first — the documented default), else create opencode.json.
export function opencodeConfigFile(dir) {
  for (const f of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    if (existsSync(join(dir, f))) return join(dir, f);
  }
  return join(dir, 'opencode.json');
}

export const brainEntry = (name) => ({ type: 'local', command: ['npx', '-y', name, 'serve'] });

// ---------------------------------------------------------------------------
// JSONC → blanked JSON with the same offsets
// ---------------------------------------------------------------------------

// Replace // and /* */ comments and trailing commas with spaces (newlines kept), so the text is
// valid JSON whose every index still points at the same character of the original.
export function blankJsonc(text) {
  const out = text.split('');
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop); i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop); i = stop;
    } else i++;
  }
  // trailing commas: a ',' (outside strings) whose next non-space char closes the container.
  // Comments are already blanked, so "next non-space" can't land inside one.
  const s = out.join('');
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    } else if (s[j] === ',') {
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === '}' || s[k] === ']') out[j] = ' ';
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// A position-recording parser over blanked JSON
// ---------------------------------------------------------------------------
// value → { start, end (exclusive), type, members? } ; object members → { key, keyStart, value }

function parseAt(s, i) {
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function value() {
    ws();
    const start = i;
    const c = s[i];
    if (c === '{') {
      i++; const members = [];
      ws();
      if (s[i] === '}') { i++; return { start, end: i, type: 'object', members }; }
      for (;;) {
        ws();
        const keyStart = i;
        const k = str();
        ws(); if (s[i] !== ':') throw new Error(`expected ':' at ${i}`); i++;
        const v = value();
        members.push({ key: k, keyStart, value: v });
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return { start, end: i, type: 'object', members }; }
        throw new Error(`expected ',' or '}' at ${i}`);
      }
    }
    if (c === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return { start, end: i, type: 'array' }; }
      for (;;) {
        value(); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return { start, end: i, type: 'array' }; }
        throw new Error(`expected ',' or ']' at ${i}`);
      }
    }
    if (c === '"') { str(); return { start, end: i, type: 'string' }; }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected '${c}' at ${i}`);
    i += m[0].length;
    return { start, end: i, type: 'literal' };
  }
  function str() {
    if (s[i] !== '"') throw new Error(`expected string at ${i}`);
    const start = i; i++;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(s.slice(start, i));
  }
  const v = value();
  ws();
  if (i !== s.length) throw new Error(`trailing content at ${i}`);
  return v;
}

const member = (obj, key) => obj?.members?.find(m => m.key === key) ?? null;
const valid = (text) => { try { JSON.parse(blankJsonc(text)); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
// The two edits
// ---------------------------------------------------------------------------

// Add `mcp.brain` unless an entry named brain already exists (whatever it points at — a user who
// registered a checkout with `node /path/server.mjs` keeps it). Returns { text, changed }.
export function addBrainMcp(text, entry) {
  const json = JSON.stringify(entry);
  if (!String(text ?? '').trim()) {
    const fresh = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { brain: entry } }, null, 2) + '\n';
    return { text: fresh, changed: true };
  }
  const root = parseAt(blankJsonc(text), 0);
  if (root.type !== 'object') throw new Error('opencode config is not a JSON object');
  const mcp = member(root, 'mcp');
  if (mcp && member(mcp.value, 'brain')) return { text, changed: false };

  let out;
  if (mcp) {
    if (mcp.value.type !== 'object') throw new Error('opencode config: "mcp" is not an object');
    const at = mcp.value.start + 1;
    const comma = mcp.value.members.length ? ',' : '\n  ';
    out = text.slice(0, at) + `\n    "brain": ${json}${comma}` + text.slice(at);
  } else {
    const at = root.start + 1;
    const comma = root.members.length ? ',' : '\n';
    out = text.slice(0, at) + `\n  "mcp": {\n    "brain": ${json}\n  }${comma}` + text.slice(at);
  }
  if (!valid(out)) throw new Error('refusing to write: the edited opencode config would not parse');
  return { text: out, changed: true };
}

// Remove `mcp.brain` (and only it). Returns { text, changed }.
export function removeBrainMcp(text) {
  if (!String(text ?? '').trim()) return { text, changed: false };
  const root = parseAt(blankJsonc(text), 0);
  const mcp = member(root, 'mcp');
  const list = mcp?.value?.members ?? [];
  const idx = list.findIndex(m => m.key === 'brain');
  if (idx === -1) return { text, changed: false };

  let from, to;
  if (list.length === 1) {               // the only server: empty the object's interior
    from = mcp.value.start + 1; to = mcp.value.end - 1;
  } else if (idx < list.length - 1) {    // followed by a sibling: cut up to that sibling's key
    from = list[idx].keyStart; to = list[idx + 1].keyStart;
  } else {                               // the last of several: cut from the previous value's end
    from = list[idx - 1].value.end; to = list[idx].value.end;
  }
  const out = text.slice(0, from) + text.slice(to);
  if (!valid(out)) throw new Error('refusing to write: the edited opencode config would not parse');
  return { text: out, changed: true };
}

// Apply an edit to the real file: back it up first (once per run), write only when it changed.
export function editOpencodeConfig(file, edit) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { text, changed } = edit(before);
  if (!changed) return { changed: false, file };
  let backup = null;
  if (before) { backup = `${file}.bak-brain-rag`; copyFileSync(file, backup); }
  else mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return { changed: true, file, backup };
}

// ---------------------------------------------------------------------------
// AGENTS.md — opencode's global rules file
// ---------------------------------------------------------------------------
// opencode reads <config>/AGENTS.md into every session. A short section there is what makes the
// model reach for the brain on its own (search before assuming, save what matters) — the same
// role ~/.codex/AGENTS.md plays for Codex. brain-rag owns ONLY the text between its two markers:
// the rest of the file is the user's, and install/uninstall never touch it.
export const AGENTS_START = '<!-- brain-rag:agents:start — managed by brain-rag install; edits inside are overwritten -->';
export const AGENTS_END = '<!-- brain-rag:agents:end -->';

export const AGENTS_SECTION = `## Second brain (MCP server \`brain\`)
Persistent memory of all my work across Claude Code, Codex and opencode. In opencode its tools are named \`brain_<tool>\`.
- Starting work in a known repo, or "where did I leave off?" → \`brain_get_context\` (state + decisions + TODOs in one call).
- "What did we decide about X?", "how did I solve Y?" → \`brain_search_context\`. Call it BEFORE assuming there is no prior context.
- When this session produces something worth remembering (a decision with its why, a bug's root cause, a fix, a design) → \`brain_save_memories\` with self-contained memories. Skip trivial or throwaway chats.
- Sessions are kept and indexed automatically by the brain-rag plugin; \`/brain\` forces it, \`/distill\` extracts memories now, \`/state\` refreshes the project's state note.`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = () => new RegExp(`\\n*${escapeRe(AGENTS_START)}[\\s\\S]*?${escapeRe(AGENTS_END)}\\n?`);

// Insert or replace the managed block. Returns { text, changed }.
export function upsertAgentsBlock(text, section = AGENTS_SECTION) {
  const before = String(text ?? '');
  const block = `${AGENTS_START}\n${section}\n${AGENTS_END}\n`;
  let out;
  if (blockRe().test(before)) out = before.replace(blockRe(), (m) => (m.startsWith('\n') ? '\n\n' : '') + block);
  else out = before.trim() ? `${before.replace(/\n*$/, '')}\n\n${block}` : block;
  return { text: out, changed: out !== before };
}

// Remove the managed block (and the blank lines that separated it). Returns { text, changed }.
export function removeAgentsBlock(text) {
  const before = String(text ?? '');
  if (!blockRe().test(before)) return { text: before, changed: false };
  let out = before.replace(blockRe(), '\n');
  out = out.trim() ? out.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n') : '';
  return { text: out, changed: true };
}

// Apply to the real file: writes only on change; an AGENTS.md left empty by uninstall is removed.
export function editAgentsFile(file, edit) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { text, changed } = edit(before);
  if (!changed) return { changed: false, file };
  if (!text) { rmSync(file, { force: true }); return { changed: true, file, removed: true }; }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return { changed: true, file };
}
