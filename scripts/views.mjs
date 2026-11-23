#!/usr/bin/env node
// Writes the reference views (docs/views.md) into a records folder on disk,
// replacing any there: for a folder medrec has not prepared, and to compare
// another writer's views with these.
//
//   npm run views -- <records folder>

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: npm run views -- <records folder>');
  process.exit(2);
}
const out = mkdtempSync(join(tmpdir(), 'oyh-views-'));
try {
  await build({ entryPoints: [fileURLToPath(new URL('../src/views/local.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'local.mjs'), logLevel: 'error' });
  const { writeViewsAt } = await import(pathToFileURL(join(out, 'local.mjs')).href);
  const { files, bytes } = writeViewsAt(folder, 'connector');
  console.log(`wrote ${files} views, ${(bytes / 1e6).toFixed(1)} MB, in ${join(folder, 'views')}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
