#!/usr/bin/env node
// Rebuilds the views only medrec makes, from the `medrec` on PATH:
// test/fixtures/<view>/records/<person id>.json over test/fixtures/records, and
// test/fixtures/<view>/large/<person id>.json over `scripts/synth.mjs`, and
// test/fixtures/<view>/labels/<person id>.json over test/fixtures/labels, for each
// of events.json, bills.json, private.json, providers.json (which a person
// with no labelled provider has none of) and standing.json, byte for byte as
// `medrec views write` wrote them, and test/fixtures/<name>/views/, all of what it
// wrote for each of OWN (scripts/own-folder.mjs). medrec runs from a throwaway profile in a scratch home, so
// nothing of this machine's medrec is read or changed.
//
//   node scripts/derived.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labelsFolder } from './labels-folder.mjs';
import { OWN, ownFolder } from './own-folder.mjs';
import { synth } from './synth.mjs';

const ROOT = join(import.meta.dirname, '..');
const VIEWS = ['events.json', 'bills.json', 'private.json', 'providers.json', 'standing.json'];
const OPTIONAL = new Set(['providers.json']);

const scratch = mkdtempSync(join(tmpdir(), 'derived-'));
try {
  const home = join(scratch, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') };
  const medrec = (...args) => execFileSync('medrec', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const version = medrec('-V').trim();
  medrec('profiles', 'add', 't', '--json');
  const folders = { records: join(scratch, 'records'), large: join(scratch, 'large'), labels: join(scratch, 'labels') };
  cpSync(join(ROOT, 'test/fixtures/records'), folders.records, { recursive: true });
  synth(folders.large);
  labelsFolder(folders.labels);
  for (const name of OWN) folders[name] = ownFolder(name, join(scratch, name));
  for (const [name, folder] of Object.entries(folders)) {
    medrec('--profile', 't', 'config', 'set', 'folder', folder, '--json');
    medrec('--profile', 't', 'views', 'write', '--all', '--json');
    if (OWN.includes(name)) {
      const out = join(ROOT, 'test/fixtures', name, 'views');
      rmSync(out, { recursive: true, force: true });
      cpSync(join(folder, 'views'), out, { recursive: true });
      console.log(`${name}: its views, from ${version}`);
      continue;
    }
    const index = JSON.parse(readFileSync(join(folder, 'views/views.json'), 'utf8'));
    for (const view of VIEWS) {
      const out = join(ROOT, 'test/fixtures', view.replace(/\.json$/, ''), name);
      rmSync(out, { recursive: true, force: true });
      for (const [pid, v] of Object.entries(index.people)) {
        const md5 = v.files?.[view];
        if (md5 === undefined) {
          if (OPTIONAL.has(view)) continue;
          throw new Error(`${version} wrote no ${view} for ${pid} in ${name}`);
        }
        mkdirSync(out, { recursive: true });
        const stored = `${view.replace(/\.json$/, '')}.${md5.slice(0, 12)}.json`;
        writeFileSync(join(out, `${pid}.json`), readFileSync(join(folder, 'views', pid, stored)));
      }
    }
    console.log(`${name}: ${Object.keys(index.people).length} people, from ${version}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
