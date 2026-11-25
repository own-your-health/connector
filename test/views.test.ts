// The views store reads only the views a call needs, and never answers from
// views that no longer match the records: a small person's files are read
// whole instead, and a large person gets an error that says why.

import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { DriveSource, SUBREQUESTS } from '../src/records/drive-source';
import { Folder, ParsedCache } from '../src/records/folder';
import { RawStore } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, hex, paths, personDir, prefixOf, storedName, type ViewsIndex } from '../src/views/format';
import { fold } from '../src/records/text';
import { names } from '../src/records/private';
import { newestFirst, recordSource, seriesKey } from '../src/records/views';
import type { Household, RecordEntry } from '../src/records/model';
import { ToolError } from '../src/mcp/errors';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore, planRanges } from '../src/views/store';
import { FOLDER_ID, FakeGoogle } from './fake-google';
import { DEMO, LocalSource, RawWithDerived, addDerived, folderAt } from './support';

const TODAY = '2026-11-23';
let scratch = '';
let large = '';
let demo = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'oyh-views-'));
  large = synth(join(scratch, 'large'));
  writeViewsAt(large);
  addDerived(large, 'large');
  demo = join(scratch, 'demo');
  cpSync(DEMO, demo, { recursive: true });
  writeViewsAt(demo);
  addDerived(demo, 'records');
}, 120_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Where a view is stored in a prepared folder: `paths` names it, views.json gives its MD5 (storedName). */
function stored(root: string, path: string): string {
  const [, pid, name] = path.split('/');
  const index = JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex;
  return join(root, personDir(pid!) + storedName(name!, index.people[pid!]!.files[name!]!));
}

const personId = (root: string, name: string) =>
  (JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; name: string }[] }).people.find((p) => p.name === name)!.id;

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

/** The answer from the files, with the private items and payments medrec wrote for the folder this one was copied from. */
const raw = async (root: string, name: string, args: Record<string, unknown>) =>
  (await callTool(name, args, { store: new RawWithDerived(folderAt(root), basename(root).startsWith('large') ? 'large' : 'records', root), today: TODAY }))!;

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
    type Page = { items: { person: string; id: string }[]; warnings?: { code: string; message: string }[] };
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
      expect(page.warnings?.filter((w) => w.code === 'person-unavailable')).toEqual([
        { code: 'person-unavailable', message: expect.stringMatching(/^Robin Example's records changed after medrec last prepared them.*; they are missing from this list\. Tell the user/) },
      ]);
      // Robin's records are among those the newborn rules read for Alex and Jamie: their private items are not known until medrec's next pass.
      const unknown = page.warnings?.filter((w) => w.code === 'private-not-prepared').map((w) => /^medrec has not marked (.+?)'s private items/.exec(w.message)?.[1]);
      expect(unknown).toEqual(['Alex Example', 'Jamie Example']);
      // Only their notes, which are never private, stay.
      expect(page.items.filter((x) => x.person === 'Alex Example' || x.person === 'Jamie Example').every((x) => x.id.startsWith('n_'))).toBe(true);
    }
    // Everyone else's rows are what they would be without Robin.
    const sam = (await ask(root, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 })).r.structuredContent as Page;
    expect(sam.warnings).toBeUndefined();
  });

  it("leaves out a person whose snippets cannot be read after all, and ranks again without them", async () => {
    const sam = personId(large, 'Sam Example');
    // Drive returns short reads of Sam's hay, as when a file goes mid-call.
    class Short extends LocalSource {
      override async bytes(path: string, start: number, end: number) {
        const b = await super.bytes(path, start, end);
        return path.startsWith(`views/${sam}/search-hay-`) && b ? b.subarray(0, Math.max(0, b.length - 1)) : b;
      }
    }
    const store = new ViewsStore(new Folder(new Short(large), new ParsedCache(), large));
    const r = (await callTool('medrec_search', { query: 'cholesterol' }, { store, today: TODAY }))!;
    expect(r.isError ?? false).toBe(false);
    const page = r.structuredContent as { items: { person: string; snippet: string }[]; warnings?: { code: string; message: string }[] };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.some((x) => x.person === 'Sam Example')).toBe(false);
    expect(page.items.every((x) => x.snippet.length > 0)).toBe(true);
    expect(page.warnings?.filter((w) => w.code === 'person-unavailable')).toEqual([{ code: 'person-unavailable', message: expect.stringMatching(/^Sam Example's records are being prepared/) }]);
    // Asked about Sam by name, the error is the answer.
    const named = (await callTool('medrec_search', { query: 'cholesterol', person: 'Sam' }, { store: new ViewsStore(new Folder(new Short(large), new ParsedCache(), large)), today: TODAY }))!;
    expect(named.isError).toBe(true);
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

  it('answers a name for a kind of record the person has none of, with nothing and no warning', async () => {
    for (const args of [{ kind: 'allergies', person: 'Jamie', name: 'latex' }, { kind: 'allergies', name: 'latex' }, { kind: 'procedures', person: 'Alex', name: 'x' }]) {
      const { r } = await ask(demo, 'medrec_records', args);
      expect(r, JSON.stringify(args)).toEqual(await raw(demo, 'medrec_records', args));
      expect(r.isError ?? false).toBe(false);
      expect(((r.structuredContent as { warnings?: { code: string }[] }).warnings ?? []).some((w) => w.code === 'person-unavailable')).toBe(false);
    }
    const jamie = (await ask(demo, 'medrec_records', { kind: 'allergies', person: 'Jamie', name: 'latex' })).r.structuredContent as { items: unknown[] };
    expect(jamie.items).toEqual([]);
  });

  it('ignores views of another schema', async () => {
    const root = copy(demo, 'demo-schema');
    const at = join(root, VIEWS_INDEX);
    writeFileSync(at, readFileSync(at, 'utf8').replace('medrec-views/v2', 'medrec-views/v3'));
    // The files are read instead; private items in a layout this connector cannot read are not known.
    const { r } = await ask(root, 'medrec_records', { kind: 'conditions' });
    const files = (await callTool('medrec_records', { kind: 'conditions' }, { store: new RawStore(folderAt(root)), today: TODAY }))!;
    type Page = { items: unknown[]; warnings?: { code: string; message: string }[] };
    expect((r.structuredContent as Page).items).toEqual((files.structuredContent as Page).items);
    expect((r.structuredContent as Page).warnings?.map((w) => w.code)).toEqual((files.structuredContent as Page).warnings?.map((w) => w.code));
    const unknown = (r.structuredContent as Page).warnings?.filter((w) => w.code === 'private-not-prepared') ?? [];
    const people = (JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: unknown[] }).people;
    expect(unknown).toHaveLength(people.length);
    expect(unknown.every((w) => /their views are in a newer layout \(medrec-views\/v3\)/.test(w.message))).toBe(true);
  });

  it('says a newer layout needs a newer connector, for a person too large to read whole', async () => {
    const root = copy(large, 'large-schema');
    const at = join(root, VIEWS_INDEX);
    writeFileSync(at, readFileSync(at, 'utf8').replace('medrec-views/v2', 'medrec-views/v3'));
    const { r } = await ask(root, 'medrec_summary', { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/newer layout \(medrec-views\/v3\) than this connector reads/);
    expect(r.content[0]!.text).toMatch(/connector needs updating/);
  });

  it("says an older layout needs a new pass of the writer, for a person too large to read whole", async () => {
    const root = copy(large, 'large-old-schema');
    const at = join(root, VIEWS_INDEX);
    writeFileSync(at, readFileSync(at, 'utf8').replace('medrec-views/v2', 'medrec-views/v1'));
    const { r } = await ask(root, 'medrec_summary', { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/older layout \(medrec-views\/v1\) than this connector reads/);
    expect(r.content[0]!.text).toMatch(/medrec 0\.8\.0 or later prepares them in the current one/);
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

  it('reads one pass only, in whichever order the next one arrives', async () => {
    const sam = personId(large, 'Sam Example');
    // The next pass: one new result for Sam.
    const next = copy(large, 'large-next');
    const at = join(next, 'Sam Example/index.json');
    const index = JSON.parse(readFileSync(at, 'utf8'));
    index.records.push({ id: 'rec_next_pass_result', kind: 'result', date: '2026-12-01', display: 'Zinc', code: null, status: 'final', fields: { value: 'Quixotic' } });
    writeFileSync(at, JSON.stringify(index));
    writeViewsAt(next);
    // medrec's pass writes its own views beside them.
    addDerived(next, 'large');
    const newViews = readdirSync(join(next, 'views', sam));

    // Its views first: new names beside the old ones, which the old views.json still reads.
    const early = copy(large, 'large-next-early');
    for (const f of newViews) cpSync(join(next, 'views', sam, f), join(early, 'views', sam, f));
    const before = await ask(early, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 });
    expect(before.r).toEqual(await raw(large, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 }));

    // Its index.json and views.json first: the views they name are not there yet.
    const late = copy(large, 'large-next-late');
    cpSync(at, join(late, 'Sam Example/index.json'));
    cpSync(join(next, VIEWS_INDEX), join(late, VIEWS_INDEX));
    const { r } = await ask(late, 'medrec_records', { kind: 'results', person: 'Sam', limit: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Sam Example's records are being prepared for assistants right now/);
    // Robin's views did not change, so their names did not either.
    const robin = await ask(late, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 });
    expect(robin.r).toEqual(await raw(late, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 }));
  });

  it('refuses a view whose content is not the MD5 views.json gives it', async () => {
    const root = copy(large, 'large-foreign');
    const sam = personId(root, 'Sam Example');
    const file = stored(root, paths.tests(sam));
    writeFileSync(file, '[]');
    const { r } = await ask(root, 'medrec_records', { kind: 'tests', person: 'Sam' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/being prepared for assistants right now/);
  });

  it('says the records are being prepared when a view is missing', async () => {
    const root = copy(large, 'large-missing');
    rmSync(stored(root, paths.summary(personId(root, 'Sam Example'))));
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
      expect(requests).toBeLessThanOrEqual(SUBREQUESTS - 6);
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
  it('changes only the newest shards, the last hay pack and the search shards of its words', () => {
    const root = copy(large, 'large-append');
    const robin = personId(root, 'Robin Example');
    const files = () => (JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex).people[robin]!.files;
    const before = files();
    const at = join(root, 'Robin Example/index.json');
    const index = JSON.parse(readFileSync(at, 'utf8'));
    index.records.push({ id: 'rec_appended_test_result', kind: 'result', date: '2026-12-01', display: 'Zinc', code: null, status: 'final', fields: { value: 'Quixotic' } });
    writeFileSync(at, JSON.stringify(index));
    writeViewsAt(root);
    const after = files();
    const changed = Object.keys(after).filter((f) => before[f] !== after[f]);
    const words = fold('Zinc\nQuixotic').split(' ');
    const allowed = new Set(words.flatMap((w) => [`search-${hex(prefixOf(w))}.json`, `search-1-${hex(prefixOf(w, 1))}.json`]));
    const numbered = (prefix: string) => Object.keys(after).filter((f) => f.startsWith(prefix) && /-\d+\.(json|bin)$/.test(f)).map((f) => Number(/-(\d+)\.(json|bin)$/.exec(f)![1]));
    const newest = (prefix: string) => Math.max(...numbered(prefix));
    const n = (f: string) => Number(/-(\d+)\.(json|bin)$/.exec(f)![1]);
    for (const f of changed) {
      if (f.startsWith('search-hay-')) expect(n(f), f).toBe(newest('search-hay-'));
      else if (f.startsWith('search-labs-')) expect(n(f), f).toBe(newest('search-labs-'));
      else if (f.startsWith('search-') && f.endsWith('.json')) expect(allowed.has(f), f).toBe(true);
      else if (f.startsWith('records-result-')) expect(n(f), f).toBeGreaterThanOrEqual(newest('records-result-') - 1);
      else if (f.startsWith('timeline-')) expect(n(f), f).toBeGreaterThanOrEqual(newest('timeline-') - 1);
      else expect(['summary.json', 'names-result.json', 'tests.json', 'search-items.bin', 'documents.json'], f).toContain(f);
    }
    // Of hundreds of views, a few dozen at most, and each is stored under a new name.
    expect(changed.length).toBeLessThan(20);
    expect(Object.keys(after).length).toBeGreaterThan(200);
    const dir = readdirSync(join(root, personDir(robin)));
    for (const f of Object.keys(after)) expect(dir).toContain(storedName(f, after[f]!));
    expect(dir).toHaveLength(Object.keys(after).length);
  });
});

describe('events from the views (medrec 0.9.0)', () => {
  let base = '';
  beforeAll(() => {
    base = copy(demo, 'demo-events');
    addDerived(base, 'records');
  });
  const events = (root: string, args: Record<string, unknown> = {}) => ask(root, 'medrec_records', { kind: 'events', ...args });
  const items = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as { items: { person: string; id: string }[] }).items;

  it('reads a person\'s events from events.json alone while what they were made from is unchanged', async () => {
    const { r, read } = await events(base, { person: 'Robin' });
    expect(r.isError).toBe(false);
    const robin = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/events/records', `${personId(base, 'Robin Example')}.json`), 'utf8')) as { events: unknown[] };
    expect(items(r)).toHaveLength(robin.events.length);
    expect(whole(read)).toEqual([]);
    expect(read.filter((f) => f.includes('/events.'))).toHaveLength(1);
  });

  it('makes only the events, payments and private items stale when overrides.json changes', async () => {
    const root = copy(base, 'events-overrides');
    writeFileSync(join(root, 'Robin Example/overrides.json'), JSON.stringify({ schema: 'medrec-overrides/v1', events: [] }));
    const { r } = await events(root, { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Robin Example's records changed after medrec last prepared their events for assistants/);
    // The records themselves are as they were; only whether any is private is not known until medrec's next pass.
    type Page = { items: unknown[]; warnings?: { code: string; message: string }[] };
    const results = (await ask(root, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 })).r;
    const before = (await ask(base, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 })).r;
    expect(results.isError).toBe(false);
    expect((results.structuredContent as Page).items).toEqual((before.structuredContent as Page).items);
    expect((results.structuredContent as Page).warnings).toEqual([
      { code: 'private-not-prepared', message: expect.stringMatching(/^medrec has not marked Robin Example's private items for assistants \(their records changed after medrec last wrote their private\.json\)/) },
    ]);
  });

  it("makes a guardian's events stale when a linked newborn's text changes, and leaves the others", async () => {
    const root = copy(base, 'events-linked');
    appendFileSync(join(root, 'Jamie Example/text.json'), ' ');
    for (const who of ['Robin', 'Sam', 'Jamie']) {
      const { r } = await events(root, { person: who });
      expect(r.isError, who).toBe(true);
    }
    // Alex is linked to Robin and Sam only, whose files did not change.
    expect((await events(root, { person: 'Alex' })).r.isError).toBe(false);
    // Robin's other views do not depend on Jamie.
    expect((await ask(root, 'medrec_records', { kind: 'results', person: 'Robin', limit: 5 })).r.isError).toBe(false);
  });

  it('answers a question about everyone without the people whose events are stale, and says who', async () => {
    const root = copy(base, 'events-everyone');
    appendFileSync(join(root, 'Jamie Example/text.json'), ' ');
    const { r } = await events(root, { limit: 200 });
    expect(r.isError).toBe(false);
    expect(new Set(items(r).map((x) => x.person))).toEqual(new Set(['Alex Example']));
    const warnings = (r.structuredContent as { warnings: { code: string; message: string }[] }).warnings;
    const unavailable = warnings.filter((w) => w.code === 'person-unavailable');
    expect(unavailable.map((w) => w.message.split("'")[0])).toEqual(['Robin Example', 'Sam Example', 'Jamie Example']);
  });

  it('refuses events listed without what they were made from', async () => {
    for (const key of ['linked', 'overrides'] as const) {
      const root = copy(base, `events-no-${key}`);
      const at = join(root, VIEWS_INDEX);
      const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
      delete index.people[personId(root, 'Robin Example')]![key];
      writeFileSync(at, JSON.stringify(index));
      const { r } = await events(root, { person: 'Robin' });
      expect(r.isError, key).toBe(true);
      expect(r.content[0]!.text, key).toMatch(/medrec has not prepared Robin Example's events for assistants/);
    }
  });

  it('says medrec 0.9.0 prepares events for views without them', async () => {
    const bare = join(scratch, 'demo-bare');
    cpSync(DEMO, bare, { recursive: true });
    writeViewsAt(bare);
    const { r } = await events(bare, { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/medrec has not prepared Robin Example's events for assistants.*medrec 0\.9\.0 or later prepares them/);
    // Asked about everyone, with no one's events: the first person's error.
    expect((await events(bare)).r.content[0]!.text).toMatch(/^upstream: medrec has not prepared Robin Example's events/);
  });

  it('refuses an events.json whose content is not the MD5 views.json gives it', async () => {
    const root = copy(base, 'events-foreign');
    writeFileSync(stored(root, paths.events(personId(root, 'Robin Example'))), '{"schema":"medrec-events/v1","events":[]}');
    const { r } = await events(root, { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/being prepared for assistants right now/);
  });

  it('says the connector needs updating for a later events layout', async () => {
    const root = copy(base, 'events-newer');
    const pid = personId(root, 'Robin Example');
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    rmSync(stored(root, paths.events(pid)));
    const body = JSON.stringify({ schema: 'medrec-events/v2', events: [] });
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(pid) + storedName('events.json', sum)), body);
    index.people[pid]!.files['events.json'] = sum;
    writeFileSync(at, JSON.stringify(index));
    const { r } = await events(root, { person: 'Robin' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/events in a layout \(medrec-events\/v2\) this connector does not read/);
  });
});

describe('the practice a record came from (medrec 0.9.3)', () => {
  const BASE = 'https://api.example.net/fhir/r4';
  const FAMILY = 'example-family-medicine';

  it('is its own sign-in\'s, else the organization at its FHIR base, else its CLI', () => {
    const h = {
      schema: '',
      format: 1,
      people: [],
      organizations: [{ id: 'g_1', name: 'Example Base', fhir_base: `${BASE}/` }],
      sources: [
        { cli: 'athena', organization: 'a', organization_name: '  ', fhir_base: BASE },
        { cli: 'athena', organization: 'a', organization_name: ' Example A ', fhir_base: `${BASE}//` },
        { cli: 'athena', organization: 'b', organization_name: 'Example B', fhir_base: BASE },
        { cli: 'uhc', organization: 'plan', organization_name: 'Example Plan', fhir_base: BASE },
        { cli: 'labcorp', organization: 'lab' },
      ],
    } satisfies Household;
    const from = (source: Record<string, string | null>) => recordSource(h, { id: 'r_1', kind: 'result', display: 'x', provenance: [{ source }] });
    expect(from({ cli: 'athena', organization_id: 'a', fhir_base: BASE })).toBe('Example A');
    expect(from({ cli: 'athena', organization_id: 'b', fhir_base: `${BASE}/` })).toBe('Example B');
    // No such sign-in, or not at that base: the organization at the base.
    expect(from({ cli: 'athena', organization_id: 'c', fhir_base: BASE })).toBe('Example Base');
    expect(from({ cli: 'athena', organization_id: null, fhir_base: BASE })).toBe('Example Base');
    expect(from({ cli: 'athena', organization_id: 'a', fhir_base: 'https://other.example.net' })).toBe('athena');
    // With no base, the CLI and organization say it; a sign-in with no name says nothing.
    expect(from({ cli: 'uhc', organization_id: 'plan' })).toBe('Example Plan');
    expect(from({ cli: 'labcorp', organization_id: 'lab' })).toBe('labcorp');
    expect(recordSource(h, { id: 'r_1', kind: 'result', display: 'x' })).toBeUndefined();
  });

  /** A copy of the demo whose Alex has a second practice at the same FHIR base, with every other record from it. */
  function twoPractices(name: string): string {
    const root = copy(demo, name);
    const at = join(root, 'household.json');
    const h = JSON.parse(readFileSync(at, 'utf8')) as { people: { id: string; name: string }[]; sources: Record<string, unknown>[] };
    const alex = personId(root, 'Alex Example');
    const first = h.sources.find((s) => s.person === alex && s.cli === 'athena')!;
    h.sources.push({ ...first, id: 's_qqqqqqqqqqqqqqqqqqqq', organization: FAMILY, organization_name: 'Example Family Medicine' });
    writeFileSync(at, JSON.stringify(h));
    const path = join(root, 'Alex Example/index.json');
    const index = JSON.parse(readFileSync(path, 'utf8')) as { records: { provenance: { source: { organization_id?: string } }[] }[] };
    index.records.forEach((r, i) => {
      if (i % 2 === 1) r.provenance[0]!.source.organization_id = FAMILY;
    });
    writeFileSync(path, JSON.stringify(index));
    writeViewsAt(root);
    addDerived(root, 'records');
    return root;
  }

  /** Takes `organization_id` out of every record of the views, as medrec 0.9.3 and earlier write them. */
  function withoutOrganizations(root: string): void {
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    let n = 0;
    for (const [pid, v] of Object.entries(index.people)) {
      for (const [view, sum] of Object.entries(v.files)) {
        if (!view.startsWith('records-')) continue;
        const recs = JSON.parse(readFileSync(join(root, personDir(pid) + storedName(view, sum)), 'utf8')) as { provenance?: { source: Record<string, unknown> }[] }[];
        for (const r of recs) {
          for (const p of r.provenance ?? []) {
            if ('organization_id' in p.source) n++;
            delete p.source.organization_id;
          }
        }
        const text = JSON.stringify(recs);
        const next = createHash('md5').update(text).digest('hex');
        writeFileSync(join(root, personDir(pid) + storedName(view, next)), text);
        v.files[view] = next;
      }
    }
    expect(n).toBeGreaterThan(0);
    writeFileSync(at, JSON.stringify(index));
  }

  type Page = { items: { id: string; source?: string }[] };
  const sources = async (root: string, args: Record<string, unknown>) => ((await ask(root, 'medrec_records', { limit: 200, ...args })).r.structuredContent as Page).items.map((x) => [x.id, x.source] as const);
  const KINDS = ['results', 'tests', 'visits', 'immunizations'];

  it('tells two practices on one FHIR base apart, from the views as from the files', async () => {
    const root = twoPractices('two-practices');
    const seen = new Set<string | undefined>();
    for (const kind of KINDS) {
      const args = { kind, person: 'Alex', limit: 200 };
      const views = (await ask(root, 'medrec_records', args)).r.structuredContent;
      expect((await raw(root, 'medrec_records', args)).structuredContent, kind).toEqual(views);
      for (const [, s] of await sources(root, args)) seen.add(s);
    }
    expect([...seen].sort()).toEqual(['Example Family Medicine', 'Example Pediatrics']);
  });

  it('of views that leave the organization out, names a person\'s only practice on a base, and of two, only the CLI', async () => {
    const root = twoPractices('two-practices-before');
    const full = Object.fromEntries(await Promise.all(KINDS.map(async (kind) => [kind, await sources(root, { kind, person: 'Jamie' })] as const)));
    withoutOrganizations(root);
    for (const kind of KINDS) {
      const alex = await sources(root, { kind, person: 'Alex' });
      expect(alex.map(([, s]) => s), kind).toEqual(alex.map(() => 'athena'));
      // Jamie has one sign-in at that base, and one with a plan that has none.
      expect(await sources(root, { kind, person: 'Jamie' }), kind).toEqual(full[kind]);
    }
    expect(Object.values(full).flat().some(([, s]) => s === 'Example Pediatrics')).toBe(true);
  });

  it('leaves the timeline and the summary the organization their writer gave, with or without it in the records', async () => {
    const root = twoPractices('two-practices-labels');
    const timeline = { kind: 'timeline', person: 'Alex', limit: 200 };
    const before = [await sources(root, timeline), (await ask(root, 'medrec_summary', { person: 'Alex' })).r.structuredContent] as const;
    withoutOrganizations(root);
    expect(await sources(root, timeline)).toEqual(before[0]);
    expect((await ask(root, 'medrec_summary', { person: 'Alex' })).r.structuredContent).toEqual(before[1]);
    const records = before[0].filter(([id]) => id.startsWith('r_')).map(([, s]) => s);
    expect([...new Set(records)].sort()).toEqual(['Example Care Plan', 'Example Family Medicine', 'Example Pediatrics']);
  });
});

describe('private items and payments from the views (medrec 0.9.1)', () => {
  type Page = { items: { id: string; person: string; title: string; detail?: string; private?: string }[]; next_cursor?: string; warnings?: { code: string; message: string }[] };
  const page = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as Page;
  const left = (p: Page) => Number(/^(\d+) private items? left out/.exec(p.warnings?.find((w) => w.code === 'private-left-out')?.message ?? '0')?.[1] ?? 0);

  /** Replaces one of medrec's own views of a person, as its next pass would write it; undefined removes it. */
  function setView(root: string, name: string, view: string, body: Record<string, unknown> | undefined): void {
    const pid = personId(root, name);
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    const v = index.people[pid]!;
    if (body === undefined) delete v.files[view];
    else {
      const text = JSON.stringify(body);
      const sum = createHash('md5').update(text).digest('hex');
      writeFileSync(join(root, personDir(pid) + storedName(view, sum)), text);
      v.files[view] = sum;
    }
    writeFileSync(at, JSON.stringify(index));
  }
  const privateOf = (root: string, name: string, kinds: Partial<Record<'records' | 'documents' | 'events' | 'studies', Record<string, string>>>, extra: Record<string, unknown> = {}) =>
    setView(root, name, 'private.json', {
      schema: 'medrec-private/v1',
      person: personId(root, name),
      ...Object.fromEntries((['records', 'documents', 'events', 'studies'] as const).map((k) => [k, Object.fromEntries(Object.entries(kinds[k] ?? {}).map(([id, area]) => [id, { area, from: 'household' }]))])),
      ...extra,
    });

  /** A copy of the demo with no private items of its own. */
  function plain(name: string): string {
    const root = copy(demo, name);
    const people = (JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { name: string }[] }).people;
    for (const x of people) privateOf(root, x.name, {});
    return root;
  }

  const CETIRIZINE = 'r_ctwssd77qny2ietw76dy';

  it('names an item only by a word of its own', () => {
    expect(names('Escitalopram 10 mg tablet', 'escitalopram')).toBe(true);
    expect(names('Sertraline 50 mg tablet', 'sert')).toBe(true);
    expect(names('Sertraline 50 mg tablet', 'Sertraline tablets')).toBe(false);
    expect(names('Escitalopram 10 mg tablet', 'escitalopram tablet')).toBe(true);
    expect(names('Sertraline 50 mg tablet', 'tablet')).toBe(false);
    expect(names('Sertraline 50 mg tablet', 'se')).toBe(false);
    expect(names('Sertraline 50 mg tablet', '50 mg')).toBe(false);
    expect(names('Sertraline 50 mg tablet', 'zoloft')).toBe(false);
    expect(names('Seréna visit', 'serena')).toBe(true);
  });

  it('leaves a private record out of an answer about everyone, counts it, and marks it where it is included', async () => {
    const root = plain('private-record');
    privateOf(root, 'Robin Example', { records: { [CETIRIZINE]: 'mental_health' } });
    const everyone = page((await ask(root, 'medrec_records', { kind: 'medications' })).r);
    expect(everyone.items.some((x) => x.id === CETIRIZINE)).toBe(false);
    expect(everyone.warnings).toEqual([{ code: 'private-left-out', message: '1 private item left out of this page of a household-wide answer: ask about one person, or name the item, to include it' }]);
    const robin = page((await ask(root, 'medrec_records', { kind: 'medications', person: 'Robin' })).r);
    expect(robin.items.find((x) => x.id === CETIRIZINE)?.private).toBe('mental_health');
    expect(robin.warnings).toBeUndefined();
    // Named by a word of its own, it is in an answer about everyone; by a form, it is not.
    const named = page((await ask(root, 'medrec_records', { kind: 'medications', name: 'cetirizine' })).r);
    expect(named.items.map((x) => [x.id, x.private])).toEqual([[CETIRIZINE, 'mental_health']]);
    const tablets = page((await ask(root, 'medrec_records', { kind: 'medications', name: 'tablet' })).r);
    expect(tablets.items.some((x) => x.id === CETIRIZINE)).toBe(false);
    expect(left(tablets)).toBe(1);
    // Search holds it back where it ranks, the same way.
    const hits = page((await ask(root, 'medrec_search', { query: 'cetirizine' })).r);
    expect(hits.items.find((x) => x.id === CETIRIZINE)?.private).toBe('mental_health');
    const tabletHits = page((await ask(root, 'medrec_search', { query: 'tablet', limit: 50 })).r);
    expect(tabletHits.items.some((x) => x.id === CETIRIZINE)).toBe(false);
    expect(left(tabletHits)).toBeGreaterThanOrEqual(1);
  });

  it("counts each page's left-out items so that the pages add up to one page's count", async () => {
    const root = plain('private-pages');
    const pages = async (limit: number) => {
      const items: Page['items'] = [];
      let total = 0;
      let cursor: string | undefined;
      do {
        const p = page((await ask(root, 'medrec_records', { kind: 'timeline', limit, ...(cursor ? { cursor } : {}) })).r);
        total += left(p);
        items.push(...p.items);
        cursor = p.next_cursor;
      } while (cursor);
      return { items, total };
    };
    const all = await pages(200);
    const robin = all.items.filter((x) => x.person === 'Robin Example' && /^[rd]_/.test(x.id));
    const chosen = [robin[1]!, robin[4]!, robin[5]!, robin[robin.length - 1]!];
    privateOf(root, 'Robin Example', {
      records: Object.fromEntries(chosen.filter((x) => x.id.startsWith('r_')).map((x) => [x.id, 'reproductive'])),
      documents: Object.fromEntries(chosen.filter((x) => x.id.startsWith('d_')).map((x) => [x.id, 'household'])),
    });
    const open = all.items.filter((x) => !chosen.some((c) => c.id === x.id));
    for (const limit of [200, 2]) expect(await pages(limit), `${limit} a page`).toEqual({ items: open, total: chosen.length });
  });

  it("holds back all of a person's records, documents and events when their marks.json does not read", async () => {
    const root = plain('private-unreadable');
    privateOf(root, 'Sam Example', {}, { marks_unreadable: true });
    const everyone = page((await ask(root, 'medrec_records', { kind: 'medications' })).r);
    expect(everyone.items.some((x) => x.person === 'Sam Example')).toBe(false);
    expect(left(everyone)).toBe(6);
    expect(everyone.warnings?.map((w) => w.code)).toEqual(['private-left-out', 'private-marks-unreadable']);
    expect(everyone.warnings?.[1]?.message).toMatch(/^Sam Example's marks\.json does not read/);
    // About Sam alone, nothing is left out, and nothing is marked.
    const sam = page((await ask(root, 'medrec_records', { kind: 'medications', person: 'Sam' })).r);
    expect(sam.items).toHaveLength(6);
    expect(sam.items.every((x) => x.private === undefined)).toBe(true);
    expect(sam.warnings?.map((w) => w.code)).toEqual(['private-marks-unreadable']);
  });

  it('marks private lines in a summary, a private document read by id, and a private event', async () => {
    const root = copy(demo, 'private-marks');
    type Summary = { summary: { sections: { section: string; items: { id?: string; private?: string }[] }[] } };
    const before = (await ask(root, 'medrec_summary', { person: 'Robin' })).r.structuredContent as Summary;
    const line = before.summary.sections.find((x) => x.section === 'medications')!.items[0]!;
    const doc = 'd_pv57tjsi5ot4237rjcdf';
    const events = page((await ask(root, 'medrec_records', { kind: 'events', person: 'Robin' })).r);
    const event = events.items[0]!.id;
    privateOf(root, 'Robin Example', {});
    const others = left(page((await ask(root, 'medrec_records', { kind: 'events' })).r));
    privateOf(root, 'Robin Example', { records: { [line.id!]: 'mental_health' }, documents: { [doc]: 'household' }, events: { [event]: 'sexual_health' } });
    const after = (await ask(root, 'medrec_summary', { person: 'Robin' })).r.structuredContent as Summary;
    expect(after.summary.sections.find((x) => x.section === 'medications')!.items[0]).toEqual({ ...line, private: 'mental_health' });
    expect(((await ask(root, 'medrec_document', { id: doc })).r.structuredContent as { private?: string }).private).toBe('household');
    const everyone = page((await ask(root, 'medrec_records', { kind: 'events' })).r);
    expect(everyone.items.some((x) => x.id === event)).toBe(false);
    expect(left(everyone)).toBe(others + 1);
    const byId = page((await ask(root, 'medrec_records', { kind: 'events', id: event })).r);
    expect(byId.items.map((x) => [x.id, x.private])).toEqual([[event, 'sexual_health']]);
  });

  it('binds a cursor to the people with no current private.json, and as medrec does, not to those whose marks.json does not read', async () => {
    const root = copy(demo, 'private-cursors');
    const cursor = async () => Buffer.from(page((await ask(root, 'medrec_records', { kind: 'timeline', limit: 2 })).r).next_cursor!, 'hex').toString();
    const known = await cursor();
    privateOf(root, 'Alex Example', {}, { marks_unreadable: true });
    expect(await cursor()).toBe(known);
    setView(root, 'Alex Example', 'private.json', undefined);
    const bound = await cursor();
    expect(bound.startsWith(`${known}:L`)).toBe(true);
    // A cursor from before does not line up once Alex's items are known or not: it is refused.
    const old = Buffer.from(known).toString('hex');
    expect((await ask(root, 'medrec_records', { kind: 'timeline', limit: 2, cursor: old })).r.isError).toBe(true);
  });

  it('ignores what a later medrec adds to the views: a file, a field on a summary line and one in views.json', async () => {
    const root = copy(demo, 'later-medrec');
    const { people } = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; name: string }[] };
    let changed = 0;
    for (const p of people) {
      const summary = JSON.parse(readFileSync(stored(root, paths.summary(p.id)), 'utf8')) as { conditions: { items: Record<string, unknown>[] } };
      for (const line of summary.conditions.items) {
        line.later_field = 'a later field';
        changed++;
      }
      setView(root, p.name, 'summary.json', summary as unknown as Record<string, unknown>);
      setView(root, p.name, 'later-view.json', { schema: 'medrec-later-view/v1', person: p.id, items: { 'a later view': true } });
    }
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    for (const v of Object.values(index.people)) Object.assign(v, { later_note: 'a later note', code_table: 'icd10cm FY2027' });
    writeFileSync(at, JSON.stringify(index));
    expect(changed).toBeGreaterThan(0);
    const { calls } = JSON.parse(readFileSync(join(import.meta.dirname, 'golden/calls.json'), 'utf8')) as { calls: Record<string, unknown>[] };
    const made = calls.filter((c) => c.folder === 'demo' && c.arguments !== undefined && c.cursor_from === undefined && c.id_from === undefined);
    expect(made.length).toBeGreaterThan(100);
    // The changed summaries are the ones read.
    for (const p of people) {
      const { read } = await ask(root, 'medrec_summary', { person: p.name });
      expect(read).toContain(relative(root, stored(root, paths.summary(p.id))));
    }
    for (const c of made) {
      const [was, now] = await Promise.all([demo, root].map((folder) => ask(folder, c.name as string, c.arguments as Record<string, unknown>)));
      expect(now!.r, JSON.stringify(c)).toEqual(was!.r);
      expect(JSON.stringify(now!.r)).not.toMatch(/later_field|later_note|a later (?:field|view|note)|code_table/);
      expect(now!.read.some((f) => f.includes('later-view'))).toBe(false);
    }
  });

  describe('imaging studies and linked documents (medrec 0.9.5)', () => {
    const study = 'm_5jqhmt3omkqdefbiui5y';
    const days = { since: '2026-05-15', until: '2026-05-25' };
    type Row = { id: string; kind: string; private?: string };
    const items = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as { items: Row[] }).items;
    const codes = (r: { structuredContent?: Record<string, unknown> }) => ((r.structuredContent as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code);
    const has = (r: { structuredContent?: Record<string, unknown> }, id: string) => items(r).some((i) => i.id === id);

    it('holds back a study no report judges from an answer about everyone, and counts it', async () => {
      const { r } = await ask(demo, 'medrec_records', { kind: 'timeline', ...days });
      expect(has(r, study)).toBe(false);
      expect(left(page(r))).toBe(1);
      const own = (await ask(demo, 'medrec_records', { kind: 'timeline', person: 'Sam', ...days })).r;
      expect(items(own).find((i) => i.id === study)!.private).toBeUndefined();
      expect(has((await ask(demo, 'medrec_search', { query: 'XR ankle' })).r, study)).toBe(true);
    });

    it('marks a study its report makes private, and holds it back, unless the question names it', async () => {
      const root = copy(demo, 'study-reported');
      privateOf(root, 'Sam Example', { studies: { [study]: 'sexual_health' } });
      const everyone = (await ask(root, 'medrec_records', { kind: 'timeline', ...days })).r;
      expect(has(everyone, study)).toBe(false);
      expect(left(page(everyone))).toBe(1);
      expect(items((await ask(root, 'medrec_records', { kind: 'timeline', person: 'Sam', ...days })).r).find((i) => i.id === study)!.private).toBe('sexual_health');
      const named = (await ask(root, 'medrec_records', { kind: 'timeline', ...days, name: 'ankle' })).r;
      expect(items(named).find((i) => i.id === study)!.private).toBe('sexual_health');
      expect(has((await ask(root, 'medrec_search', { query: 'imaging' })).r, study)).toBe(false);
    });

    it('shows a study its report does not make private', async () => {
      const root = copy(demo, 'study-open');
      privateOf(root, 'Sam Example', {});
      const { r } = await ask(root, 'medrec_records', { kind: 'timeline', ...days });
      expect(items(r).find((i) => i.id === study)).toBeDefined();
      expect(items(r).find((i) => i.id === study)!.private).toBeUndefined();
      expect(left(page(r))).toBe(0);
    });

    it('holds back every study of a person whose marks do not read', async () => {
      const root = copy(demo, 'study-marks');
      privateOf(root, 'Sam Example', {}, { marks_unreadable: true });
      const { r } = await ask(root, 'medrec_records', { kind: 'timeline', ...days });
      expect(items(r)).toEqual([]);
      expect(codes(r)).toContain('private-marks-unreadable');
    });

    it('counts a private.json from before medrec 0.9.5, or one with a list it cannot read, as not prepared', async () => {
      for (const [name, change] of [
        ['older', { studies: undefined }],
        ['odd', { unreported_studies: 'm_x' }],
        ['mixed', { unreported_studies: [study, 5] }],
      ] as [string, Record<string, unknown>][]) {
        const root = copy(demo, `study-${name}`);
        setView(root, 'Sam Example', 'private.json', {
          schema: 'medrec-private/v1',
          person: personId(root, 'Sam Example'),
          records: {},
          documents: {},
          events: {},
          studies: {},
          ...change,
        });
        const everyone = (await ask(root, 'medrec_records', { kind: 'timeline', ...days })).r;
        expect(items(everyone), name).toEqual([]);
        expect(codes(everyone), name).toContain('private-not-prepared');
        const message = (everyone.structuredContent as { warnings: { code: string; message: string }[] }).warnings.find((w) => w.code === 'private-not-prepared')!.message;
        expect(message).toMatch(/Sam Example/);
        expect(message).toMatch(/medrec 0\.9\.5 or later/);
        const own = (await ask(root, 'medrec_records', { kind: 'timeline', person: 'Sam', ...days })).r;
        expect(has(own, study), name).toBe(true);
        expect(codes(own), name).toEqual(['private-not-prepared']);
        // A document only a private record links could not be told: held back with the rest.
        expect(items((await ask(root, 'medrec_records', { kind: 'documents' })).r).some((i) => (i as { person?: string }).person === 'Sam Example'), name).toBe(false);
        const bound = Buffer.from(page((await ask(root, 'medrec_records', { kind: 'timeline', limit: 2 })).r).next_cursor!, 'hex').toString();
        expect(bound, name).toContain(':L');
      }
    });

    it('says the marks do not read, whichever medrec wrote the private.json', async () => {
      const root = copy(demo, 'study-older-unreadable');
      privateOf(root, 'Sam Example', {}, { marks_unreadable: true, studies: undefined });
      const { r } = await ask(root, 'medrec_records', { kind: 'timeline', ...days });
      expect(items(r)).toEqual([]);
      const sam = (r.structuredContent as { warnings: { code: string; message: string }[] }).warnings.filter((w) => w.message.startsWith('Sam Example') || /Sam Example's private/.test(w.message));
      expect(sam.map((w) => w.code)).toEqual(['private-marks-unreadable']);
    });

    it('marks what a private.json from before medrec 0.9.5 does say, in an answer about the person', async () => {
      const root = copy(demo, 'study-older-marks');
      const robin = JSON.parse(readFileSync(stored(root, `views/${personId(root, 'Robin Example')}/private.json`), 'utf8')) as Record<string, unknown>;
      setView(root, 'Robin Example', 'private.json', { ...robin, studies: undefined });
      const r = (await ask(root, 'medrec_records', { kind: 'conditions', person: 'Robin' })).r;
      expect(items(r).find((i) => i.id === 'r_anxietydisorderaaaaa')!.private).toBe('mental_health');
    });

    it('reads no private.json for a person whose medrec wrote an empty one', async () => {
      const { read } = await ask(demo, 'medrec_records', { kind: 'timeline', person: 'Jamie' });
      expect(read.some((f) => f.includes('private'))).toBe(false);
    });
  });

  describe('plain names of conditions, from code-names.json (medrec 0.9.4)', () => {
    type Row = { id: string; title: string; plain_name?: string; private?: string; person: string };
    const rows = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as { items: Row[] }).items;
    const summaryRows = (r: { structuredContent?: Record<string, unknown> }) =>
      (r.structuredContent as { summary: { sections: { section: string; items: (Omit<Row, 'title'> & { name: string })[] }[] } }).summary.sections.find((x) => x.section === 'conditions')!.items;
    const pick = (xs: Row[], id: string) => xs.find((x) => x.id === id)!;
    const pressure = 'r_d5j2pc6xngtnzlxzykci';
    const anxiety = 'r_anxietydisorderaaaaa';
    const codeNames = (root: string) => join(root, personDir(personId(root, 'Robin Example')) + storedName('code-names.json', (JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex).people[personId(root, 'Robin Example')]!.files['code-names.json']!));

    it('labels a person\'s conditions, private ones included, beside the source\'s own words', async () => {
      const r = rows((await ask(demo, 'medrec_records', { kind: 'conditions', person: 'Robin' })).r);
      expect(pick(r, pressure)).toMatchObject({ title: 'High blood pressure', plain_name: 'Sample pressure' });
      expect(pick(r, anxiety)).toMatchObject({ title: 'Social anxiety disorder', plain_name: 'Sample worry', private: 'mental_health' });
      const s = summaryRows((await ask(demo, 'medrec_summary', { person: 'Robin' })).r);
      expect(s.find((x) => x.id === pressure)).toMatchObject({ name: 'High blood pressure', plain_name: 'Sample pressure' });
      expect(s.find((x) => x.id === anxiety)).toMatchObject({ plain_name: 'Sample worry' });
    });

    it('gives a household-wide answer no name for a private item, even one the question names or whose code an open item shares', async () => {
      const root = copy(demo, 'plain-private');
      setView(root, 'Robin Example', 'code-names.json', {
        schema: 'medrec-code-names/v1',
        person: personId(root, 'Robin Example'),
        table: { id: 'icd10cm', version: 'invented', date: '2000-01-01' },
        codes: { 'icd10cm|I10': { name: 'Sample pressure' }, 'icd10cm|F40.10': { name: 'Sample shared worry' } },
        private_codes: {},
      });
      const r = rows((await ask(root, 'medrec_records', { kind: 'conditions' })).r);
      expect(pick(r, pressure)).toMatchObject({ plain_name: 'Sample pressure' });
      expect(pick(r, anxiety)).toBeUndefined();
      const asked = rows((await ask(root, 'medrec_records', { kind: 'conditions', name: 'social anxiety' })).r);
      expect(pick(asked, anxiety)).toMatchObject({ private: 'mental_health' });
      expect(pick(asked, anxiety).plain_name).toBeUndefined();
      const own = rows((await ask(root, 'medrec_records', { kind: 'conditions', person: 'Robin' })).r);
      expect(pick(own, anxiety).plain_name).toBe('Sample shared worry');
    });

    it('gives none where the person\'s private items are not known, in an answer about everyone', async () => {
      const root = copy(demo, 'plain-unknown');
      setView(root, 'Robin Example', 'private.json', undefined);
      const asked = rows((await ask(root, 'medrec_records', { kind: 'conditions', name: 'high blood pressure' })).r);
      expect(pick(asked, pressure)).toMatchObject({ title: 'High blood pressure' });
      expect(pick(asked, pressure).plain_name).toBeUndefined();
      expect(pick(rows((await ask(root, 'medrec_records', { kind: 'conditions', person: 'Robin' })).r), pressure).plain_name).toBe('Sample pressure');
    });

    it('never finds, orders or pages by a plain name', async () => {
      for (const args of [{ kind: 'conditions', name: 'Sample pressure' }, { kind: 'conditions', person: 'Robin', name: 'Sample worry' }, { kind: 'conditions', person: 'Casey', name: 'Sample pressure' }]) {
        expect(rows((await ask(demo, 'medrec_records', args)).r), JSON.stringify(args)).toEqual([]);
      }
      const none = copy(demo, 'plain-none');
      for (const name of ['Robin Example', 'Sam Example', 'Alex Example', 'Casey Example']) setView(none, name, 'code-names.json', undefined);
      for (const args of [{ kind: 'conditions', limit: 1 }, { kind: 'conditions', person: 'Robin' }, { kind: 'conditions', response_format: 'detailed' }]) {
        const [w, o] = [await ask(demo, 'medrec_records', args), await ask(none, 'medrec_records', args)];
        const bare = (r: { structuredContent?: Record<string, unknown> }) => rows(r).map(({ plain_name: _, ...x }) => x);
        expect(bare(w.r)).toEqual(rows(o.r));
        expect(page(w.r).next_cursor).toBe(page(o.r).next_cursor);
        expect(rows(o.r).some((x) => x.plain_name !== undefined)).toBe(false);
        expect(page(o.r).warnings ?? []).toEqual(page(w.r).warnings ?? []);
      }
    });

    it('reads code-names.json only for the people with a condition on the page', async () => {
      const { read } = await ask(demo, 'medrec_records', { kind: 'conditions', limit: 1 });
      expect(read.filter((f) => f.includes('code-names'))).toHaveLength(1);
      for (const args of [{ kind: 'medications' }, { kind: 'conditions', person: 'Jamie' }, { kind: 'timeline', person: 'Robin' }]) {
        expect((await ask(demo, 'medrec_records', args)).read.some((f) => f.includes('code-names')), JSON.stringify(args)).toBe(false);
      }
      expect((await ask(demo, 'medrec_search', { query: 'pressure' })).read.some((f) => f.includes('code-names'))).toBe(false);
    });

    it('keeps the source\'s words, with no warning, where names are stale, unreadable, another person\'s or in another layout', async () => {
      const bad: [string, (root: string) => void][] = [
        ['other-person', (root) => setView(root, 'Robin Example', 'code-names.json', { schema: 'medrec-code-names/v1', person: 'p_other', codes: { 'icd10cm|I10': { name: 'Wrong' } }, private_codes: {} })],
        ['other-layout', (root) => setView(root, 'Robin Example', 'code-names.json', { schema: 'medrec-code-names/v2', person: personId(root, 'Robin Example'), codes: { 'icd10cm|I10': { name: 'Wrong' } }, private_codes: {} })],
        ['odd-shape', (root) => setView(root, 'Robin Example', 'code-names.json', { schema: 'medrec-code-names/v1', person: personId(root, 'Robin Example'), codes: ['x'], private_codes: null })],
        ['arriving', (root) => writeFileSync(codeNames(root), '{"schema":"medrec-code-names/v1","codes":{"icd10cm|I10":{"name":"Wrong"}}}')],
      ];
      for (const [name, change] of bad) {
        const root = copy(demo, `plain-${name}`);
        change(root);
        for (const args of [{ kind: 'conditions', person: 'Robin' }, { kind: 'conditions' }]) {
          const { r } = await ask(root, 'medrec_records', args);
          expect(r.isError ?? false, name).toBe(false);
          expect(pick(rows(r), pressure)).toMatchObject({ title: 'High blood pressure' });
          expect(rows(r).some((x) => x.person === 'Robin Example' && x.plain_name !== undefined), name).toBe(false);
          expect((page(r).warnings ?? []).map((w) => w.code), name).toEqual((page((await ask(demo, 'medrec_records', args)).r).warnings ?? []).map((w) => w.code));
        }
      }
    });

    it('answers without them when reading them fails, whatever the error, and logs no more than its class', async () => {
      for (const [what, fail] of [
        ['ToolError', () => ToolError.usage('past the limit')],
        ['Error', () => new Error('Network connection lost: secret')],
        ['AbortError', () => new DOMException('secret', 'AbortError')],
      ] as const) {
        class Failing extends LocalSource {
          override async read(path: string): Promise<string | null> {
            if (path.includes('code-names')) throw fail();
            return super.read(path);
          }
        }
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          for (const [tool, args] of [['medrec_records', { kind: 'conditions', person: 'Robin' }], ['medrec_records', { kind: 'conditions' }], ['medrec_summary', { person: 'Robin' }]] as const) {
            const r = (await callTool(tool, args as Record<string, unknown>, { store: new ViewsStore(new Folder(new Failing(demo), new ParsedCache(), demo)), today: TODAY }))!;
            expect(r.isError ?? false, what).toBe(false);
            expect(JSON.stringify(r)).not.toContain('plain_name');
          }
          if (what === 'ToolError') expect(logged).not.toHaveBeenCalled();
          else {
            expect(logged).toHaveBeenCalled();
            expect(logged.mock.calls.flat().join(' ')).not.toContain('secret');
          }
        } finally {
          logged.mockRestore();
        }
      }
    });

    it('reads them last in a summary, so a request they take is none the answer needs', async () => {
      class Last extends LocalSource {
        private done = false;
        override async read(path: string): Promise<string | null> {
          if (this.done && !path.includes('code-names')) throw ToolError.usage('past the limit');
          const body = await super.read(path);
          if (path.includes('code-names')) this.done = true;
          return body;
        }
      }
      // More bills than a summary lists and one of them settled: the bills are made again from documents.json.
      const root = copy(demo, 'plain-last');
      const pid = personId(root, 'Robin Example');
      const summary = JSON.parse(readFileSync(stored(root, paths.summary(pid)), 'utf8')) as { bills: { items: { document: string }[]; more: number } };
      summary.bills.more = 1;
      setView(root, 'Robin Example', 'summary.json', summary as unknown as Record<string, unknown>);
      const bills = JSON.parse(readFileSync(stored(root, `views/${pid}/bills.json`), 'utf8')) as { bills: Record<string, Record<string, unknown>> };
      bills.bills[summary.bills.items[0]!.document]!.settled = true;
      setView(root, 'Robin Example', 'bills.json', bills as unknown as Record<string, unknown>);
      const { r: asked, read } = await ask(root, 'medrec_summary', { person: 'Robin' });
      expect(read.some((f) => f.includes('documents'))).toBe(true);
      const r = (await callTool('medrec_summary', { person: 'Robin' }, { store: new ViewsStore(new Folder(new Last(root), new ParsedCache(), root)), today: TODAY }))!;
      expect(r.isError ?? false).toBe(false);
      expect(r).toEqual(asked);
      expect(JSON.stringify(r)).toContain('plain_name');
    });
  });

  it('says a bill is paid or what is left on it, and leaves settled bills out of the summary', async () => {
    const root = plain('bills-paid');
    const pid = personId(root, 'Robin Example');
    const bills = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/bills/records', `${pid}.json`), 'utf8')) as { bills: Record<string, Record<string, unknown>> };
    const paid = 'd_pv57tjsi5ot4237rjcdf';
    const part = 'd_kbw3kvi6dmg664qsv4aa';
    bills.bills[paid] = { ...bills.bills[paid], paid_total: '53.68', left: '0.00', settled: true };
    bills.bills[part] = { ...bills.bills[part], paid_total: '9.28', left: '10.00', settled: false };
    setView(root, 'Robin Example', 'bills.json', bills);
    const list = page((await ask(root, 'medrec_records', { kind: 'bills', person: 'Robin' })).r);
    expect(list.items.find((x) => x.id === paid)?.detail).toBe('Bill, paid');
    expect(list.items.find((x) => x.id === part)?.detail).toBe('Bill, 10.00 left');
    type Summary = { summary: { sections: { section: string; items: { id?: string; detail?: string }[] }[] } };
    const s = (await ask(root, 'medrec_summary', { person: 'Robin' })).r.structuredContent as Summary;
    const due = s.summary.sections.find((x) => x.section === 'bills')!.items;
    expect(due.some((x) => x.id === paid)).toBe(false);
    expect(due.some((x) => x.id === part)).toBe(true);
    // Without bills.json, bills show what each statement asked, and the page says payments may be missing.
    setView(root, 'Sam Example', 'bills.json', undefined);
    const everyone = page((await ask(root, 'medrec_records', { kind: 'bills' })).r);
    expect(everyone.warnings?.map((w) => w.code)).toEqual(['bills-not-prepared']);
    expect(everyone.warnings?.[0]?.message).toMatch(/^medrec has not prepared Sam Example's payments for assistants/);
    expect(everyone.items.find((x) => x.id === paid)?.detail).toBe('Bill, paid');
  });

  /** A person's results grouped into test series, each newest first, from their index.json. */
  function seriesOf(root: string, name: string): RecordEntry[][] {
    const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { name: string; folder: string }[] };
    const folder = h.people.find((x) => x.name === name)!.folder;
    const results = newestFirst(((JSON.parse(readFileSync(join(root, folder, 'index.json'), 'utf8')) as { records?: RecordEntry[] }).records ?? []).filter((r) => r.kind === 'result'));
    const by = new Map<string, RecordEntry[]>();
    for (const r of results) by.set(seriesKey(r), [...(by.get(seriesKey(r)) ?? []), r]);
    return [...by.values()];
  }

  it('holds back a series of tests when any of its results is private, and marks it with the first private one\'s area (medrec 0.9.3)', async () => {
    const root = plain('private-series');
    const series = seriesOf(root, 'Robin Example').find((x) => x.length >= 3)!;
    const [latest, second, oldest] = [series[0]!, series[1]!, series[series.length - 1]!];
    const tests = async (args: Record<string, unknown>) => {
      const views = page((await ask(root, 'medrec_records', { kind: 'tests', ...args })).r);
      // From the files, the same answer.
      expect(page(await raw(root, 'medrec_records', { kind: 'tests', ...args }))).toEqual(views);
      return views;
    };
    const before = await tests({});
    expect(before.items.some((x) => x.id === latest.id)).toBe(true);

    // An earlier result private: the series is left out of an answer about everyone, counted once.
    privateOf(root, 'Robin Example', { records: { [oldest.id]: 'mental_health' } });
    const everyone = await tests({});
    expect(everyone.items).toEqual(before.items.filter((x) => x.id !== latest.id));
    expect(left(everyone)).toBe(1);
    const robin = await tests({ person: 'Robin' });
    expect(robin.items.find((x) => x.id === latest.id)?.private).toBe('mental_health');
    expect(robin.items.filter((x) => x.private !== undefined)).toHaveLength(1);
    // Named, it is included; a range that leaves the private result out leaves the series in.
    const named = await tests({ name: latest.display });
    expect(named.items.find((x) => x.id === latest.id)?.private).toBe('mental_health');
    const since = await tests({ since: second.date!.slice(0, 10) });
    expect(since.items.find((x) => x.id === latest.id)?.private).toBeUndefined();
    expect(left(since)).toBe(0);

    // The latest's area first, then the newest private result's.
    privateOf(root, 'Robin Example', { records: { [oldest.id]: 'mental_health', [latest.id]: 'reproductive' } });
    expect((await tests({ person: 'Robin' })).items.find((x) => x.id === latest.id)?.private).toBe('reproductive');
    privateOf(root, 'Robin Example', { records: { [oldest.id]: 'mental_health', [second.id]: 'sexual_health' } });
    expect((await tests({ person: 'Robin' })).items.find((x) => x.id === latest.id)?.private).toBe('sexual_health');
    expect(left(await tests({}))).toBe(1);
  });

  it('finds private results among a large person\'s series, results of one date and name included', async () => {
    const root = copy(large, 'large-private-series');
    const all = seriesOf(root, 'Robin Example');
    // Of every series, an old result; and the second of two results that share a date and a name.
    const chosen = new Map<string, string>();
    all.forEach((x, i) => {
      if (i % 2 === 0) chosen.set(x[x.length - 2 + (x.length > 1 ? 0 : 1)]!.id, 'substance_use');
    });
    const twin = all.flat().find((r, i, rs) => rs.some((o, j) => j !== i && seriesKey(o) === seriesKey(r) && o.date === r.date && o.display === r.display && j < i))!;
    chosen.set(twin.id, 'household');
    privateOf(root, 'Robin Example', { records: Object.fromEntries(chosen) });
    for (const args of [{}, { person: 'Robin' }, { person: 'Robin', since: '2020-01-01' }, { name: all[0]![0]!.display }]) {
      const views = page((await ask(root, 'medrec_records', { kind: 'tests', ...args })).r);
      expect(page(await raw(root, 'medrec_records', { kind: 'tests', ...args })), JSON.stringify(args)).toEqual(views);
    }
    const robin = page((await ask(root, 'medrec_records', { kind: 'tests', person: 'Robin' })).r);
    const twinSeries = all.find((x) => x.some((r) => r.id === twin.id))!;
    expect(robin.items.find((x) => x.id === twinSeries[0]!.id)?.private).toBeDefined();
    expect(robin.items.filter((x) => x.private !== undefined).length).toBe(all.filter((x, i) => i % 2 === 0 || x === twinSeries).length);
  });

  /** Rewrites one of a person's view files with `change` made to its bytes, as Latin-1. */
  function changeView(root: string, name: string, view: string, change: (text: string) => string): void {
    const pid = personId(root, name);
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    const v = index.people[pid]!;
    const before = readFileSync(join(root, personDir(pid) + storedName(view, v.files[view]!)), 'latin1');
    const after = change(before);
    expect(after).not.toBe(before);
    expect(after).toHaveLength(before.length);
    const bytes = Buffer.from(after, 'latin1');
    const sum = createHash('md5').update(bytes).digest('hex');
    writeFileSync(join(root, personDir(pid) + storedName(view, sum)), bytes);
    v.files[view] = sum;
    writeFileSync(at, JSON.stringify(index));
  }

  it.each([
    ['search-items.bin does not list the record', (id: string) => (s: string) => s.replace(`"${id}"`, `"${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'a'}"`)],
    ['no entry of tests.json has its date and name', (id: string) => (s: string) => s.replace(new RegExp(`"${id}","(.)`), (m, c: string) => m.slice(0, -1) + (c === 'X' ? 'Y' : 'X'))],
  ] as const)('answers no tests of a person whose private result it cannot place: %s', async (_why, change) => {
    const root = plain(`private-unplaced-${_why.slice(0, 6).replace(/\W/g, '')}`);
    const oldest = seriesOf(root, 'Robin Example').find((x) => x.length >= 3)!.at(-1)!;
    privateOf(root, 'Robin Example', { records: { [oldest.id]: 'mental_health' } });
    changeView(root, 'Robin Example', 'search-items.bin', change(oldest.id));
    const everyone = page((await ask(root, 'medrec_records', { kind: 'tests' })).r);
    expect(everyone.items.length).toBeGreaterThan(0);
    expect(everyone.items.some((x) => x.person === 'Robin Example')).toBe(false);
    expect(everyone.warnings?.map((w) => w.code)).toEqual(['person-unavailable']);
    expect((await ask(root, 'medrec_records', { kind: 'tests', person: 'Robin' })).r.isError).toBe(true);
    // A range that leaves the result out needs no place for one it lists.
    const since = { kind: 'tests', person: 'Robin', since: '2100-01-01' };
    expect((await ask(root, 'medrec_records', since)).r.isError ?? false).toBe(_why.startsWith('search'));
  });

  it('reads no shard to place private results the question leaves out', async () => {
    const root = copy(large, 'large-private-narrow');
    const all = seriesOf(root, 'Robin Example').flat();
    const twins = all.filter((r) => all.some((o) => o !== r && o.date === r.date && o.display === r.display));
    expect(twins.length).toBeGreaterThan(20);
    privateOf(root, 'Robin Example', { records: Object.fromEntries(twins.map((r) => [r.id, 'mental_health'])) });
    const shards = (read: string[]) => read.filter((p) => /\/records-result-/.test(p)).length;
    const wide = await ask(root, 'medrec_records', { kind: 'tests', person: 'Robin' });
    const newest = all.map((r) => r.date!.slice(0, 10)).sort().at(-1)!;
    const narrow = await ask(root, 'medrec_records', { kind: 'tests', person: 'Robin', since: newest });
    expect(shards(wide.read)).toBeGreaterThan(5);
    expect(shards(narrow.read)).toBe(1);
    for (const args of [{}, { since: newest }, { since: '2015-01-01', until: '2015-12-31' }, { name: twins[0]!.display }]) {
      const a = { kind: 'tests', person: 'Robin', ...args };
      expect(page(await raw(root, 'medrec_records', a)), JSON.stringify(args)).toEqual(page((await ask(root, 'medrec_records', a)).r));
    }
  });

  it('makes the summary\'s bills again from the documents when it lists only some and one is settled', async () => {
    type Summary = { summary: { sections: { section: string; items: { id?: string }[]; more: number }[] } };
    const bills = async (root: string) => ((await ask(root, 'medrec_summary', { person: 'Alex' })).r.structuredContent as Summary).summary.sections.find((x) => x.section === 'bills')!;
    // Thirty accounts with a balance, one statement each, a day apart: more than the summary lists.
    const root = copy(demo, 'bills-many');
    const at = join(root, 'Alex Example/index.json');
    const index = JSON.parse(readFileSync(at, 'utf8')) as { documents: Record<string, unknown>[] };
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const ids = Array.from({ length: 30 }, (_, i) => `d_bill${letters[Math.floor(i / 26)]}${letters[i % 26]}`.padEnd(22, 'q'));
    ids.forEach((id, i) => {
      const date = `2026-0${1 + Math.floor(i / 10)}-${String(10 + (i % 10)).padStart(2, '0')}`;
      index.documents.push({ id, doc_type: 'bill', title: `Statement ${i}`, organization: `Example Biller ${i}`, date, statement: { account: `A${i}`, statement_date: date, amount_due: { amount: '10.00', currency: 'USD' }, due_date: '2026-12-31' } });
    });
    writeFileSync(at, JSON.stringify(index));
    writeViewsAt(root);
    addDerived(root, 'records');
    const before = await bills(root);
    expect(before.items).toHaveLength(25);
    expect(before.more).toBe(5);
    const first = before.items[0]!.id!;
    setView(root, 'Alex Example', 'bills.json', { schema: 'medrec-bills/v1', person: personId(root, 'Alex Example'), bills: { [first]: { left: '0.00', settled: true } } });
    const after = await bills(root);
    expect(after.items.map((x) => x.id)).toEqual([...before.items.slice(1).map((x) => x.id), expect.any(String)]);
    expect(after.items.some((x) => x.id === first)).toBe(false);
    expect(after.more).toBe(4);
  });
});

