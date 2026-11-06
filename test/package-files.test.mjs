// The published tarball contains ONLY package.json "files". A module that is imported (or spawned)
// by a packaged module but missing from that list works in a checkout and crashes after
// `npm i` / `npx` — release 1.7.0 almost shipped without opencode-hook.mjs, which every opencode
// session runs through the plugin. This pins: everything a packaged module loads is packaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('every local module a packaged module imports or spawns is in package.json "files"', () => {
  const files = new Set(pkg.files);
  const missing = [];
  for (const f of readdirSync(ROOT).filter(f => f.endsWith('.mjs') && files.has(f))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const refs = [
      ...src.matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g),           // static import
      ...src.matchAll(/import\(\s*'\.\/([\w-]+\.mjs)'\s*\)/g),   // dynamic import (cli.mjs routing)
      ...src.matchAll(/^import\s+'\.\/([\w-]+\.mjs)'/gm),        // side-effect import
      ...src.matchAll(/join\(\s*HERE,\s*'([\w-]+\.mjs)'\s*\)/g), // spawned as a child script
    ].map(m => m[1]);
    for (const dep of refs) if (!files.has(dep)) missing.push(`${f} → ${dep}`);
  }
  assert.deepEqual(missing, [], 'add these to package.json "files"');
});

test('the CLI entry and every routed command module are packaged', () => {
  assert.ok(pkg.files.includes(pkg.bin['brain-rag']));
  assert.ok(pkg.files.includes('opencode-hook.mjs'), 'the opencode plugin runs `brain-rag opencode …`');
});
