// opencode automation — the equivalent of the Claude Code hooks, driven by the brain-rag plugin
// that `install` drops into opencode's plugins dir (see prompts.mjs → opencodePluginBody).
//
//   brain-rag opencode start <sessionId> <directory>   session.created: apply the keep policy
//   brain-rag opencode idle  <sessionId> [directory]   session.idle: ingest, later distill
//   brain-rag opencode distill on|off|status           toggle the automatic distillation
//
// Why a separate process: the plugin runs INSIDE opencode, and `opencode run` exits the moment
// a session goes idle — anything the plugin did in-process would be killed with it. The plugin
// only spawns this command detached; everything slow (ingest, the extractor) happens here.
//
// Parity with Claude Code:
//   SessionStart → mark-keep      ≙ start: same decideKeep precedence (BRAIN > never > always > default)
//   SessionEnd   → ingest         ≙ idle: ingest right away (incremental; serialized by a lock)
//   SessionEnd   → distill --hook ≙ idle: once the session has been quiet for a while, distill it
//                                   with opencode itself as the extractor, then cloud auto-sync.
// opencode has no "session ended": a session can always be resumed, so "quiet for N minutes" is
// the end signal, and a session that grew after its last distillation is distilled again (Claude
// does the same when a resumed session ends again).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { decideKeep } from './mark-keep.mjs';
import { readAlwaysList } from './always.mjs';
import { readNeverList } from './never.mjs';
import { readConfig, captureByDefault, CONFIG_FILE } from './config.mjs';
import { opencodePath, OPENCODE_DB, sessionStat, opencodeSessionMeta, listOpencodeSessions } from './transcripts.mjs';
import { refreshQuietly } from './prompts.mjs';

const BRAIN_DIR = process.env.BRAIN_DIR || join(homedir(), '.claude', 'brain');
// keep.list lives at the fixed path every other writer uses (mark-keep, keep_session, ingest).
const KEEP_FILE = join(homedir(), '.claude', 'brain', 'keep.list');
const STATE_DIR = join(BRAIN_DIR, 'opencode');
const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_QUIET_MIN = 10;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

// Automatic distillation is ON unless turned off: the extractor is the user's own opencode model
// (often free or local), and "memories saved without doing anything" is the point of this host.
export function opencodeDistillSettings(cfg = readConfig()) {
  const quiet = Number(cfg.opencodeDistillQuietMinutes);
  return {
    enabled: cfg.opencodeDistill !== false,
    quietMs: (Number.isFinite(quiet) && quiet >= 0 ? quiet : DEFAULT_QUIET_MIN) * 60_000,
    model: typeof cfg.opencodeDistillModel === 'string' && cfg.opencodeDistillModel ? cfg.opencodeDistillModel : null,
  };
}

// `opencode run --format json` prints one JSON event per line; the answer is the `text` parts.
export function parseOpencodeRun(stdout) {
  let sessionId = null;
  const texts = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    sessionId ??= ev.sessionID ?? ev.part?.sessionID ?? null;
    if (ev.type === 'text' && typeof ev.part?.text === 'string') texts.push(ev.part.text);
  }
  return { sessionId, text: texts.join('\n') };
}

// Config overlay for the extractor run: no tool may execute (it must only PRINT the memories —
// with the brain tools available it could save them itself and we'd store them twice), and no
// second brain server is spawned for a one-shot extraction.
export const EXTRACTOR_CONFIG = JSON.stringify({
  permission: { '*': 'deny' },
  mcp: { brain: { type: 'local', command: ['true'], enabled: false } },
});

// Should the waiter that recorded `myStamp` distill now? Only the NEWEST idle event's waiter acts
// (later activity re-stamps the marker), and only when the session grew since its last distill.
export function shouldDistill({ myStamp, currentStamp, mtimeMs, distilledMtimeMs }) {
  if (currentStamp !== myStamp) return false;               // newer activity: a newer waiter owns it
  if (distilledMtimeMs != null && mtimeMs <= distilledMtimeMs) return false; // nothing new since
  return true;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[opencode ${new Date().toISOString()}] ${msg}`);
const readKeep = (file = KEEP_FILE) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);
const realSleep = (ms) => new Promise(r => setTimeout(r, ms));
const marker = (id, kind, dir = STATE_DIR) => join(dir, `${id}.${kind}`);
const readNum = (f) => { try { return Number(readFileSync(f, 'utf8').trim()); } catch { return null; } };

// The policy inputs are injectable so tests never read or write the real lists / keep.list.
export function start(sessionId, directory, {
  env = process.env.BRAIN, dbPath = OPENCODE_DB, keepFile = KEEP_FILE,
  always = readAlwaysList(), never = readNeverList(), defaultOn = captureByDefault(),
} = {}) {
  if (!sessionId || !directory) return { keep: false, reason: 'missing session/directory' };
  const { keep, reason } = decideKeep({ cwd: directory, env, always, never, defaultOn });
  if (!keep) return { keep, reason };
  const p = opencodePath(dbPath, sessionId);
  if (!readKeep(keepFile).includes(p)) {
    mkdirSync(dirname(keepFile), { recursive: true });
    appendFileSync(keepFile, p + '\n');
  }
  return { keep, reason, path: p };
}

// One ingest at a time across every opencode window: a second idle while one runs only flags
// "pending", and the running one loops once more — the session that went idle meanwhile is picked
// up without two processes embedding the same chunks into the same SQLite file.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
export function ingestLocked({ dir = STATE_DIR, run = () => execFileSync(process.execPath, [join(HERE, 'ingest.mjs')], { stdio: 'inherit', windowsHide: true }) } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'ingest.lock'), pending = join(dir, 'ingest.pending');
  try {
    const fd = openSync(lock, 'wx'); // atomic create: fails if another ingest holds it
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch {
    const holder = readNum(lock);
    if (holder && pidAlive(holder)) { writeFileSync(pending, '1'); return 'queued'; }
    writeFileSync(lock, String(process.pid)); // stale lock from a crashed run: take it over
  }
  let runs = 0;
  try {
    do { rmSync(pending, { force: true }); run(); runs++; } while (existsSync(pending));
  } finally { rmSync(lock, { force: true }); }
  return `ran ${runs}`;
}

// ---------------------------------------------------------------------------
// Launching programs on every OS (issue #52)
// ---------------------------------------------------------------------------
// On Windows, npm-installed CLIs (npx, opencode) are .cmd shims, and Node refuses to spawn a .cmd
// without a shell (EINVAL) — the plugin swallowed that error, so on Windows nothing was ever kept.
// There the command line goes through cmd.exe, each argument quoted; everywhere else it is a plain
// argv spawn. Nothing long goes on the command line: cmd.exe caps it at ~8191 characters, so the
// extractor prompt travels on stdin.
export function winQuote(arg) {
  const s = String(arg);
  return /^[\w.:\\/=+@-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`;
}
export function commandFor(cmd, args, platform = process.platform) {
  return platform === 'win32'
    ? { file: [cmd, ...args].map(winQuote).join(' '), args: [], shell: true }
    : { file: cmd, args, shell: false };
}

// Run a command to completion, feeding `input` on stdin; resolves with stdout.
export function runCapture(cmd, args, { input = '', cwd, env, timeout = 600_000, platform = process.platform } = {}) {
  const c = commandFor(cmd, args, platform);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(c.file, c.args, { cwd, env, shell: c.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out after ${timeout / 1000}s`)); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(-500)}`));
    });
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(input);
  });
}

// The extractor: the user's own opencode, headless, tools denied, plugins off (--pure), and
// BRAIN=0 so its session is never kept. `opencode run` reads its message from stdin when no
// message argument is given, which keeps the ~12k-character prompt off the command line.
// Its throwaway session is deleted afterwards.
export async function runOpencode(prompt, { model } = {}) {
  const args = ['run', '--pure', '--format', 'json', ...(model ? ['-m', model] : [])];
  const env = { ...process.env, BRAIN: '0', OPENCODE_CONFIG_CONTENT: EXTRACTOR_CONFIG };
  const stdout = await runCapture('opencode', args, { input: prompt, cwd: tmpdir(), env });
  const { sessionId, text } = parseOpencodeRun(stdout);
  if (sessionId) {
    const c = commandFor('opencode', ['session', 'delete', sessionId]);
    try { spawnSync(c.file, c.args, { shell: c.shell, stdio: 'ignore', timeout: 60_000, windowsHide: true }); } catch { /* cosmetic */ }
  }
  return text;
}

async function distillNow(sessionId, path, settings) {
  const { openDb } = await import('./store.mjs');
  const { distillSession, formatDistillResult } = await import('./distill.mjs');
  const { autoSync } = await import('./cloud.mjs');
  const db = openDb();
  const row = db.prepare('SELECT path, project, session, title FROM sessions WHERE path = ?').get(path);
  if (!row) { log(`${sessionId}: not indexed yet — skip distill`); return; }
  log(`${sessionId}: distilling ${row.project} · ${row.title ?? sessionId}`);
  const r = await distillSession(db, row, { model: settings.model, run: runOpencode });
  log(`  ${formatDistillResult(r)}`);
  const team = await autoSync(db);
  if (team?.pushed) log(`  ☁ auto-synced ${team.pushed} to the team store`);
  if (team?.offline) log('  ☁ team endpoint unreachable — kept pending for the next sync');
}

// Everything with a side effect beyond the state dir is injectable: tests drive the whole flow
// (policy → ingest → quiet wait → distill decision) without the model, the embedder or real files.
export async function idle(sessionId, directory, {
  dbPath = OPENCODE_DB, keepFile = KEEP_FILE, stateDir = STATE_DIR, policy = {},
  ingest = () => ingestLocked({ dir: stateDir }), distill = distillNow, sleep = realSleep,
  settings = opencodeDistillSettings(),
} = {}) {
  const path = opencodePath(dbPath, sessionId);
  // `start` and the first `idle` are spawned a moment apart (a one-shot `opencode run` goes idle
  // right after it is created), so idle applies the keep policy too — idempotent, same answer.
  // A session resumed in a later opencode process arrives without a directory: read it (and its
  // parent link, to skip subagent children) from opencode's database.
  const meta = opencodeSessionMeta(path) ?? {};
  if (meta.parentId) return; // a subagent child: its parent conversation is what gets kept
  const dir = directory || meta.cwd;
  if (dir && !readKeep(keepFile).includes(path)) start(sessionId, dir, { dbPath, keepFile, ...policy });
  if (!readKeep(keepFile).includes(path)) return { kept: false }; // opt-in, exactly like the Claude hooks
  mkdirSync(stateDir, { recursive: true });
  const myStamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(marker(sessionId, 'idle', stateDir), myStamp);

  log(`${sessionId}: idle → ingest (${ingest()})`);

  if (!settings.enabled) return { kept: true, distilled: false };
  await sleep(settings.quietMs);
  listOpencodeSessions(dbPath); // refresh the cached stats: the session may have grown while we slept
  let mtimeMs;
  try { mtimeMs = sessionStat(path).mtimeMs; } catch { return; } // session deleted meanwhile
  const go = shouldDistill({
    myStamp, currentStamp: readFileSync(marker(sessionId, 'idle', stateDir), 'utf8').trim(),
    mtimeMs, distilledMtimeMs: readNum(marker(sessionId, 'distilled', stateDir)),
  });
  if (!go) return { kept: true, distilled: false };
  log(`${sessionId}: quiet for ${settings.quietMs / 60_000} min → final ingest + distill`);
  ingest();
  writeFileSync(marker(sessionId, 'distilled', stateDir), String(mtimeMs)); // before the slow part: a crash never loops
  await distill(sessionId, path, settings);
  return { kept: true, distilled: true };
}

function setDistill(action) {
  const cfg = readConfig();
  if (action === 'on' || action === 'off') {
    cfg.opencodeDistill = action === 'on';
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  }
  const s = opencodeDistillSettings(readConfig());
  console.log(`opencode auto-distill: ${s.enabled ? 'on' : 'off'} (after ${s.quietMs / 60_000} quiet min, model: ${s.model ?? "opencode's default"})`);
  console.log('  settings live in ' + CONFIG_FILE + ': opencodeDistill, opencodeDistillQuietMinutes, opencodeDistillModel');
}

export async function main() {
  const [action, ...args] = process.argv.slice(2);
  try {
    if (action === 'start') {
      refreshQuietly(); // upgrade repair of the generated files, like the Claude SessionStart hook
      const r = start(args[0], args[1]);
      if (r.keep) log(`${args[0]}: kept (${r.reason})`);
    } else if (action === 'idle') {
      await idle(args[0], args[1]);
    } else if (action === 'distill') {
      setDistill(args[0]);
    } else {
      console.log('usage: brain-rag opencode start <sessionId> <dir> | idle <sessionId> | distill on|off|status');
    }
  } catch (e) {
    // Spawned detached by the plugin: nobody is waiting on the exit code, the log is the record.
    console.error(`[opencode] swallowed: ${e.message}`);
  }
  // No process.exit(): after the embedder/extractor ran, a natural return lets native threads unwind.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
