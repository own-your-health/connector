// What each tool call costs over the views (src/views), through the real
// Worker: the OAuth check, MCP framing, the Drive client and the store, on
// this thread in Node (the V8 workerd runs). Google is answered by
// test/fake-google.ts on another thread (bench/fake-thread.ts), so its work
// is not counted.
//
// "Cold" empties the Worker's parsed files before each call, so the call
// downloads and parses every file it needs, as the first call on a fresh
// isolate does. "Subrequests" counts the call's requests to Google; the
// Free plan allows 50.
//
//   npx vitest run --config bench/vitest.config.ts bench/views.cpu.ts

import { createHash, randomBytes } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, it, vi } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { writeViewsAt } from '../src/views/local';
import worker, { clearCacheForTests, type Env } from '../src/worker';
import { CLIENT_ID, CLIENT_SECRET, FOLDER_ID, FakeGoogle } from '../test/fake-google';
import { MemoryD1, MemoryKV, addDerived, labelClaims, markParts, markPrivate } from '../test/support';

const N = Number(process.env.N ?? 20);
const BASE = 'https://records.example.workers.dev';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const cpu = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

it('measures', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-views-bench-'));
  const root = synth(join(scratch, 'records'));
  const written = writeViewsAt(root);
  // medrec's events, bills, private items and provider labels for this folder, and code names, as medrec wrote them; then one record in 20 private, one claim or paper in 20 with a private part, and every claim labelled, in as many bytes as one answer reads (LABELS_LIMIT).
  addDerived(root, 'large');
  const privateRecords = markPrivate(root, 20);
  const parts = markParts(root, Number(process.env.PARTS ?? 20)).reduce((n, size) => n + size, 0);
  const labels = labelClaims(root, 172).reduce((n, size) => n + size, 0);
  const all = files(root);
  const touch = () => clearCacheForTests();

  const thread = new Worker(join(import.meta.dirname, 'fake-thread.ts'), { workerData: { root } });
  afterAll(() => thread.terminate());
  let next = 0;
  const waiting = new Map<number, (m: { approved?: string; status: number; headers: [string, string][]; body: Uint8Array }) => void>();
  thread.on('message', (m) => {
    waiting.get(m.id)!(m);
    waiting.delete(m.id);
  });
  const ask = (m: Record<string, unknown>) =>
    new Promise<{ approved?: string; status: number; headers: [string, string][]; body: Uint8Array }>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      thread.postMessage({ id, ...m });
    });
  let subrequests = 0;
  // FAKE=inline: Google answers on this thread, its synchronous work timed and taken out. Node then
  // counts no Request or body building of its own, as workerd does that natively; the default counts it.
  const inline = process.env.FAKE === 'inline' ? new FakeGoogle(root) : undefined;
  let fakeCpu = 0;
  const g = { approve: async (url: string) => (inline ? inline.approve(url) : (await ask({ approve: url })).approved!) };
  if (inline) {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      subrequests++;
      const t0 = cpu();
      try {
        return inline.fetch(input, init);
      } finally {
        fakeCpu += cpu() - t0;
      }
    });
  } else vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    subrequests++;
    // The request's parts as given, without building a Request on this thread (workerd builds it natively).
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const h = init?.headers ?? req?.headers;
    const headers: [string, string][] = h instanceof Headers ? [...h] : Array.isArray(h) ? (h as [string, string][]) : Object.entries(h ?? {});
    const b = init?.body ?? (req?.body ? await req.arrayBuffer() : undefined);
    const body = b === undefined || b === null ? undefined : typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : new Uint8Array(b as ArrayBuffer);
    const r = await ask({ url, method: init?.method ?? req?.method ?? 'GET', headers, body });
    return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: undefined } as unknown as ExecutionContext;
  const env = { OAUTH_KV: new MemoryKV() as unknown as KVNamespace, AUDIT: new MemoryD1() as unknown as D1Database, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, ALLOWED_ACCOUNTS: 'robin@example.com', FOLDER_ID } as Env;
  const jar = new Map<string, string>();
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), env, ctx);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  };
  const client = (await (await go(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], client_name: 'Claude', token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CB, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` });
  const handle = /name="handle" value="([^"]+)"/.exec(await (await go(`${BASE}/authorize?${q}`)).text())![1]!;
  const toGoogle = await go(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
  const back = await go(await g.approve(toGoogle.headers.get('Location')!));
  const code = new URL(back.headers.get('Location')!).searchParams.get('code')!;
  const tok = (await (await go(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token: string };

  let id = 1;
  const rpc = async (method: string, params?: unknown) => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) }) }), env, ctx);
    const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] } };
    if (body.result?.isError) throw new Error(`${method} failed: ${body.result.content?.[0]?.text}`);
    return body.result;
  };
  const call = (name: string, args: Record<string, unknown>) => () => rpc('tools/call', { name, arguments: args });

  // The least and the median CPU over N calls: on a busy machine the least is the closest to the call alone.
  const measure = async (f: () => Promise<unknown>, cold: boolean) => {
    await f();
    const spent: number[] = [];
    let subs = 0;
    for (let i = 0; i < N; i++) {
      if (cold) touch();
      const s0 = subrequests;
      const f0 = fakeCpu;
      const t0 = cpu();
      await f();
      spent.push(cpu() - t0 - (fakeCpu - f0));
      subs = Math.max(subs, subrequests - s0);
    }
    spent.sort((a, b) => a - b);
    return { min: spent[0]!, median: spent[Math.floor(N / 2)]!, subs };
  };

  const docs = ((await call('medrec_records', { kind: 'documents', person: 'Sam', limit: 100 })()) as { structuredContent: { items: { id: string; has_text?: boolean }[] } }).structuredContent.items;
  // The newest with three pages of text.
  let long = '';
  for (const d of docs.filter((x) => x.has_text)) {
    const page = (await call('medrec_document', { id: d.id })()) as { structuredContent: { text_pages?: number } };
    if ((page.structuredContent.text_pages ?? 1) >= 3) {
      long = d.id;
      break;
    }
  }
  const eventId = ((await call('medrec_records', { kind: 'events', person: 'Robin', limit: 30 })()) as { structuredContent: { items: { id: string }[] } }).structuredContent.items[29]!.id;
  // A fixed piece of work, to read the rest against: on a quiet machine about 2.2 ms (2.62 MB took 5.87).
  const reference = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ id: `r${i}`, kind: 'result', date: '2014-01-01', display: `Synthetic test ${i}`, fields: { value: i, unit: 'mg/dL' }, provenance: [{ source: { cli: 'x' } }] })));
  const calls: [string, () => Promise<unknown>][] = [
    [`reference: JSON.parse of ${(reference.length / 1e6).toFixed(2)} MB`, async () => JSON.parse(reference)],
    ['tools/list', () => rpc('tools/list')],
    ['summary, everyone', call('medrec_summary', {})],
    ['summary Sam', call('medrec_summary', { person: 'Sam' })],
    ['search "cholesterol"', call('medrec_search', { query: 'cholesterol' })],
    ['search "cholesterol", 100 hits', call('medrec_search', { query: 'cholesterol', limit: 100 })],
    ['search "vitamin d"', call('medrec_search', { query: 'vitamin d' })],
    ['search "patient visit summary"', call('medrec_search', { query: 'patient visit summary' })],
    ['search "labs" (lab query)', call('medrec_search', { query: 'labs' })],
    ['search "e" Sam, 200 hits', call('medrec_search', { query: 'e', person: 'Sam', limit: 200 })],
    ['records results, 200', call('medrec_records', { kind: 'results', limit: 200 })],
    ['records results Sam, detailed', call('medrec_records', { kind: 'results', person: 'Sam', response_format: 'detailed' })],
    ['records tests, everyone', call('medrec_records', { kind: 'tests' })],
    ['records tests "glucose"', call('medrec_records', { kind: 'tests', name: 'glucose' })],
    ['records timeline Robin', call('medrec_records', { kind: 'timeline', person: 'Robin' })],
    ['records timeline, 2014', call('medrec_records', { kind: 'timeline', since: '2014-01-01', until: '2014-12-31', limit: 200 })],
    ['records medications, active', call('medrec_records', { kind: 'medications', active: true })],
    ['records conditions, everyone, 200', call('medrec_records', { kind: 'conditions', limit: 200 })],
    ['records conditions, Robin', call('medrec_records', { kind: 'conditions', person: 'Robin' })],
    ['records conditions, active, everyone', call('medrec_records', { kind: 'conditions', active: true })],
    ['records allergies, active, everyone', call('medrec_records', { kind: 'allergies', active: true })],
    ['records documents Sam', call('medrec_records', { kind: 'documents', person: 'Sam' })],
    ['records bills, everyone', call('medrec_records', { kind: 'bills' })],
    ['records claims, everyone, 200', call('medrec_records', { kind: 'claims', limit: 200 })],
    ['records visits, everyone, detailed, 200', call('medrec_records', { kind: 'visits', limit: 200, response_format: 'detailed' })],
    ['records timeline, everyone, 200', call('medrec_records', { kind: 'timeline', limit: 200 })],
    ['records events, everyone', call('medrec_records', { kind: 'events' })],
    ['records events Robin, detailed, 200', call('medrec_records', { kind: 'events', person: 'Robin', response_format: 'detailed', limit: 200 })],
    ['records events "er", everyone', call('medrec_records', { kind: 'events', name: 'er', limit: 200 })],
    ['records events, one id', call('medrec_records', { kind: 'events', id: eventId })],
    ['document, page 1', call('medrec_document', { id: long })],
    ['document, page 3', call('medrec_document', { id: long, page: 3 })],
  ];
  const rows: string[] = [];
  if (process.env.PROFILE) {
    // Self time by function over N cold calls of the one call named.
    const [, f] = calls.find(([l]) => l === process.env.PROFILE)!;
    await f();
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 50 });
    await session.post('Profiler.start');
    for (let i = 0; i < N; i++) {
      touch();
      await f();
    }
    const { profile } = await session.post('Profiler.stop');
    const self = new Map<string, number>();
    const dt = new Map<number, number>();
    profile.samples!.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0)));
    for (const n of profile.nodes) {
      const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + (dt.get(n.id) ?? 0));
    }
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 40);
    writeFileSync('/tmp/oyh-profile.txt', top.map(([k, v]) => `${(v / 1000 / N).toFixed(3)} ms  ${k}`).join('\n'));
    rmSync(scratch, { recursive: true, force: true });
    return;
  }
  for (const [label, f] of calls.filter(([l]) => !process.env.ONLY || l.includes(process.env.ONLY))) {
    const cold = await measure(f, true);
    const warm = await measure(f, false);
    rows.push(`| ${label} | ${cold.min.toFixed(2)} | ${cold.median.toFixed(2)} | ${warm.min.toFixed(2)} | ${cold.subs} |`);
  }
  await Promise.all(pending);
  const largestJson = Math.max(...all.filter((f) => f.includes('/views/') && f.endsWith('.json')).map((f) => statSync(f).size));
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(
    process.env.OUT ?? '/tmp/oyh-views.md',
    `CPU ms on this thread through the Worker (fake Google ${inline ? 'inline, taken out' : 'on another thread'}), least and median of ${N}; load ${(await import('node:os')).loadavg()[0]!.toFixed(0)}; views: ${written.files} files, ${(written.bytes / 1e6).toFixed(1)} MB, largest JSON ${(largestJson / 1e3).toFixed(0)} KB; ${privateRecords} records private, private parts in search-parts.json (${(parts / 1e3).toFixed(0)} KB), every claim labelled (${(labels / 1e3).toFixed(0)} KB)\n` +
      `| Call | cold, least | cold, median | warm, least | subrequests |\n|---|---:|---:|---:|---:|\n${rows.join('\n')}\n`,
  );
}, 600_000);
