// The source a reader sees for each record, through the tools: from a folder's
// files, from its views, and from views earlier writers made. The folder and
// what each record is to show are in fixtures/source-names.json.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Folder, ParsedCache } from '../src/records/folder';
import type { PersonIndex, RecordEntry } from '../src/records/model';
import { callTool } from '../src/records/tools';
import type { SlimSource } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import sample from './fixtures/source-names.json';
import { ask, writeFolder } from './names-support';
import { LocalSource, editSources } from './support';

type Who = keyof typeof sample.people;
type Shown = { now: string | null; no_label: string | null; no_organization: string | null };
type Sources = Record<string, string | null>;

const PEOPLE = Object.keys(sample.people) as Who[];
/** Each list that shows records of one kind, with that kind. */
const LISTS = [
  ['medications', 'medication'],
  ['conditions', 'condition'],
  ['immunizations', 'immunization'],
  ['results', 'result'],
  ['visits', 'encounter'],
] as const;

const recordsOf = (who: Who, kind?: string): RecordEntry[] => (sample.people[who].index as PersonIndex).records!.filter((r) => kind === undefined || r.kind === kind);
const shown: Record<string, Shown> = sample.shown;

/** The source each of these records is to show, by id. */
const want = (records: RecordEntry[], as: keyof Shown = 'now'): Sources => Object.fromEntries(records.map((r) => [r.id, shown[r.id]![as]]));
const latest = (records: RecordEntry[]) => records.filter((r) => !sample.superseded.includes(r.id));

/** The source each of these items shows, by id. */
const got = (items: unknown): Sources => Object.fromEntries((items as { id: string; source?: string }[]).map((i) => [i.id, i.source ?? null]));

/** The source each item of a list shows. */
const list = async (root: string, from: 'files' | 'views', who: Who, kind: string, format = 'concise') => got((await ask(root, from, 'medrec_records', { kind, person: who, response_format: format })).items);

interface Summary {
  sources: object[];
  sections: { section: string; items: object[] }[];
}
const summary = async (root: string, from: 'files' | 'views', who: Who) => (await ask(root, from, 'medrec_summary', { person: who })).summary as Summary;

const roots: string[] = [];
/** The sample's folder on disk, with its views. */
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'source-names-'));
  roots.push(root);
  writeFolder(root, sample.household, sample.people);
  writeViewsAt(root);
  return root;
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe.each(['files', 'views'] as const)('from the %s', (from) => {
  let root: string;
  beforeAll(() => void (root = folder()));

  describe.each(['concise', 'detailed'])('%s', (format) => {
    test.each(LISTS)("%s show each record's source", async (name, kind) => {
      for (const who of PEOPLE) expect(await list(root, from, who, name, format)).toEqual(want(recordsOf(who, kind)));
    });
  });

  test("tests show their latest result's source", async () => {
    for (const who of PEOPLE) expect(await list(root, from, who, 'tests')).toEqual(want(latest(recordsOf(who, 'result'))));
  });

  test("the timeline shows each record's source", async () => {
    for (const who of PEOPLE) expect(await list(root, from, who, 'timeline')).toEqual(want(recordsOf(who)));
  });

  test.each([
    ['medications', 'medication'],
    ['conditions', 'condition'],
    ['immunizations', 'immunization'],
    ['latest_results', 'result'],
    ['recent_visits', 'encounter'],
  ])("a summary's %s show each record's source", async (section, kind) => {
    for (const who of PEOPLE) {
      const s = await summary(root, from, who);
      expect(got(s.sections.find((x) => x.section === section)!.items)).toEqual(want(latest(recordsOf(who, kind))));
    }
  });

  test('a summary counts records by source, and none for those with no source', async () => {
    expect((await summary(root, from, 'robin')).sources).toEqual(sample.robin_by_source);
  });
});

describe('the views', () => {
  /** What the lists of each kind and the tests list show everyone, with the source of each record the views hold changed. */
  async function afterEdit(edit: (s: SlimSource) => void): Promise<{ lists: Sources; tests: Sources }> {
    const root = folder();
    editSources(root, edit);
    const all = async (kinds: readonly string[]) => Object.assign({}, ...(await Promise.all(PEOPLE.flatMap((who) => kinds.map((kind) => list(root, 'views', who, kind)))))) as Sources;
    return { lists: await all(LISTS.map(([name]) => name)), tests: await all(['tests']) };
  }
  const records = PEOPLE.flatMap((who) => recordsOf(who));
  const expected = (sources: Sources) => ({ lists: sources, tests: Object.fromEntries(latest(PEOPLE.flatMap((who) => recordsOf(who, 'result'))).map((r) => [r.id, sources[r.id]!])) });

  // The tools read a small person's files when their views do not match them, which no other test here would notice.
  test('answer without the files', async () => {
    const root = folder();
    const source = new LocalSource(root);
    const ctx = { store: new ViewsStore(new Folder(source, new ParsedCache(), root)), today: '2026-11-24' };
    for (const who of PEOPLE) {
      await callTool('medrec_summary', { person: who }, ctx);
      for (const kind of [...LISTS.map(([name]) => name), 'tests', 'timeline']) await callTool('medrec_records', { kind, person: who }, ctx);
    }
    expect(source.readPaths.length).toBeGreaterThan(0);
    expect(source.readPaths.filter((p) => p.endsWith('/index.json'))).toEqual([]);
  });

  test("hold each record's label, null where it has no source", () => {
    const labels: unknown[] = [];
    editSources(folder(), (s) => labels.push(s.label));
    expect(labels.map((l) => JSON.stringify(l)).sort()).toEqual(records.filter((r) => r.provenance).map((r) => JSON.stringify(shown[r.id]!.now)).sort());
  });

  test('show the label they hold', async () => {
    const other = Object.fromEntries(records.map((r) => [r.id, r.provenance ? sample.another_label : null]));
    expect(await afterEdit((s) => void (s.label = sample.another_label))).toEqual(expected(other));
  });

  test('show no source for a null label', async () => {
    expect(await afterEdit((s) => void (s.label = null))).toEqual(expected(Object.fromEntries(records.map((r) => [r.id, null]))));
  });

  test("with no label, show what the person's sources say with no patient known", async () => {
    expect(await afterEdit((s) => void delete s.label)).toEqual(expected(want(records, 'no_label')));
  });

  test("with no label and no organization, show the person's only sign-in by the CLI at the base", async () => {
    const edit = (s: SlimSource) => {
      delete s.label;
      delete s.organization_id;
    };
    expect(await afterEdit(edit)).toEqual(expected(want(records, 'no_organization')));
  });
});
