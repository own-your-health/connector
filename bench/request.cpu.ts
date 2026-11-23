// The fixed CPU of an authenticated MCP request (the OAuth provider's token
// check, the allowlist, MCP framing), through the real Worker with KV and D1
// in memory, measured on this thread.

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import worker, { type Env } from '../src/worker';
import { CLIENT_ID, CLIENT_SECRET, FOLDER_ID, FakeGoogle } from '../test/fake-google';
import { DEMO, MemoryD1, MemoryKV } from '../test/support';

const N = Number(process.env.N ?? 200);
const BASE = 'https://records.example.workers.dev';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const cpu = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

it('measures', async () => {
  const g = new FakeGoogle(DEMO);
  vi.stubGlobal('fetch', g.fetch);
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
  const back = await go(g.approve(toGoogle.headers.get('Location')!));
  const code = new URL(back.headers.get('Location')!).searchParams.get('code')!;
  const tok = (await (await go(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token: string };
  const rpc = async (method: string, params?: unknown) => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) }), env, ctx);
    await res.text();
  };
  const rows: [string, number][] = [];
  for (const [label, f] of [
    ['initialize', () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } })],
    ['tools/list', () => rpc('tools/list')],
    ['tools/call, unknown tool (no Drive)', () => rpc('tools/call', { name: 'nope', arguments: {} })],
    ['no token (401)', async () => void (await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', body: '{}' }), env, ctx)).text()],
  ] as [string, () => Promise<void>][]) {
    for (let i = 0; i < 10; i++) await f();
    const t0 = cpu();
    for (let i = 0; i < N; i++) await f();
    rows.push([label, (cpu() - t0) / N]);
  }
  await Promise.all(pending);
  writeFileSync(process.env.OUT ?? '/tmp/oyh-request.md', `| Request | CPU ms |\n|---|---:|\n${rows.map(([l, v]) => `| ${l} | ${v.toFixed(2)} |`).join('\n')}\n`);
});
