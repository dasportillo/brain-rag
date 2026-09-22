// SINGLE SOURCE OF TRUTH for the prompt FILES brain-rag generates on disk, and the self-healing
// refresh that keeps them current (issue #34).
//
// THE PROBLEM. distill-prompt.mjs is imported at runtime by the headless extractor, so a package
// upgrade reaches it instantly. It does NOT reach `/distill`: the Claude Code slash command and
// the Codex custom prompt are FILES that install.mjs writes ONCE (~/.claude/commands/distill.md,
// ~/.codex/prompts/distill.md). Upgrade the package, keep using /distill, and the brain keeps
// filling in the OLD dense format — silently, because nothing ever says the file is out of date.
//
// THE FIX. Each generated file carries a stamp: a short hash of the body brain-rag wrote. That
// makes three states distinguishable WITHOUT any external bookkeeping — current, stale (we wrote
// it, the package moved on), and edited (the user changed it, so it is theirs now). Then the two
// things that ALREADY run on every session refresh the stale ones: the MCP server (`serve`,
// registered in both hosts by install) and the SessionStart hook (`mark-keep`). Both run through
// `npx -y brain-rag`, which is why this covers the npx path that a package `postinstall` cannot.
//
// The refresh is idempotent (a current file is read and not written), cheap (six small reads plus
// six hashes, sub-millisecond) and never throws — see refreshQuietly, which swallows everything
// so a broken $HOME can never stop a session from starting.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DISTILL_PROMPT } from './distill-prompt.mjs';

// True when this module is running from a git working copy rather than an installed package: a
// `.git` sits beside it. Published tarballs never ship one (npm excludes it), so this is only
// ever true for someone hacking on brain-rag itself — see refreshQuietly for why that matters.
export function runningFromCheckout(dir = dirname(fileURLToPath(import.meta.url))) {
  return existsSync(join(dir, '.git'));
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export const PKG_NAME = pkg.name;

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

// Trailing newlines are not content: normalizing them is what makes the hash stable across the
// small formatting differences between a template literal and a file read back from disk.
const normalize = (body) => String(body).replace(/\n+$/, '') + '\n';

export const bodyHash = (body) => createHash('sha256').update(normalize(body)).digest('hex').slice(0, 12);

const marker = (hash) =>
  `<!-- brain-rag:prompt ${hash} — generated file, refreshed automatically on upgrade; edit it and brain-rag leaves it alone -->`;

// A generated file is `body + blank line + marker`. The marker is an HTML comment: invisible where
// Markdown is rendered, and inert where the file IS the prompt (Codex).
export const stamp = (body) => `${normalize(body)}\n${marker(bodyHash(body))}\n`;

// Split a file back into what brain-rag wrote and the hash it claimed. `hash: null` = unstamped.
export function splitStamp(text) {
  const m = String(text).match(/\n<!-- brain-rag:prompt ([0-9a-f]{12})[^>]*-->\n?$/);
  return m ? { body: text.slice(0, m.index), hash: m[1] } : { body: String(text), hash: null };
}

// What we know about a file on disk, given the body the CURRENT package would write:
//   missing  — not there at all
//   current  — ours, unedited, already the current body: do nothing
//   stale    — ours, unedited, the package moved on: refresh it
//   legacy   — unstamped and different: written by a pre-stamp brain-rag (install.mjs has always
//              owned these paths outright), so refresh it — after backing it up
//   edited   — stamped, but the body no longer hashes to the stamp: the user made it theirs
export function fileState(text, expected) {
  if (text === null || text === undefined) return 'missing';
  const { body, hash } = splitStamp(text);
  const want = bodyHash(expected);
  if (hash === null) return bodyHash(body) === want ? 'stale' : 'legacy';
  if (hash !== bodyHash(body)) return 'edited';
  return hash === want ? 'current' : 'stale';
}

// ---------------------------------------------------------------------------
// The generated files
// ---------------------------------------------------------------------------

// Every prompt file brain-rag owns, with the exact body it should hold. install.mjs writes THESE
// (it does not keep its own copies), so the installer and the refresher can never drift apart —
// which was the whole bug: two writers of the same file, only one of them ever running again.
export function promptFiles({ home = homedir(), name = PKG_NAME } = {}) {
  const npx = `npx -y ${name}`;
  const cmdDir = join(home, '.claude', 'commands');
  const codexDir = join(home, '.codex', 'prompts');

  const brainBody = (host) => host === 'codex'
    ? `Call the \`keep_session\` tool from the \`brain\` MCP server and report its one-line result verbatim. Do nothing else.
(The brain is OFF by default; this opts THIS session in so it does get indexed, in full.)
`
    : `---
description: Save THIS conversation to the "second brain" (off by default — nothing is saved)
allowed-tools: Bash(npx:*)
---
Run exactly this command with the Bash tool and report its output on a single line:

\`${npx} mark-current\`

Do nothing else. (The brain is OFF by default; this opts THIS session in so it does get indexed, in full.)
`;

  const codexState = `Build and persist the curated CURRENT-STATE note for the project \`$ARGUMENTS\` (if empty, infer it from the current working directory), using the \`brain\` MCP server.

1. Call \`get_state\` for that project — it returns the curated note, or recent activity when none exists. If it finds nothing, call \`list_projects\` and retry with the exact name.
2. Synthesize a concise note: **Now**, **In flight**, **Decisions**, **Blockers**, **Next**. Omit anything reverted or superseded.
3. Call \`save_state\` with that Markdown (same project if one was given).
4. Report the saved path on a single line.
`;

  const claudeState = `---
description: Synthesize and save the curated current-state note for a project (state/<project>.md)
allowed-tools: Bash(npx:*), mcp__brain__save_state
---
Build and persist the curated CURRENT-STATE note for the project \`$ARGUMENTS\` (if empty, infer it from the current working directory).

1. Run \`${npx} state $ARGUMENTS\` to gather the project's recent activity. (No argument: run \`${npx} state --list\` first and pick the project matching the cwd.)
2. Synthesize a concise note: **Now**, **In flight**, **Decisions**, **Blockers**, **Next**. Omit anything reverted or superseded.
3. Call the \`save_state\` tool with that Markdown (same project if one was given).
4. Report the saved path on a single line.
`;

  const claudeDistill = `---
description: Distill THIS conversation into durable memories (Layer 2 of the second brain)
---
${DISTILL_PROMPT}`;

  return [
    { host: 'claude', dir: cmdDir, path: join(cmdDir, 'brain.md'), body: brainBody('claude') },
    { host: 'claude', dir: cmdDir, path: join(cmdDir, 'state.md'), body: claudeState },
    { host: 'claude', dir: cmdDir, path: join(cmdDir, 'distill.md'), body: claudeDistill },
    { host: 'codex', dir: codexDir, path: join(codexDir, 'brain.md'), body: brainBody('codex') },
    { host: 'codex', dir: codexDir, path: join(codexDir, 'state.md'), body: codexState },
    { host: 'codex', dir: codexDir, path: join(codexDir, 'distill.md'), body: DISTILL_PROMPT },
  ];
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// mode 'install': the user asked for it — create every file, and overwrite even one they edited
//                 (that is what install has always done), but back the edit up first.
// mode 'refresh': a background caller — only repair what is provably out of date, never CREATE a
//                 file the user does not have, and never touch one they made theirs.
export function syncPrompts({ home = homedir(), name = PKG_NAME, mode = 'refresh' } = {}) {
  const install = mode === 'install';
  const out = { created: [], updated: [], backedUp: [], edited: [], skipped: [] };

  for (const f of promptFiles({ home, name })) {
    // Codex is optional: its prompts exist only on a machine that has Codex.
    if (f.host === 'codex' && !existsSync(join(home, '.codex'))) { out.skipped.push(f.path); continue; }
    // A refresh never conjures directories; only an explicit install does.
    if (!install && !existsSync(f.dir)) { out.skipped.push(f.path); continue; }

    let text = null;
    try { text = readFileSync(f.path, 'utf8'); } catch { text = null; }
    const state = fileState(text, f.body);

    if (state === 'current') { out.skipped.push(f.path); continue; }
    if (state === 'missing' && !install) { out.skipped.push(f.path); continue; }
    if (state === 'edited' && !install) { out.edited.push(f.path); continue; }
    // 'legacy' (unstamped, written before stamping existed) IS refreshed in the background: every
    // user upgrading from an earlier version has exactly these files, and repairing them is the
    // whole point. Known tradeoff: someone who hand-edited a pre-stamp file gets it replaced, and
    // the only notice goes to stderr, which an MCP host does not display. Their text is not lost —
    // it is copied to <file>.bak below — but they will not be told until they look.

    // Never destroy text we did not write: 'legacy' and 'edited' get a .bak next to the file.
    if (state === 'legacy' || state === 'edited') {
      try { copyFileSync(f.path, f.path + '.bak'); out.backedUp.push(f.path + '.bak'); } catch { /* best effort */ }
    }

    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.path, stamp(f.body));
    (state === 'missing' ? out.created : out.updated).push(f.path);
  }
  return out;
}

// The background entry point: SessionStart hook and MCP server startup. Silent when there is
// nothing to do, one stderr line when there is, and it CANNOT fail — a hook that throws would
// stop a session from starting, and a prompt file is never worth that.
export function refreshQuietly({ home = homedir(), name = PKG_NAME, log = console.error, fromSource = runningFromCheckout() } = {}) {
  try {
    // A developer whose MCP server points at a git CHECKOUT (`claude mcp add brain -- node
    // /path/to/brain-rag/server.mjs`) would otherwise have their GLOBAL /distill rewritten from
    // whatever branch is checked out — switch branches and the prompt silently oscillates. Only a
    // published copy may repair prompts in the background; from source, `install` is explicit.
    if (fromSource) return null;
    const r = syncPrompts({ home, name, mode: 'refresh' });
    for (const p of r.updated) log(`[brain] refreshed an out-of-date prompt file: ${p}`);
    for (const p of r.backedUp) log(`[brain] previous version kept at ${p}`);
    for (const p of r.edited) log(`[brain] ${p} has your own edits — left untouched, so it may be missing newer rules`);
    return r;
  } catch {
    return null; // never break the caller
  }
}
