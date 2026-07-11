// HEURISTIC entity extraction — regex/parsers only, deliberately no LLM (docs/ROADMAP.md v1.0:
// measure usefulness before sophistication). Every pattern is anchored and conservative:
// PRECISION OVER RECALL — a noisy graph poisons retrieval boosts and co-occurrence stats,
// while a small precise one only helps. Pure module: no deps, safe to import from tests.

// Caps. The global cap keeps a single pathological chunk (a dumped config, a giant SQL file)
// from flooding the graph; the per-kind caps tame the two kinds that repeat structurally
// (hostnames in logs, file paths in tool output) even in normal chunks.
const CAP_TOTAL = 20;
const CAP_SERVICES = 5;
const PATH_CHARS_PER_HIT = 200; // file_path: max 1 per 200 chars of text

// Words that legitimately follow an UPPERCASE "FROM"/"JOIN" in prose or shouty text — never
// tables. Tiny by design: the SELECT-in-text requirement below does most of the filtering.
const SQL_NOISE = new Set(['the', 'this', 'that', 'them', 'these', 'those', 'each', 'every', 'here',
  'there', 'scratch', 'now', 'los', 'las', 'una', 'este', 'esta', 'aqui', 'ahora']);

// SCREAMING_SNAKE noise: structural SQL/config constants that appear everywhere and identify nothing.
const IDENT_NOISE = new Set(['NOT_NULL', 'PRIMARY_KEY', 'FOREIGN_KEY', 'IF_NOT_EXISTS', 'GROUP_BY',
  'ORDER_BY', 'UTF_8', 'CO_AUTHORED_BY']);

// Extract [{ name, kind }] from free text. Kinds:
//   aws_arn      arn:aws:...           (name = the resource tail, e.g. "table/mi-tabla")
//   aws_resource s3://bucket           (name = the bucket)
//   database     table after an UPPERCASE FROM/JOIN in a SQL fragment
//   repo         owner/name from github.com URLs or `gh …` commands
//   service      bare internal/AWS hostnames (x.y.internal, sqs.….amazonaws.com)
//   file_path    absolute or repo-relative paths WITH an extension (flood-capped)
//   identifier   SCREAMING_SNAKE state names >= 6 chars (MONTOS_FIJOS, EN_RESPUESTA) —
//                retrieval gold in this corpus: exact, rare, and always meaningful.
// Output is normalized (trim, collapsed whitespace), deduped by (name, kind), most frequent
// first, capped at CAP_TOTAL.
export function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];
  const hits = []; // one entry PER OCCURRENCE — frequency drives the final ordering
  const push = (name, kind) => {
    name = String(name).replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
    if (name) hits.push({ name, kind });
  };

  // aws_arn — arn:partition:service:region:account:resource. Keep only the resource tail:
  // that's the human-meaningful part (table/x, function:y, log-group:/aws/...), and it is
  // what people type in queries. The tail may itself contain ':' and '/'.
  for (const m of text.matchAll(/\barn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d*:([^\s"'`)\]}>,]+)/g)) {
    push(m[1], 'aws_arn');
  }

  // aws_resource — S3 buckets. Bucket names are lowercase DNS-ish labels; the key is dropped
  // (keys are near-unique noise, the bucket is the entity).
  for (const m of text.matchAll(/\bs3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])/g)) {
    push(m[1], 'aws_resource');
  }

  // database — table names after UPPERCASE FROM/JOIN. Guards: (a) FROM in prose ("copied FROM
  // the source") is filtered by requiring a SELECT/INSERT/DELETE/UPDATE somewhere in the text,
  // (b) a tiny stopword list catches shouty prose, (c) lowercase snake_case names only —
  // that's how this corpus names tables, and it excludes SQL keywords for free.
  if (/\b(?:SELECT|INSERT|DELETE|UPDATE)\b/.test(text)) {
    for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\b/g)) {
      const name = m[1];
      if (name.length >= 3 && !SQL_NOISE.has(name)) push(name, 'database');
    }
  }

  // repo — owner/name in github.com URLs (https or ssh) …
  for (const m of text.matchAll(/github\.com[:/]([\w.-]+\/[\w.-]+)/g)) {
    push(m[1].replace(/\.git$/, ''), 'repo');
  }
  // … and in gh CLI invocations. Anchored on `gh <subcommand>` so a stray `-R a/b`
  // (e.g. grep -R) can never mint a repo.
  for (const m of text.matchAll(/\bgh\s+(?:pr|issue|repo|api|run|workflow|release)\b[^\n]*?(?:--repo|-R)\s+([\w.-]+\/[\w.-]+)/g)) {
    push(m[1], 'repo');
  }
  for (const m of text.matchAll(/\bgh\s+repo\s+(?:clone|view|fork)\s+([\w.-]+\/[\w.-]+)/g)) {
    push(m[1].replace(/\.git$/, ''), 'repo');
  }

  // service — bare hostnames, but ONLY under suffixes that always mean infrastructure
  // (an open hostname regex would swallow every prose domain). Normalized to lowercase.
  for (const m of text.matchAll(/\b((?:[a-z0-9][a-z0-9-]*\.)+(?:internal|local|amazonaws\.com|svc\.cluster\.local))\b/gi)) {
    push(m[1].toLowerCase(), 'service');
  }

  // file_path — absolute or repo-relative (must contain a '/') with a real extension.
  // Scan a copy with URLs / s3 URIs / ARNs blanked out so their path-shaped tails
  // (github.com/o/r/blob/x.mjs, s3 keys, arn resource parts) can't leak in as paths.
  const pathText = text
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/\bs3:\/\/\S+/g, ' ')
    .replace(/\barn:aws\S+/g, ' ');
  for (const m of pathText.matchAll(/(?<![\w@:])(\/?(?:[\w.-]+\/)+[\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/])/g)) {
    const name = m[1];
    // schemeless URL (github.com/o/r/blob/x.mjs) — a domain-shaped first segment is not a path
    if (/\.(?:com|org|net|io|dev|ai|app)$/.test(name.split('/')[0])) continue;
    push(name, 'file_path');
  }

  // identifier — SCREAMING_SNAKE >= 6 chars with at least one underscore. Single ALL-CAPS
  // words (ERROR, TODO) are prose; the underscore + length floor keeps only real state/const
  // names, which are exact and rare — the highest-precision entities in this corpus.
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    if (m[0].length >= 6 && !IDENT_NOISE.has(m[0])) push(m[0], 'identifier');
  }

  // tally → dedupe by (kind, name), keep counts and first-seen order for stable ties
  const tally = new Map();
  for (const h of hits) {
    const key = `${h.kind}\x00${h.name}`;
    const cur = tally.get(key);
    if (cur) cur.n++;
    else tally.set(key, { name: h.name, kind: h.kind, n: 1, ord: tally.size });
  }
  let all = [...tally.values()].sort((a, b) => b.n - a.n || a.ord - b.ord);

  // per-kind flood caps (most frequent survive — the sort above already ordered them)
  const pathCap = Math.max(1, Math.floor(text.length / PATH_CHARS_PER_HIT));
  const kept = { service: 0, file_path: 0 };
  all = all.filter((e) => {
    if (e.kind === 'service') return ++kept.service <= CAP_SERVICES;
    if (e.kind === 'file_path') return ++kept.file_path <= pathCap;
    return true;
  });

  return all.slice(0, CAP_TOTAL).map(({ name, kind }) => ({ name, kind }));
}
