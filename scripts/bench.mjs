#!/usr/bin/env node
// What a tool call costs in CPU inside workerd, the runtime Cloudflare runs,
// over a large synthetic folder (scripts/synth.mjs).
// The Free plan allows 10 ms of CPU a request; Workers Paid, 30 s.
//
//   node scripts/bench.mjs [N]      (N requests per row, default 40)
//
// It runs the connector (bench/worker.ts) under `wrangler dev`, with Google
// answered by test/fake-google.ts on 127.0.0.1:8790, connects through the
// real OAuth flow, then samples the workerd processes' CPU time (ps, 10 ms
// resolution) around N calls of each kind. The folder has views
// (docs/views.md), written by scripts/views.mjs. "Cold" calls touch every
// file first, so each call downloads and parses what it reads again, as the
// first call on a fresh isolate does.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID, CLIENT_SECRET, FOLDER_ID, FakeGoogle } from '../test/fake-google.ts';
import { TARGETS, synth } from './synth.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N = Number(process.argv[2] ?? 40);
const BASE = 'http://127.0.0.1:8787';
const CB = 'http://127.0.0.1:9999/cb';

const scratch = mkdtempSync(join(tmpdir(), 'oyh-bench-'));
const folder = synth(join(scratch, 'records'));
execFileSync(process.execPath, [join(ROOT, 'scripts/views.mjs'), folder], { stdio: 'ignore' });
const g = new FakeGoogle(folder);

const fake = createServer(async (req, res) => {
  const [, host, ...rest] = req.url.split('/');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const answer = await g.fetch(`https://${host}/${rest.join('/')}`, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host').map(([k, v]) => [k, String(v)])),
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((r) => fake.listen(8790, '127.0.0.1', r));

const vars = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, ALLOWED_ACCOUNTS: 'robin@example.com', FOLDER_ID };
const dev = spawn(
  join(ROOT, 'node_modules/.bin/wrangler'),
  ['dev', '--config', 'bench/wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', '8787', '--persist-to', join(scratch, 'state'), ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
const stop = () => {
  dev.kill('SIGINT');
  fake.close();
  rmSync(scratch, { recursive: true, force: true });
};
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('wrangler dev did not start in 60 s')), 60_000);
  const watch = (d) => {
    if (/Ready on/.test(String(d))) {
      clearTimeout(t);
      resolve();
    }
  };
  dev.stdout.on('data', watch);
  dev.stderr.on('data', watch);
});

// ---- connect, as an assistant would --------------------------------------------------------------

const jar = new Map();
async function go(url, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}
const client = await (
  await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CB], client_name: 'bench', token_endpoint_auth_method: 'none' }),
  })
).json();
const verifier = randomBytes(32).toString('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CB, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const page = await (await go(`${BASE}/authorize?${q}`)).text();
const handle = /name="handle" value="([^"]+)"/.exec(page)[1];
const toGoogle = await go(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
const back = await go(g.approve(toGoogle.headers.get('Location')).replace(/^https?:\/\/[^/]+/, BASE));
const code = new URL(back.headers.get('Location')).searchParams.get('code');
const tok = await (
  await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
  })
).json();
if (!tok.access_token) throw new Error(`no token: ${JSON.stringify(tok)}`);

// ---- measure ------------------------------------------------------------------------------------

const pids = execFileSync('pgrep', ['-f', join(ROOT, 'node_modules/@cloudflare/workerd')], { encoding: 'utf8' }).trim().split('\n').join(',');
const cpuMs = () =>
  execFileSync('ps', ['-o', 'time=', '-p', pids], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .reduce((t, line) => {
      const [m, s] = line.trim().split(':');
      return t + (Number(m) * 60 + Number(s)) * 1000;
    }, 0);

let id = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  const body = await res.json();
  if (body.error || body.result?.isError) throw new Error(`${method} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
}
const call = (name, args) => rpc('tools/call', { name, arguments: args });

const people = Object.keys(TARGETS);
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const every = files(folder);
function touch() {
  const now = new Date(Date.now() + Math.floor(Math.random() * 1e6));
  for (const f of every) utimesSync(f, now, now);
}

async function measure(label, f, cold = false) {
  await f(); // warm-up: the isolate, the cache
  let spent = 0;
  let wall = 0;
  for (let i = 0; i < N; i++) {
    if (cold) touch();
    const c0 = cpuMs();
    const w0 = performance.now();
    await f();
    wall += performance.now() - w0;
    spent += cpuMs() - c0;
  }
  return { label, cpu: spent / N, wall: wall / N };
}

const docs = (await call('medrec_records', { kind: 'documents', person: 'Sam', limit: 5 })).structuredContent.items;
const rows = [];
rows.push(await measure('tools/list (OAuth check and MCP framing only)', () => rpc('tools/list', {})));
rows.push(await measure('medrec_summary, everyone, warm', () => call('medrec_summary', {})));
rows.push(await measure('medrec_summary Sam, warm', () => call('medrec_summary', { person: 'Sam' })));
rows.push(await measure('medrec_summary Sam, cold (files changed)', () => call('medrec_summary', { person: 'Sam' }), true));
rows.push(await measure('medrec_search "cholesterol", warm', () => call('medrec_search', { query: 'cholesterol' })));
rows.push(await measure('medrec_search "cholesterol", cold (files changed)', () => call('medrec_search', { query: 'cholesterol' }), true));
rows.push(await measure('medrec_records results, 200, warm', () => call('medrec_records', { kind: 'results', limit: 200 })));
rows.push(await measure('medrec_records timeline Robin, warm', () => call('medrec_records', { kind: 'timeline', person: 'Robin' })));
rows.push(await measure('medrec_document (16,000 characters), warm', () => call('medrec_document', { id: docs[0].id })));
stop();

const base = rows[0].cpu;
console.log(`workerd CPU per request, mean of ${N} (ps, 10 ms resolution summed over ${N}), synthetic folder:`);
for (const p of people) console.log(`  ${p}: index ${(TARGETS[p].index / 1e6).toFixed(2)} MB, text ${(TARGETS[p].text / 1e6).toFixed(2)} MB`);
console.log('| Call | CPU ms | over tools/list | wall ms |\n|---|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.label} | ${r.cpu.toFixed(1)} | ${(r.cpu - base).toFixed(1)} | ${r.wall.toFixed(1)} |`);
