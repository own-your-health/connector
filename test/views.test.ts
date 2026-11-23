// The views store reads only the views a call needs, and never answers from
// views that no longer match the records: a small person's files are read
// whole instead, and a large person gets an error that says why.

import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { DriveSource, SUBREQUESTS } from '../src/records/drive-source';
import { Folder, ParsedCache } from '../src/records/folder';
import { RawStore } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, hex, paths, prefixOf } from '../src/views/format';
import { fold } from '../src/records/text';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore, planRanges } from '../src/views/store';
import { FOLDER_ID, FakeGoogle } from './fake-google';
import { DEMO, LocalSource, folderAt } from './support';

const TODAY = '2026-11-23';
let scratch = '';
let large = '';
let demo = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'oyh-views-'));
  large = synth(join(scratch, 'large'));
  writeViewsAt(large);
  demo = join(scratch, 'demo');
  cpSync(DEMO, demo, { recursive: true });
  writeViewsAt(demo);
}, 120_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of a prepared folder, to change. */
function copy(from: string, name: string): string {
  const to = join(scratch, name);
  cpSync(from, to, { recursive: true });
  return to;
}

async function ask(root: string, name: string, args: Record<string, unknown>) {
  const src = new LocalSource(root);
  const r = await callTool(name, args, { store: new ViewsStore(new Folder(src, new ParsedCache(), root)), today: TODAY });
  return { r: r!, read: src.readPaths };
}

const raw = async (root: string, name: string, args: Record<string, unknown>) =>
  (await callTool(name, args, { store: new RawStore(folderAt(root)), today: TODAY }))!;

const whole = (read: string[]) => read.filter((p) => /\/(index|text)\.json$/.test(p));

describe('the views store', () => {
  const calls: [string, Record<string, unknown>][] = [
    ['medrec_summary', {}],
    ['medrec_summary', { person: 'Sam' }],
    ['medrec_search', { query: 'cholesterol' }],
    ['medrec_search', { query: 'lab results', person: 'Robin' }],
    ['medrec_search', { query: 'vitamin d' }],
    ['medrec_search', { query: 'e', person: 'Alex', limit: 50 }],
    ['medrec_search', { query: 'labs', since: '2014-01-01', until: '2014-12-31' }],
    ['medrec_records', { kind: 'results', limit: 200 }],
    ['medrec_records', { kind: 'tests', name: 'glucose' }],
    ['medrec_records', { kind: 'timeline', person: 'Robin', since: '2014-01-01', until: '2014-12-31' }],
    ['medrec_records', { kind: 'medications', active: true, response_format: 'detailed' }],
    ['medrec_records', { kind: 'results', name: 'a1c', since: '2015-01-01', response_format: 'detailed' }],
    ['medrec_records', { kind: 'documents', person: 'Sam' }],
  ];
  for (const [name, args] of calls) {
    it(`answers ${name} ${JSON.stringify(args)} from the views alone`, async () => {
      const { r, read } = await ask(large, name, args);
      expect(r.isError ?? false).toBe(false);
      expect(whole(read)).toEqual([]);
      expect(r).toEqual(await raw(large, name, args));
    });
  }

  it("reads a document's text with one range of one pack", async () => {
    const docs = await raw(large, 'medrec_records', { kind: 'documents', person: 'Sam', limit: 1 });
    const id = (docs.structuredContent as { items: { id: string }[] }).items[0]!.id;
    const { r, read } = await ask(large, 'medrec_document', { id, page: 2 });
    expect(r).toEqual(await raw(large, 'medrec_document', { id, page: 2 }));
    expect(read.filter((p) => p.endsWith('.bin'))).toHaveLength(1);
    expect(whole(read)).toEqual([]);
  });

  it("reads a small person's files whole when their views are stale", async () => {
    const root = copy(demo, 'demo-stale');
    appendFileSync(join(root, 'Jamie Example/index.json'), '\n');
    const { r, read } = await ask(root, 'medrec_summary', { person: 'Jamie' });
    expect(r).toEqual(await raw(root, 'medrec_summary', { person: 'Jamie' }));
    expect(whole(read)).toEqual(['Jamie Example/index.json']);
    // Everyone else still comes from the views.
    const sam = await ask(root, 'medrec_records', { kind: 'results', person: 'Sam' });
    expect(whole(sam.read)).toEqual([]);
  });

  it("refuses a large person's stale views and says why, and serves everyone else", async () => {
    const root = copy(large, 'large-stale');
    appendFileSync(join(root, 'Robin Example/index.json'), ' ');
    const { r, read } = await ask(root, 'medrec_summary', { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Robin Example's records changed after medrec last prepared them for assistants/);
    expect(whole(read)).toEqual([]);
    const sam = await ask(root, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 });
    expect(sam.r.isError ?? false).toBe(false);
    // The people list gives Robin's counts as last prepared, rather than fail everyone's summary.
    const summary = await ask(root, 'medrec_summary', { person: 'Sam' });
    expect(summary.r.isError ?? false).toBe(false);
    expect(whole(summary.read)).toEqual([]);
    // A question about Robin by name gets the error itself.
    const named = await ask(root, 'medrec_search', { query: 'cholesterol', person: 'Robin' });
    expect(named.r.isError).toBe(true);
    expect(named.r.content[0]!.text).toMatch(/Robin Example's records changed/);
  });

  it('answers a question about everyone without a person who cannot be read, and says so', async () => {
    const root = copy(large, 'large-stale-everyone');
    appendFileSync(join(root, 'Robin Example/index.json'), ' ');
    type Page = { items: { person: string }[]; warnings?: { code: string; message: string }[] };
    const calls: [string, Record<string, unknown>][] = [
      ['medrec_search', { query: 'cholesterol' }],
      ['medrec_records', { kind: 'results', limit: 50 }],
      ['medrec_records', { kind: 'tests' }],
      ['medrec_records', { kind: 'timeline', limit: 50 }],
      ['medrec_records', { kind: 'documents', limit: 50 }],
    ];
    for (const [name, args] of calls) {
      const { r } = await ask(root, name, args);
      expect(r.isError ?? false, `${name} ${JSON.stringify(args)}`).toBe(false);
      const page = r.structuredContent as Page;
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.some((x) => x.person === 'Robin Example')).toBe(false);
      expect(page.warnings).toEqual([{ code: 'person-unavailable', message: expect.stringMatching(/^Robin Example's records changed after medrec last prepared them.*; they are missing from this list\. Tell the user/) }]);
    }
    // Everyone else's rows are what they would be without Robin.
    const sam = (await ask(root, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 })).r.structuredContent as Page;
    expect(sam.warnings).toBeUndefined();
  });

  it('gives the error when no one in a question about everyone can be read', async () => {
    const root = copy(large, 'large-stale-all');
    // Only the two large people, and a changed household.json makes both stale.
    const at = join(root, 'household.json');
    const household = JSON.parse(readFileSync(at, 'utf8')) as { people: { name: string }[] };
    household.people = household.people.filter((p) => p.name === 'Robin Example' || p.name === 'Sam Example');
    writeFileSync(at, JSON.stringify(household));
    const { r } = await ask(root, 'medrec_search', { query: 'cholesterol' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Robin Example's records changed/);
  });

  it("does not pass over another kind of error while looking for a document", async () => {
    const root = copy(demo, 'demo-corrupt');
    // Robin is small, so stale views are read whole, and the file does not parse.
    writeFileSync(join(root, 'Robin Example/index.json'), '{"schema":');
    const docs = await raw(demo, 'medrec_records', { kind: 'documents', person: 'Sam', limit: 1 });
    const id = (docs.structuredContent as { items: { id: string }[] }).items[0]!.id;
    const { r } = await ask(root, 'medrec_document', { id });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toMatch(/being prepared|changed after medrec/);
  });

  it('treats a changed household.json as stale views for everyone', async () => {
    const root = copy(demo, 'demo-household');
    appendFileSync(join(root, 'household.json'), '\n');
    const { r, read } = await ask(root, 'medrec_summary', {});
    expect(r).toEqual(await raw(root, 'medrec_summary', {}));
    expect(whole(read).length).toBeGreaterThan(0);
  });

  it('ignores views of another schema', async () => {
    const root = copy(demo, 'demo-schema');
    const at = join(root, VIEWS_INDEX);
    writeFileSync(at, readFileSync(at, 'utf8').replace('medrec-views/v1', 'medrec-views/v2'));
    const { r } = await ask(root, 'medrec_records', { kind: 'conditions' });
    expect(r).toEqual(await raw(root, 'medrec_records', { kind: 'conditions' }));
  });

  it('says a newer layout needs a newer connector, for a person too large to read whole', async () => {
    const root = copy(large, 'large-schema');
    const at = join(root, VIEWS_INDEX);
    writeFileSync(at, readFileSync(at, 'utf8').replace('medrec-views/v1', 'medrec-views/v2'));
    const { r } = await ask(root, 'medrec_summary', { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/newer layout \(medrec-views\/v2\) than this connector reads/);
    expect(r.content[0]!.text).toMatch(/connector needs updating/);
  });

  it("finds another person's document while one person's views are stale", async () => {
    const root = copy(large, 'large-stale-document');
    // Robin comes first in household.json, so the lookup meets them first.
    appendFileSync(join(root, 'Robin Example/index.json'), ' ');
    const docs = await raw(root, 'medrec_records', { kind: 'documents', person: 'Sam', limit: 1 });
    const id = (docs.structuredContent as { items: { id: string }[] }).items[0]!.id;
    const { r } = await ask(root, 'medrec_document', { id });
    expect(r).toEqual(await raw(root, 'medrec_document', { id }));
    // An id no one readable has may be Robin's: the answer is why Robin cannot be read.
    const missing = await ask(root, 'medrec_document', { id: 'doc_not_anyones' });
    expect(missing.r.isError).toBe(true);
    expect(missing.r.content[0]!.text).toMatch(/Robin Example's records changed/);
  });

  it('never mixes a view from a pass still arriving with the views.json before it', async () => {
    const root = copy(large, 'large-mixed');
    const household = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; name: string }[] };
    const sam = household.people.find((p) => p.name === 'Sam Example')!.id;
    // The next pass's newest results shard arrives first: valid, but not the one views.json names.
    const dir = join(root, 'views', sam);
    const newest = readdirSync(dir).filter((f) => /^records-result-\d+\.json$/.test(f)).sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]))[0]!;
    const shard = JSON.parse(readFileSync(join(dir, newest), 'utf8')) as unknown[];
    writeFileSync(join(dir, newest), JSON.stringify(shard.slice(1)));
    const { r } = await ask(root, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/being prepared for assistants right now/);
    const tests = await ask(root, 'medrec_records', { kind: 'tests', person: 'Sam' });
    expect(tests.r.isError).toBe(true);
    // Everyone else answers.
    const robin = await ask(root, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 });
    expect(robin.r).toEqual(await raw(root, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 }));
  });

  it('says the records are being prepared when a view is missing', async () => {
    const root = copy(large, 'large-missing');
    const household = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; name: string }[] };
    rmSync(join(root, paths.summary(household.people.find((p) => p.name === 'Sam Example')!.id)));
    const { r } = await ask(root, 'medrec_summary', { person: 'Sam' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/being prepared for assistants right now/);
  });
});

describe('the views through Drive', () => {
  const signedIn = (root: string) => {
    const g = new FakeGoogle(root);
    const token = (g as unknown as { mint(a: { email: string; sub: string }): string }).mint({ email: 'robin@example.com', sub: '1' });
    return { g, token };
  };
  const viaDrive = async (root: string, name: string, args: Record<string, unknown>) => {
    const { g, token } = signedIn(root);
    const source = new DriveSource(token, FOLDER_ID, g.fetch);
    const r = await callTool(name, args, { store: new ViewsStore(new Folder(source, new ParsedCache(), 'd')), today: TODAY });
    return { r: r!, seen: g.seen, requests: source.requests };
  };

  for (const [name, args] of [
    ['medrec_summary', { person: 'Sam' }],
    ['medrec_search', { query: 'cholesterol' }],
    ['medrec_search', { query: 'patient visit summary', since: '2015-01-01' }],
    ['medrec_records', { kind: 'timeline', limit: 100 }],
    ['medrec_records', { kind: 'tests', name: 'glucose' }],
  ] as [string, Record<string, unknown>][]) {
    it(`answers ${name} ${JSON.stringify(args)} as the files do, in few requests`, async () => {
      const { r, requests } = await viaDrive(large, name, args);
      expect(r).toEqual(await raw(large, name, args));
      expect(requests).toBeLessThanOrEqual(40);
    });
  }

  it("reads a document's page with one range", async () => {
    const docs = await raw(large, 'medrec_records', { kind: 'documents', person: 'Robin', limit: 1 });
    const id = (docs.structuredContent as { items: { id: string }[] }).items[0]!.id;
    const { r, seen } = await viaDrive(large, 'medrec_document', { id, page: 2 });
    expect(r).toEqual(await raw(large, 'medrec_document', { id, page: 2 }));
    // Listings and the survey are files.list; every download is of one file.
    expect(seen.filter((x) => x !== 'GET www.googleapis.com /drive/v3/files').length).toBeLessThanOrEqual(5);
  });

  it(`refuses past ${SUBREQUESTS} requests to Google with a clear error`, async () => {
    const { g, token } = signedIn(demo);
    const source = new DriveSource(token, FOLDER_ID, g.fetch);
    let error: unknown;
    try {
      for (let i = 0; i < 60; i++) await source.bytes('household.json', i, i + 1);
    } catch (e) {
      error = e;
    }
    expect(source.requests).toBe(SUBREQUESTS + 1);
    expect(String((error as Error).message)).toMatch(/needs more of the records than one request may read/);
  });
});

describe('planning byte ranges', () => {
  const plan = (wanted: Record<string, [number, number][]>, max: number) => Object.fromEntries(planRanges(new Map(Object.entries(wanted)), max));
  it('reads near spans as one range', () => {
    expect(plan({ a: [[100_000, 100_010], [0, 10], [5, 20], [16_000, 16_010]] }, 10)).toEqual({ a: [[0, 16_010], [100_000, 100_010]] });
  });
  it('joins the closest pair anywhere until the budget holds, one range a file at the least', () => {
    const wanted: Record<string, [number, number][]> = { a: [[0, 10], [50_000, 50_010], [400_000, 400_010]], b: [[0, 10], [30_000, 30_010]] };
    expect(plan(wanted, 5)).toEqual(wanted);
    expect(plan(wanted, 4)).toEqual({ a: wanted.a, b: [[0, 30_010]] });
    expect(plan(wanted, 3)).toEqual({ a: [[0, 50_010], [400_000, 400_010]], b: [[0, 30_010]] });
    expect(plan(wanted, 0)).toEqual({ a: [[0, 400_010]], b: [[0, 30_010]] });
  });
});

describe('rewriting the views after a new record', () => {
  it('changes only the newest shards and the search shards of its words', () => {
    const root = copy(large, 'large-append');
    const household = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; name: string; folder: string }[] };
    const robin = household.people.find((p) => p.name === 'Robin Example')!;
    const dir = join(root, 'views', robin.id);
    const snapshot = () => new Map(readdirSync(dir).map((f) => [f, createHash('md5').update(readFileSync(join(dir, f))).digest('hex')]));
    const before = snapshot();
    const at = join(root, robin.folder, 'index.json');
    const index = JSON.parse(readFileSync(at, 'utf8'));
    const record = { id: 'rec_appended_test_result', kind: 'result', date: '2026-12-01', display: 'Zinc', code: null, status: 'final', fields: { value: 'Quixotic' } };
    index.records.push(record);
    writeFileSync(at, JSON.stringify(index));
    writeViewsAt(root);
    const after = snapshot();
    const changed = [...after].filter(([f, m]) => before.get(f) !== m).map(([f]) => f);
    const words = fold('Zinc\nQuixotic').split(' ');
    const allowed = new Set(words.flatMap((w) => [`search-${hex(prefixOf(w))}.json`, `search-1-${hex(prefixOf(w, 1))}.json`]));
    const shardsOf = (prefix: string) => [...after.keys()].filter((f) => f.startsWith(prefix) && /-\d+\.json$/.test(f)).map((f) => Number(/-(\d+)\.json$/.exec(f)![1]));
    const newest = (prefix: string) => Math.max(...shardsOf(prefix));
    for (const f of changed) {
      if (f.startsWith('search-') && f.endsWith('.json') && !f.startsWith('search-labs-')) expect(allowed.has(f), f).toBe(true);
      else if (f.startsWith('records-result-')) expect(Number(/-(\d+)\.json$/.exec(f)![1]), f).toBeGreaterThanOrEqual(newest('records-result-') - 1);
      else if (f.startsWith('timeline-')) expect(Number(/-(\d+)\.json$/.exec(f)![1]), f).toBeGreaterThanOrEqual(newest('timeline-') - 1);
      else expect(['summary.json', 'names-result.json', 'tests.json', 'search-items.bin', 'search-hay.bin', 'documents.json', f.startsWith('search-labs-') ? f : ''], f).toContain(f);
    }
    // Of hundreds of views, a few dozen at most.
    expect(changed.length).toBeLessThan(20);
    expect(after.size).toBeGreaterThan(200);
  });
});
