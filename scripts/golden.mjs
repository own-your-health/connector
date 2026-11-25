#!/usr/bin/env node
// Records what `medrec mcp` answers to test/golden/calls.json, over the demo
// folder, the large synthetic one (scripts/synth.mjs) and medrec's own for
// provider labels (scripts/labels-folder.mjs), into
// test/golden/medrec-<version>.json. test/golden.test.ts then holds this
// connector's answers to the same calls equal to medrec's.
//
//   node scripts/golden.mjs        (needs `medrec` on PATH)
//
// medrec runs in a scratch HOME with its own config and a keychain service
// that holds nothing, over copies of the folders: it never sees a real
// profile, folder or credential.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseExact } from '../src/records/numbers.ts';
import { labelsFolder } from './labels-folder.mjs';
import { synth } from './synth.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'oyh-golden-'));
const env = {
  PATH: process.env.PATH,
  HOME: scratch,
  XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_DATA_HOME: join(scratch, 'data'),
  MEDREC_KEYCHAIN_SERVICE: 'own-your-health-connector-golden-none',
  NO_COLOR: '1',
  TZ: 'UTC',
};
const medrec = (...args) => execFileSync('medrec', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const folders = { demo: join(scratch, 'demo'), large: join(scratch, 'large'), labels: join(scratch, 'labels') };
cpSync(join(ROOT, 'test/fixtures/records'), folders.demo, { recursive: true });
synth(folders.large);
labelsFolder(folders.labels);
for (const [name, path] of Object.entries(folders)) {
  medrec('profiles', 'add', name);
  medrec('--profile', name, 'config', 'set', 'folder', path);
  // medrec reads a code's plain name from the folder's views. The recorded
  // views stand in for a machine with the published table.
  medrec('--profile', name, 'views', 'write', '--json');
  if (name !== 'labels') codeNames(path, join(ROOT, 'test/fixtures/code-names', name === 'demo' ? 'records' : name));
}

/** Puts the recorded code-names.json files in a folder's views. */
function codeNames(folder, from) {
  const at = join(folder, 'views/views.json');
  const index = JSON.parse(readFileSync(at, 'utf8'));
  for (const file of readdirSync(from)) {
    const pid = file.replace(/\.json$/, '');
    const bytes = readFileSync(join(from, file));
    const md5 = createHash('md5').update(bytes).digest('hex');
    writeFileSync(join(folder, 'views', pid, `code-names.${md5.slice(0, 12)}.json`), bytes);
    index.people[pid].files['code-names.json'] = md5;
  }
  writeFileSync(at, JSON.stringify(index));
}

const version = medrec('-V').trim().split(' ').pop();
const today = new Date().toISOString().slice(0, 10);

/** One `medrec mcp` per folder, spoken to over stdio, one request at a time. */
function server(profile) {
  const child = spawn('medrec', ['--profile', profile, 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  // Numbers as medrec prints them: JSON.parse would write its 4.0 as 4.
  lines.on('line', (l) => waiting.shift()?.(parseExact(l)));
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  return { child, request, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

const servers = {};
const init = {};
for (const name of Object.keys(folders)) {
  const s = server(name);
  init[name] = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'golden', version: '1' } });
  s.notify('notifications/initialized');
  servers[name] = s;
}
const tools = await servers.demo.request('tools/list', {});

const { calls } = JSON.parse(readFileSync(join(ROOT, 'test/golden/calls.json'), 'utf8'));
const byLabel = {};
const results = [];
for (const c of calls) {
  const plain = c.arguments !== null && typeof c.arguments === 'object' && !Array.isArray(c.arguments);
  const args = plain ? { ...c.arguments } : c.arguments;
  if (c.cursor_from) args.cursor = byLabel[c.cursor_from].result.structuredContent.next_cursor;
  if (c.id_from) args.id = byLabel[c.id_from.label].result.structuredContent.items[c.id_from.item].id;
  const answer = await servers[c.folder].request('tools/call', { name: c.name, ...(args === undefined ? {} : { arguments: args }) });
  delete answer.id;
  if (c.label) byLabel[c.label] = answer;
  results.push({ folder: c.folder, name: c.name, ...(args === undefined ? {} : { arguments: args }), answer });
}
for (const s of Object.values(servers)) s.child.stdin.end();

const out = join(ROOT, `test/golden/medrec-${version}.json`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      about: 'What `medrec mcp` answered, written by scripts/golden.mjs. Every record in these folders is invented.',
      medrec_version: version,
      as_of: today,
      instructions: init.demo.result.instructions,
      tools: tools.result.tools,
      results,
    },
    null,
    1,
  )}\n`,
);
rmSync(scratch, { recursive: true, force: true });
console.log(`${results.length} calls to medrec ${version} (as of ${today}) written to ${out}`);
