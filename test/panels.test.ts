// Panels, headings and readings (src/records/panels.ts, values.ts): what a
// source says a result lists, and what a list says of it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { shownIndex } from '../src/records/about';
import type { Given, Json, Person, PersonIndex, RecordEntry } from '../src/records/model';
import { heads } from '../src/records/panels';
import type { Privacy } from '../src/records/private';
import { callTool } from '../src/records/tools';
import { valueText } from '../src/records/values';
import { latestResults, recordDetail, resultRow } from '../src/records/views';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore, privacyOf } from '../src/views/store';
import { folderAt } from './support';

const AT = (id: string) => `x/Observation/${id}.json`;
const result = (id: string, x: Partial<RecordEntry> = {}): RecordEntry => ({ id, kind: 'result', date: '2024-03-04', display: `Example ${id}`, provenance: [{ source: { kind: 'fhir', cli: 'fakeprov' }, raw_path: AT(id) }], ...x });
const listing = (id: string, ...of: string[]) => ({ [AT(id)]: of.map((x) => `Observation/${x}.json`) });

describe('a value', () => {
  it('has the comparator its source gives before its number', () => {
    const row = (value: Json) => resultRow(result('r_one', { fields: { value } }), undefined);
    expect([valueText({ value: 5, unit: 'mg', comparator: '<' }), valueText({ value: '128/76', unit: 'mmHg' }), valueText({ value: 5, comparator: 1 })]).toEqual(['<5 mg', '128/76 mmHg', '5']);
    expect(['<', '<=', '>=', '>'].map((comparator) => row({ value: 5, unit: 'mg', comparator }).value)).toEqual(['<5', '<=5', '>=5', '>5']);
    expect([row({ value: '128/76', unit: 'mmHg' }), row({ unit: 'mg', comparator: '<' })].map((r) => [r.value, r.unit])).toEqual([['128/76', 'mmHg'], [undefined, 'mg']]);
  });
});

describe('a heading', () => {
  const lists = listing('r_one', 'r_gone');

  it('is a result with no value that lists results, filed or not', () => {
    const is = (x: Partial<RecordEntry>) => heads(result('r_one', x));
    expect([is({ lists }), is({ fields: { members: ['r_two'] } }), is({ heading: true }), is({ lists, fields: { value: '' } }), is({ lists, fields: { value: null } })]).toEqual([true, true, true, true, true]);
    expect([is({}), is({ lists: {} }), is({ lists, fields: { value: '5' } }), is({ lists, fields: { value: { value: 5 } } }), is({ kind: 'report', lists })]).toEqual([false, false, false, false, false]);
  });

  it('says so where a list has it, and is no latest result', () => {
    const h = result('r_one', { lists });
    expect([recordDetail(h), recordDetail({ ...h, fields: { interpretation: 'H' } }), recordDetail({ ...h, fields: { value: '5', interpretation: 'H' } }), recordDetail({ ...h, kind: 'report' })]).toEqual(['panel', 'panel (H)', '5 (H)', undefined]);
    expect(latestResults([h, result('r_two', { display: h.display })], () => undefined).map((r) => [r.id, r.results])).toEqual([['r_two', 1]]);
  });
});

describe('what a panel lists alone is about another person', () => {
  const child: Person = { id: 'p_one', name: 'Robin Example', folder: 'Robin Example', adult: false, birth_date: '2015-02-03' };
  const of = (...records: RecordEntry[]) => shownIndex(child, { schema: 'medrec-index/v1', records } as PersonIndex);
  const theirs = (id: string) => result(id, { fields: { about: 'a parent' } });
  const gone = (...records: RecordEntry[]) => of(...records).about_another ?? [];

  it('as is one that a questionnaire lists, or a part of which is of one', () => {
    expect(gone(result('r_one', { listed_by: [{ display: 'PHQ-9 panel' }] }), result('r_two', { listed_by: [{ display: 'Sample panel', code: { system: 'http://loinc.org', code: '44261-6' } }] }), result('r_three', { listed_by: [{ display: 'Sample panel' }] }))).toEqual(['r_one', 'r_two']);
    const part = (code: Json) => ({ fields: { components: [{ code, value: 2 }, 'x'] } });
    expect(gone(result('r_one', part({ system: 'http://loinc.org', code: '44261-6' })), result('r_two', part({ display: 'PHQ-9 total' })), result('r_three', part({ display: 'Second piece' })), result('r_four', part({ display: 5, code: '44261-6' })))).toEqual(['r_one', 'r_two']);
    const given: Given[] = [{ fields: { components: [{ code: { system: 'http://loinc.org', code: '44261-6' } }] } }];
    expect(gone(result('r_one', { given }))).toEqual(['r_one']);
  });

  it('to any depth, whatever kind lists it, and not beside another of its own', () => {
    const inner = result('r_inner', { lists: listing('r_inner', 'r_a', 'r_b') });
    const outer = result('r_outer', { kind: 'report', lists: { [AT('r_outer')]: ['Observation/r_inner.json'] } });
    expect(gone(theirs('r_a'), theirs('r_b'), inner, outer)).toEqual(['r_a', 'r_b', 'r_inner', 'r_outer']);
    expect(gone(theirs('r_a'), result('r_b'), inner, outer)).toEqual(['r_a']);
    // What is not filed says nothing, and neither does a panel of itself.
    expect(gone(theirs('r_a'), inner, outer)).toEqual(['r_a', 'r_inner', 'r_outer']);
    expect(gone(result('r_self', { lists: listing('r_self', 'r_self') }))).toEqual([]);
    expect(gone(theirs('r_a'), result('r_other', { kind: 'condition', lists: listing('r_other', 'r_a') }))).toEqual(['r_a']);
  });

  it('with what is entered in error, or without it', () => {
    const panel = result('r_panel', { lists: listing('r_panel', 'r_a', 'r_b') });
    expect(gone(theirs('r_a'), result('r_b', { status: 'entered-in-error' }), panel)).toEqual(['r_a', 'r_panel']);
    expect(gone(result('r_a'), result('r_b', { status: 'entered-in-error' }), panel)).toEqual([]);
  });

  it('now or before, by each of its own raw files', () => {
    const source = { kind: 'fhir', cli: 'fakeprov' };
    const two = (lists: Record<string, string[]>, given: Given[] = []) => result('r_panel', { provenance: ['p1', 'p2'].map((x) => ({ source, raw_path: AT(x) })), lists, given });
    const both = [theirs('r_a'), result('r_b')];
    const [a, b] = [['Observation/r_a.json'], ['Observation/r_b.json']];
    const is = (x: RecordEntry) => gone(...both, x).includes('r_panel');
    expect([is(two({ [AT('p1')]: a, [AT('p2')]: a })), is(two({ [AT('p1')]: a })), is(two({ [AT('p1')]: a, [AT('p2')]: b })), is(two({ [AT('p1')]: b }))]).toEqual([true, true, false, false]);
    // What it listed before still says what it is of; an earlier list of nothing does not.
    expect([is(two({ [AT('p1')]: b }, [{ lists: { [AT('p1')]: a } }])), is(two({}, [{ lists: { [AT('p1')]: a } }])), is(two({ [AT('p1')]: b }, [{ lists: { [AT('p1')]: [] } }]))]).toEqual([true, true, false]);
    // A list of a raw file that is not its own says nothing.
    expect([is(two({ [AT('other')]: a })), is(two({ [AT('p1')]: b }, [{ lists: { [AT('other')]: a } }]))]).toEqual([false, false]);
    // An index a medrec before 0.9.10 saved has the members alone.
    expect([is(result('r_panel', { fields: { members: ['r_a'] } })), is(result('r_panel', { fields: { members: ['r_a', 'r_b'] } }))]).toEqual([true, false]);
  });

  it('and one that is not names none of it', () => {
    const panel = (members: string[]) => result('r_panel', { fields: { members }, lists: listing('r_panel', 'r_a', 'r_b') });
    const fields = (...members: string[]) => of(theirs('r_a'), result('r_b'), panel(members)).records!.find((r) => r.id === 'r_panel')!.fields;
    expect([fields('r_a', 'r_b'), fields('r_b')]).toEqual([{ members: ['r_b'] }, { members: ['r_b'] }]);
    expect(of(theirs('r_a'), result('r_b'), result('r_panel', { fields: { members: ['r_a'] }, lists: listing('r_panel', 'r_b') })).records!.find((r) => r.id === 'r_panel')!.fields).toEqual({});
  });
});

describe('the views', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-panels-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const files = ownFolder('questionnaires', join(scratch, 'files'));
  const own = ownFolder('questionnaires', join(scratch, 'own'));
  writeViewsAt(own);
  const medrecs = ownFolder('questionnaires', join(scratch, 'medrecs'), { views: true });
  const store = (root: string) => new ViewsStore(folderAt(root));
  const items = async (s: ViewsStore, args: object) => (await callTool('medrec_records', { limit: 100, ...args }, { store: s, today: '2026-11-25' }))!.structuredContent as { items: Record<string, Json>[]; warnings?: { code: string }[] };
  const HEADINGS = ['r_mixpanelaaaaaaaaaaaa', 'r_pairaaaaaaaaaaaaaaaa'];

  it.each(['files', 'own', 'medrecs'])('list a heading as a panel, and in no tests: %s', async (of) => {
    const s = store({ files, own, medrecs }[of]!);
    const { items: results } = await items(s, { kind: 'results', person: 'Robin' });
    expect(results.filter((i) => i.detail === 'panel').map((i) => i.id).sort()).toEqual(HEADINGS);
    const { items: tests } = await items(s, { kind: 'tests', person: 'Robin' });
    expect([tests.length > 5, tests.some((i) => HEADINGS.includes(i.id as string))]).toEqual([true, false]);
  });

  it('answer tests of everyone where a heading is private', async () => {
    const s = store(medrecs);
    const h = await s.household();
    const { areas, headings } = await s.privacy(h, h.people[0]!);
    expect([...headings!]).toEqual(HEADINGS.filter((id) => areas.has(id)));
    const { items: tests, warnings } = await items(s, { kind: 'tests' });
    expect([tests.length > 0, warnings!.map((w) => w.code)]).toEqual([true, ['private-left-out']]);
    // One private.json does not say is a heading has no entry, as a result still arriving has none.
    const unsaid = Object.assign(Object.create(s), { privacy: async (): Promise<Privacy> => ({ ...(await s.privacy(h, h.people[0]!)), headings: undefined }) }) as ViewsStore;
    const r = (await callTool('medrec_records', { kind: 'tests' }, { store: unsaid, today: '2026-11-25' }))!;
    expect([r.isError, /being prepared/.test(r.content[0]!.text)]).toEqual([true, true]);
  });

  it('say which private records are headings, in private.json', () => {
    const view = { studies: {}, records: { r_one: { area: 'mental_health', heading: true }, r_two: { area: 'mental_health' }, r_three: { area: 'mental_health', heading: 'x' } } };
    expect([...privacyOf(view).headings!]).toEqual(['r_one']);
    expect(privacyOf({ studies: {}, records: {} }).headings).toBeUndefined();
  });
});
