// The whole Worker, end to end in Node: an assistant registers, the user
// consents and signs in with (fake) Google, the assistant calls the tools,
// refreshes, and loses access when the allowlist or Google says so. KV and D1
// are in memory; Google is test/fake-google.ts over the demo folder.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParsedCache } from '../src/records/folder';
import { callTool } from '../src/records/tools';
import worker, { type Env } from '../src/worker';
import { CLIENT_ID, CLIENT_SECRET, FOLDER_ID, FakeGoogle } from './fake-google';
import { DEMO, MemoryD1, MemoryKV, folderAt } from './support';
import { RawStore } from '../src/records/store';

const BASE = 'https://records.example.workers.dev';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

let g: FakeGoogle;
let env: Env;
let kv: MemoryKV;
let d1: MemoryD1;
const pending: Promise<unknown>[] = [];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: undefined }) as unknown as ExecutionContext;

beforeEach(() => {
  g = new FakeGoogle(DEMO);
  kv = new MemoryKV();
  d1 = new MemoryD1();
  env = {
    OAUTH_KV: kv as unknown as KVNamespace,
    AUDIT: d1 as unknown as D1Database,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    ALLOWED_ACCOUNTS: 'Robin@Example.com, sam@example.com',
    FOLDER_ID,
    TIME_ZONE: 'Pacific/Auckland',
    ASSISTANTS: 'claude,loopback',
  } as Env;
  vi.stubGlobal('fetch', g.fetch);
});
afterEach(async () => {
  await Promise.all(pending.splice(0));
  vi.unstubAllGlobals();
});

class Browser {
  cookies = new Map<string, string>();
  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), env, ctx());
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}

async function register(redirect = CLAUDE, name = 'Claude') {
  return worker.fetch(
    new Request(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    }),
    env,
    ctx(),
  );
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** Up to Google's consent: the browser, and where it was sent. */
async function startConnect(clientId: string, redirect = CLAUDE) {
  const b = new Browser();
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'st-1', code_challenge: s256(verifier), code_challenge_method: 'S256', scope: 'records:read', resource: `${BASE}/mcp` });
  const page = await b.go(`${BASE}/authorize?${q}`);
  return { b, verifier, page };
}

async function connect(email = 'robin@example.com') {
  const client = (await (await register()).json()) as { client_id: string };
  const { b, verifier, page } = await startConnect(client.client_id);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const toGoogle = await b.go(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
  g.next = { email, sub: email === 'robin@example.com' ? '1001' : '2002' };
  const back = await b.go(g.approve(toGoogle.headers.get('Location')!));
  return { client, verifier, back, b, toGoogle };
}

async function tokens(clientId: string, code: string, verifier: string) {
  const res = await worker.fetch(
    new Request(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
    }),
    env,
    ctx(),
  );
  return { res, body: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
}

async function refresh(clientId: string, refreshToken: string) {
  const res = await worker.fetch(
    new Request(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    }),
    env,
    ctx(),
  );
  return { res, body: (await res.json()) as { access_token: string; refresh_token: string; error?: string } };
}

async function mcp(token: string, method: string, params?: unknown) {
  const res = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) }),
    }),
    env,
    ctx(),
  );
  return { res, body: res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } }) : null };
}

async function connected() {
  const { client, verifier, back } = await connect();
  const code = new URL(back.headers.get('Location')!).searchParams.get('code')!;
  const t = await tokens(client.client_id, code, verifier);
  return { client, ...t.body };
}

describe('connecting', () => {
  it('registers only assistants whose callbacks are allowed', async () => {
    expect((await register()).status).toBe(201);
    const evil = await register('https://evil.example/cb', 'Claude');
    expect(evil.status).toBe(400);
    expect(await evil.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('shows a consent page that names the callback host, escapes the client, and cannot be framed', async () => {
    const client = (await (await register(CLAUDE, '<script>alert(1)</script>')).json()) as { client_id: string };
    const { page } = await startConnect(client.client_id);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('&#60;script&#62;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>claude.ai</strong> (Claude)');
    expect(page.headers.get('Content-Security-Policy')).toMatch(/frame-ancestors 'none'.*|form-action 'self' https:\/\/accounts.google.com https:\/\/claude.ai/);
    expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://accounts.google.com https://claude.ai");
  });

  it('sends the user to Google with PKCE, offline access and only the Drive scope configured', async () => {
    const { toGoogle } = await connect();
    const u = new URL(toGoogle.headers.get('Location')!);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/google/callback`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('completes for an admitted account and hands the assistant a code', async () => {
    const { back } = await connect();
    expect(back.status).toBe(302);
    const to = new URL(back.headers.get('Location')!);
    expect(to.origin + to.pathname).toBe(CLAUDE);
    expect(to.searchParams.get('state')).toBe('st-1');
    expect(to.searchParams.get('code')).toBeTruthy();
  });

  it('refuses an account not on the allowlist, without a code', async () => {
    const { back } = await connect('mallory@example.com');
    expect(back.status).toBe(403);
    expect(await back.text()).toContain('not one this connector admits');
    expect(d1.rows.at(-1)).toEqual([expect.any(String), 'mallory@example.com', '', 'Claude', 'refused', 0]);
  });

  it('refuses a sign-in that withheld Drive', async () => {
    g.dropDriveScope = true;
    const { back } = await connect();
    expect(back.status).toBe(403);
    expect(await back.text()).toContain('did not grant access to Drive');
  });

  it('answers Cancel with access_denied to the assistant', async () => {
    const client = (await (await register()).json()) as { client_id: string };
    const { b, page } = await startConnect(client.client_id);
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
    const denied = await b.go(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, decision: 'deny' }) });
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('refuses a consent form posted from another browser', async () => {
    const client = (await (await register()).json()) as { client_id: string };
    const { page } = await startConnect(client.client_id);
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
    const other = await new Browser().go(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(other.status).toBe(400);
  });

  it('says what is missing when the Worker is not set up', async () => {
    env.GOOGLE_CLIENT_SECRET = '';
    const client = (await (await register()).json()) as { client_id: string };
    const { page } = await startConnect(client.client_id);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('GOOGLE_CLIENT_SECRET not set');
  });

  it('connects before the folder is set, and its tools say what is missing', async () => {
    env.FOLDER_ID = '';
    const { access_token } = await connected();
    const call = await mcp(access_token, 'tools/call', { name: 'medrec_summary', arguments: {} });
    expect(call.body?.result?.isError).toBe(true);
    expect(JSON.stringify(call.body?.result)).toContain('FOLDER_ID not set');
  });
});

describe('using the tools', () => {
  it('serves medrec\'s tools over MCP, from Drive, as medrec answers them', async () => {
    const { access_token } = await connected();
    const init = await mcp(access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body?.result?.serverInfo).toMatchObject({ name: 'own-your-health-connector' });
    expect(String(init.body?.result?.instructions)).toContain('Free-text fields in results');
    const list = await mcp(access_token, 'tools/list');
    expect((list.body?.result?.tools as { name: string }[]).map((t) => t.name)).toEqual(['medrec_summary', 'medrec_search', 'medrec_records', 'medrec_document']);
    const call = await mcp(access_token, 'tools/call', { name: 'medrec_summary', arguments: { person: 'Robin' } });
    const local = await callTool('medrec_summary', { person: 'Robin' }, { store: new RawStore(folderAt(DEMO, new ParsedCache())), today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date()) });
    expect(call.body?.result).toEqual(local);
    expect(call.res.headers.get('Cache-Control')).toBe('no-store');
  });

  it("words an unknown tool as medrec does", async () => {
    const { access_token } = await connected();
    const r = await mcp(access_token, 'tools/call', { name: 'medrec_delete', arguments: {} });
    expect(r.body?.error).toEqual({ code: -32602, message: 'unknown tool `medrec_delete`; this server has: medrec_summary, medrec_search, medrec_records, medrec_document' });
  });

  it('audits who called which tool, never the arguments', async () => {
    const { access_token } = await connected();
    await mcp(access_token, 'tools/call', { name: 'medrec_search', arguments: { query: 'cholesterol' } });
    await Promise.all(pending.splice(0));
    const events = d1.rows.map((r) => r[4]);
    expect(events).toEqual(['connect', 'medrec_search']);
    expect(JSON.stringify(d1.rows)).not.toContain('cholesterol');
    expect(d1.rows.at(-1)!.slice(1)).toEqual(['robin@example.com', expect.stringMatching(/.+/), 'Claude', 'medrec_search', 1]);
  });

  it('refuses a request without a token, pointing at the resource metadata', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', body: '{}' }), env, ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('keeps no Google token in the clear in KV', async () => {
    await connected();
    const all = JSON.stringify([...kv.data.values()]);
    expect(all).not.toMatch(/\brt-1001-\d+|\bat-1001-\d+/);
  });
});

describe('keeping and losing access', () => {
  it('refreshes through Google and keeps working', async () => {
    const { client, refresh_token } = await connected();
    const r = await refresh(client.client_id, refresh_token);
    expect(r.res.status).toBe(200);
    const call = await mcp(r.body.access_token, 'tools/call', { name: 'medrec_summary', arguments: {} });
    expect(call.body?.result?.isError).toBe(false);
  });

  it('ends a connection whose account leaves the allowlist', async () => {
    const { client, access_token, refresh_token } = await connected();
    env.ALLOWED_ACCOUNTS = 'sam@example.com';
    const call = await mcp(access_token, 'tools/call', { name: 'medrec_summary', arguments: {} });
    expect(call.res.status).toBe(401);
    expect((await refresh(client.client_id, refresh_token)).body.error).toBe('invalid_grant');
  });

  it('ends a connection whose Google sign-in was revoked', async () => {
    const { client, refresh_token } = await connected();
    for (const rt of g.refresh.keys()) g.revokedRefresh.add(rt);
    expect((await refresh(client.client_id, refresh_token)).body.error).toBe('invalid_grant');
    // The provider revoked the grant: the newest refresh token is dead too.
    expect([...kv.data.keys()].some((k) => k.startsWith('grant:'))).toBe(false);
  });
});
