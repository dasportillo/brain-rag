// Maintenance: purge harness/meta noise chunks from the store WITHOUT re-embedding.
// Removes task/tool notifications, system-notification blocks, and eval/judge meta that
// contaminate retrieval (the judge outputs quote the eval queries verbatim → circular).
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(process.env.BRAIN_DB || join(homedir(), '.claude', 'brain', 'brain.db'));

const patterns = [
  '%<task-notification>%',
  '%<tool-notification>%',
  '%[SYSTEM NOTIFICATION%',
  '%Now I\'ll judge queries%',   // judge output (echoes the eval queries)
  '%R1: YES%', '%R1: NO%',       // judge verdict blocks
  '%expectAny%', '%eval-bundle%', '%eval-judge%', '%Recall@%',  // eval harness meta
];

const before = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;
let removed = 0;
const del = db.prepare('DELETE FROM chunks WHERE text LIKE ?');
db.exec('BEGIN');
for (const p of patterns) removed += del.run(p).changes;
db.exec('COMMIT');
const after = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;

console.log(`chunks: ${before} → ${after}  (purged ${before - after})`);
