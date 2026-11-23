#!/usr/bin/env node
// Writes the reference views (docs/views.md) into a records folder on disk:
// for a folder no medrec 0.8.0 or later prepares, and to compare another
// writer's views with these.

import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = `usage: npm run views -- [--force] <records folder>

Writes the connector's reference views into <records folder>/views, the
folder holding household.json, replacing the views this script wrote there
before. Run it again after each refresh of the records.

  --force   also replace views another writer (medrec) wrote`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const force = args.includes('--force');
const rest = args.filter((a) => a !== '--force');
if (rest.length !== 1 || rest[0].startsWith('-')) {
  console.error(USAGE);
  process.exit(2);
}
const folder = resolve(rest[0]);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!existsSync(join(folder, 'household.json'))) fail(`${folder} holds no household.json: give the records folder itself.`);
const index = join(folder, 'views', 'views.json');
if (existsSync(index) && !force) {
  let by;
  try {
    by = JSON.parse(readFileSync(index, 'utf8')).medrec;
  } catch {
    by = 'an unknown writer';
  }
  if (by !== 'connector') fail(`${index} was written by medrec ${by}. Replacing it would leave the folder with views medrec did not write; pass --force to replace them anyway.`);
}

const out = mkdtempSync(join(tmpdir(), 'oyh-views-'));
try {
  await build({ entryPoints: [fileURLToPath(new URL('../src/views/local.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'local.mjs'), logLevel: 'error' });
  const { writeViewsAt } = await import(pathToFileURL(join(out, 'local.mjs')).href);
  const { files, bytes } = writeViewsAt(folder, 'connector');
  console.log(`wrote ${files} views, ${(bytes / 1e6).toFixed(1)} MB, in ${join(folder, 'views')}`);
} catch (e) {
  console.error(`could not write the views: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
