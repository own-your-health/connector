// The pieces under the tools: paging, the redirect allowlist, the folder's
// cache, and Drive as a FileSource.

import { describe, expect, it } from 'vitest';
import { redirectOwner } from '../src/auth/assistants';
import { ToolError } from '../src/mcp/errors';
import { PageRequest } from '../src/mcp/shape';
import { DriveSource } from '../src/records/drive-source';
import { Folder, ParsedCache, type FileSource } from '../src/records/folder';
import { callTool } from '../src/records/tools';
import { isLab, memberShare, moneyForTests, recordDetail } from '../src/records/views';
import { FOLDER_ID, FakeGoogle } from './fake-google';
import { DEMO, LocalSource } from './support';

describe('paging', () => {
  const filters = { query: 'a', person: null };
  it('issues a cursor that resumes after the rows it returned', () => {
    const p = PageRequest.create({ limit: 2 }, filters);
    const page = p.page([1, 2, 3, 4, 5], 'person');
    expect(page).toMatchObject({ items: [1, 2], returned: 2 });
    const next = PageRequest.create({ limit: 2, cursor: page.next_cursor }, filters);
    expect(next.page([1, 2, 3, 4, 5], 'person').items).toEqual([3, 4]);
  });
  it('refuses a cursor from other filters, and one it never issued', () => {
    const c = PageRequest.create({ limit: 2 }, filters).page([1, 2, 3], 'x').next_cursor;
    expect(() => PageRequest.create({ cursor: c }, { query: 'b', person: null })).toThrow(/different filters/);
    expect(() => PageRequest.create({ cursor: 'c1:0:0' }, filters)).toThrow(/not one this tool returned/);
  });
  it('cuts a page at the size budget and says how to narrow', () => {
    const rows = Array.from({ length: 10 }, (_, i) => 'x'.repeat(400) + i);
    const page = PageRequest.create({ limit: 10 }, filters, 3_500).page(rows, 'person');
    expect(page.returned).toBeLessThan(10);
    expect(page.truncated).toBe(true);
    expect(page.hint).toMatch(/^Stopped at \d+ records to stay under the 3500-character/);
  });
});

/** A callback with a user name in its authority, which redirectOwner refuses. */
function withUserinfo(uri: string): string {
  const u = new URL(uri);
  u.username = 'someone';
  return u.href;
}

describe('redirect allowlist', () => {
  const env = { ASSISTANTS: 'claude,chatgpt,gemini,loopback' };
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', 'Claude'],
    ['https://claude.ai/api/mcp/auth_callback?x=1', 'Claude'],
    ['https://chatgpt.com/connector/oauth/abc123', 'ChatGPT'],
    ['https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT'],
    ['https://oauth-redirect.googleusercontent.com/r/gemini', 'Gemini'],
    ['http://127.0.0.1:33418/callback', 'an app on this computer'],
    ['http://localhost:7777/oauth/callback', 'an app on this computer'],
  ])('sends codes to %s', (uri, owner) => {
    expect(redirectOwner(uri, env)?.name).toBe(owner);
  });
  it.each([
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/other',
    'http://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/../../x',
    withUserinfo('https://claude.ai/api/mcp/auth_callback'),
    'http://192.168.1.5:8000/callback',
    'https://oauth-redirect.googleusercontent.com/x/gemini',
    'not a url',
  ])('refuses %s', (uri) => {
    expect(redirectOwner(uri, env)).toBeNull();
  });
  it('allows only Claude and loopback by default, and listed extras', () => {
    expect(redirectOwner('https://chatgpt.com/connector/oauth/a', {})).toBeNull();
    expect(redirectOwner('https://claude.ai/api/mcp/auth_callback', {})?.name).toBe('Claude');
    expect(redirectOwner('https://app.example/cb', { EXTRA_REDIRECT_URIS: 'https://app.example/cb' })?.name).toBe('app.example');
  });
});

class Counting implements FileSource {
  reads: string[] = [];
  constructor(
    private readonly files: Record<string, string>,
    public versions: Record<string, string> = {},
  ) {}
  async version(p: string) {
    return p in this.files ? (this.versions[p] ?? 'v1') : null;
  }
  async read(p: string) {
    this.reads.push(p);
    return this.files[p] ?? null;
  }
}

const HOUSEHOLD = JSON.stringify({ schema: 'medrec-household/v1', format: 1, people: [{ id: 'p_a', name: 'Ada Test', folder: 'Ada Test', adult: true }] });

describe('the folder and its cache', () => {
  it('reads a file again only when its version changes', async () => {
    const src = new Counting({ 'household.json': HOUSEHOLD });
    const cache = new ParsedCache();
    await new Folder(src, cache, 's').household();
    await new Folder(src, cache, 's').household();
    expect(src.reads).toEqual(['household.json']);
    src.versions['household.json'] = 'v2';
    await new Folder(src, cache, 's').household();
    expect(src.reads).toEqual(['household.json', 'household.json']);
  });
  it('drops the oldest entries past its bound', () => {
    const cache = new ParsedCache(10);
    cache.set('a', 'v', 1, 6);
    cache.set('b', 'v', 2, 6);
    expect(cache.get('a', 'v')).toBeUndefined();
    expect(cache.get('b', 'v')).toBe(2);
  });
  it('never quotes a file it cannot parse', async () => {
    const src = new Counting({ 'household.json': '{"schema": "medrec-household/v1", "secret": "Ada has a condition' });
    const e = await new Folder(src, new ParsedCache(), 's').household().catch((x) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect(e.message).toBe('household.json is not valid JSON');
  });
  it('refuses a folder that is not a records folder, or is newer', async () => {
    await expect(new Folder(new Counting({}), new ParsedCache(), 's').household()).rejects.toThrow(/household.json is missing/);
    const newer = new Counting({ 'household.json': HOUSEHOLD.replace('"format":1', '"format":2') });
    await expect(new Folder(newer, new ParsedCache(), 's').household()).rejects.toThrow(/format 2, newer than this connector/);
  });
  it("refuses an index that names another person", async () => {
    const src = new Counting({ 'household.json': HOUSEHOLD, 'Ada Test/index.json': '{"schema":"medrec-index/v1","person":"p_b"}' });
    const r = await callTool('medrec_summary', { person: 'Ada' }, { folder: new Folder(src, new ParsedCache(), 's'), today: '2026-11-23' });
    expect(r?.content[0]?.text).toMatch(/^other: Ada Test\/index.json names another person/);
  });
});

describe('Drive as the folder', () => {
  const today = '2026-11-23';
  const signedIn = () => {
    const g = new FakeGoogle(DEMO);
    const token = (g as unknown as { mint(a: { email: string; sub: string }): string }).mint({ email: 'robin@example.com', sub: '1' });
    return { g, token };
  };

  it('answers as the same folder on disk does', async () => {
    const { g, token } = signedIn();
    for (const [name, args] of [
      ['medrec_summary', { person: 'Robin' }],
      ['medrec_search', { query: 'cholesterol' }],
      ['medrec_records', { kind: 'timeline', limit: 50 }],
    ] as const) {
      const drive = await callTool(name, args, { folder: new Folder(new DriveSource(token, FOLDER_ID, g.fetch), new ParsedCache(), 'd'), today });
      const disk = await callTool(name, args, { folder: new Folder(new LocalSource(DEMO), new ParsedCache(), 'l'), today });
      expect(drive).toEqual(disk);
    }
  });

  it('lists the folder on every call but downloads only what changed', async () => {
    const { g, token } = signedIn();
    const cache = new ParsedCache();
    const call = () => callTool('medrec_summary', { person: 'Robin' }, { folder: new Folder(new DriveSource(token, FOLDER_ID, g.fetch), cache, 'd'), today });
    await call();
    const first = g.seen.length;
    const downloads = g.seen.filter((s) => s.includes('/files/')).length;
    await call();
    const second = g.seen.slice(first);
    expect(second.every((s) => s === 'GET www.googleapis.com /drive/v3/files')).toBe(true);
    expect(downloads).toBeGreaterThan(0);
  });

  it.each([
    [401, 'authError', /^auth: the Google sign-in behind this connection no longer works\. Ask the user to connect/],
    [403, 'userRateLimitExceeded', /^upstream: Google Drive answered 403\./],
    [503, 'backendError', /^upstream: Google Drive answered 503\./],
    [403, 'insufficientFilePermissions', /^auth: Google Drive refused to read the records folder \(insufficientFilePermissions\)/],
  ])('reports Drive %i %s without Drive\'s own words', async (status, reason, want) => {
    const { g, token } = signedIn();
    g.faults.push({ status, reason });
    const r = await callTool('medrec_summary', {}, { folder: new Folder(new DriveSource(token, FOLDER_ID, g.fetch), new ParsedCache(), 'd'), today });
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).toMatch(want);
    expect(r?.content[0]?.text).not.toMatch(/secret-file-name/);
  });

  it('says so when the folder id shows no records folder', async () => {
    const { g, token } = signedIn();
    const r = await callTool('medrec_summary', {}, { folder: new Folder(new DriveSource(token, 'not-the-folder', g.fetch), new ParsedCache(), 'd'), today });
    expect(r?.content[0]?.text).toMatch(/^other: household.json is missing/);
  });
});

// medrec 0.5.0's claims.rs arithmetic, for the inputs the goldens do not reach.
describe("a claim's money", () => {
  const { units, decimal, addMoney } = moneyForTests;
  const usd = (amount: string) => ({ amount, currency: 'USD' });

  it('reads decimals as medrec does', () => {
    expect(units('12.3456')).toBe(123456n);
    expect(units(' 1.5\n')).toBe(15000n);
    expect(units('-.5')).toBe(-5000n);
    expect(units('7.')).toBe(70000n);
    for (const bad of ['', '.', '-', '+1', '1.23456', '1e3', '١٢', '1,000', '0x10']) expect(units(bad)).toBeUndefined();
    // i128: the largest amount in ten-thousandths parses, one more does not.
    const max = ((1n << 127n) - 1n).toString();
    expect(units(`${max.slice(0, -4)}.${max.slice(-4)}`)).toBe((1n << 127n) - 1n);
    expect(units(`${max.slice(0, -4)}.${(Number(max.slice(-4)) + 1).toString()}`)).toBeUndefined();
  });

  it('prints two places, or four when it has them', () => {
    expect(decimal(123500n)).toBe('12.35');
    expect(decimal(30001n)).toBe('3.0001');
    expect(decimal(-25000n)).toBe('-2.50');
    expect(decimal(0n)).toBe('0.00');
    expect(decimal(-1n)).toBe('-0.0001');
  });

  it('adds only one currency', () => {
    expect(addMoney(usd('1.10'), usd('2.20'))).toEqual(usd('3.30'));
    expect(addMoney({ amount: '1' }, { amount: '2' })).toEqual({ amount: '3.00', currency: null });
    expect(addMoney(usd('1'), { amount: '2', currency: 'EUR' })).toBeUndefined();
    expect(addMoney(usd('1'), { amount: '2' })).toBeUndefined();
    expect(addMoney(usd('1'), { amount: 2, currency: 'USD' })).toBeUndefined();
    expect(addMoney('1', '2')).toBeUndefined();
  });

  it("takes the payer's figure, else the parts the member pays", () => {
    expect(memberShare({ you_owe: usd('9.00'), copay: usd('1.00') })).toEqual({ value: usd('9.00'), summed: false });
    expect(memberShare({ deductible: usd('5'), copay: usd('1'), coinsurance: usd('2'), not_covered: usd('3'), discount: usd('100') })).toEqual({ value: usd('11.00'), summed: true });
    expect(memberShare({ copay: usd('not a number') })).toEqual({ value: usd('not a number'), summed: true });
    expect(memberShare({ discount: usd('4') })).toBeUndefined();
  });

  it('labels the share in a claim\'s detail', () => {
    const claim = (amounts: unknown, status = 'active') => ({ id: 'r', kind: 'claim', display: 'x', status, fields: { amounts } }) as never;
    expect(recordDetail(claim({ billed: usd('10.00'), you_owe: usd('2.00') }))).toBe('billed 10.00 USD, you owe 2.00 USD');
    expect(recordDetail(claim({ plan_paid: usd('8.00'), copay: usd('2.00') }))).toBe('plan paid 8.00 USD, your share 2.00 USD');
    expect(recordDetail(claim({ discount: usd('1.00') }))).toBe('active');
  });

  it('knows a lab record by its kind or a lab line', () => {
    expect(isLab({ id: 'a', kind: 'result', display: '' } as never)).toBe(true);
    expect(isLab({ id: 'a', kind: 'report', display: '' } as never)).toBe(true);
    expect(isLab({ id: 'a', kind: 'claim', display: '', fields: { items: [{ category: 'visit' }, { category: 'lab' }] } } as never)).toBe(true);
    expect(isLab({ id: 'a', kind: 'claim', display: '', fields: { items: [{ category: 'visit' }] } } as never)).toBe(false);
    expect(isLab({ id: 'a', kind: 'encounter', display: '' } as never)).toBe(false);
  });
});
