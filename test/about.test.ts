// What a chart holds that is about somebody else (src/records/about.ts,
// src/records/questionnaires.ts): in no answer or view, and counted.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { shownIndex } from '../src/records/about';
import { ParsedCache } from '../src/records/folder';
import type { DocumentEntry, Person, PersonIndex, RecordEntry } from '../src/records/model';
import { grownAnswers } from '../src/records/questionnaires';
import { callTool } from '../src/records/tools';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

const scratch = mkdtempSync(join(tmpdir(), 'oyh-about-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const FIXTURES = join(import.meta.dirname, 'fixtures');
/** The ids medrec's own views of the folder name. */
const IDS = (Object.values((JSON.parse(readFileSync(join(FIXTURES, 'child/views/views.json'), 'utf8')) as { people: Record<string, { about_another: string[] }> }).people)[0]!).about_another;
const LINE = `${IDS.length} items about another person, not shown`;

describe('a questionnaire a grown person answers', () => {
  it.each([
    'Edinburgh Depression Scale', 'EPDS total', 'Postpartum depression screening', 'Maternal Depression Screen', 'Caregiver depression', 'PHQ-9 total score', 'PHQ2', 'PHQ-9M Score',
    'Patient Health Questionnaire', 'Beck Depression Inventory', 'Geriatric depression scale', 'Depression screening', 'Depression', 'Screening for depression',
    'Little interest or pleasure in doing things', 'Thoughts of hurting yourself', 'GAD-7', 'GAD2 score', 'Generalized anxiety disorder 7 item', 'AUDIT-C total', 'Alcohol use', 'CAGE-AID',
    'How often do you have a drink containing alcohol', 'Drinks per week', 'DAST-10', 'CRAFFT score', 'Illicit drug use', 'Substance use',
  ])('is %s', (name) => expect(grownAnswers(name)).toBe(true));

  it.each([
    "Children's Depression Inventory", 'CES-DC', 'Anxiety screening', 'Spence score', 'Child anxiety scale', 'Suicide risk', 'C-SSRS', 'Self-harm risk', 'Suicidal ideation', 'Tobacco smoking status',
    'Smoker', 'Cigarettes per day', 'Vaping', 'Pack years', 'Cotinine, urine', 'PTSD checklist', 'PCL-5', 'ADHD rating scale', 'PSC-17', 'ST depression', 'Respiratory depression',
    'Rib cage, two views', 'GAD-65 antibody', 'Mast cell count', 'Drug screen, urine', 'Alcohol, ethyl', 'Vapor, inhaled', 'Ages and stages, 24 months', 'Autism screening at 18 months',
    'Hearing screening', 'Hemoglobin', 'Audit of the chart',
  ])('is not %s', (name) => expect(grownAnswers(name)).toBe(false));

  it('is told by its code first, and by the name of its code', () => {
    const code = (code: string, display?: string, system = 'http://loinc.org') => ({ system, code, display });
    expect(grownAnswers('Total score', code('44261-6'))).toBe(true);
    expect(grownAnswers('Anxiety', code('71354-5', 'PHQ'))).toBe(true);
    expect(grownAnswers('GAD-7', code('72166-2'))).toBe(false);
    // The same digits in another system are another code.
    expect(grownAnswers('Total score', code('44261-6', undefined, 'urn:example:local'))).toBe(false);
    expect(grownAnswers('Total score', code('1', 'GAD-7 total', 'urn:example:local'))).toBe(true);
  });
});

describe('what is about another person', () => {
  const child: Person = { id: 'p_robinaaaaaaaaaaaaaaa', name: 'Robin Example', folder: 'Robin Example', adult: false, birth_date: '2013-03-05' };
  const source = { kind: 'fhir', cli: 'fakeprov' };
  const result = (x: Partial<RecordEntry> = {}): RecordEntry => ({ id: 'r_one', kind: 'result', date: '2024-03-04', display: 'PHQ-9 total', provenance: [{ source }], ...x });
  const paper = (x: Partial<DocumentEntry> = {}): DocumentEntry => ({ id: 'd_one', path: 'x.pdf', date: '2024-03-04', title: 'Beck depression inventory', provenance: { source }, ...x });
  const of = (p: Person, idx: Partial<PersonIndex>) => shownIndex(p, { schema: 'medrec-index/v1', ...idx }).about_another ?? [];
  const is = (x: Partial<RecordEntry>, p = child) => of(p, { records: [result(x)] }).length === 1;
  const isPaper = (x: Partial<DocumentEntry>, p = child) => of(p, { documents: [paper(x)] }).length === 1;

  it('is a screening before the 11th birthday', () => {
    expect([is({}), is({ kind: 'report' }), is({ kind: 'condition' }), is({ display: 'Hemoglobin' })]).toEqual([true, true, false, false]);
    expect([is({ date: '2024-03-04T23:00:00Z' }), is({ date: '2024-03-05' }), is({ date: '2024-03' })]).toEqual([true, false, false]);
    expect([is({}, { ...child, birth_date: null }), is({}, { ...child, birth_date: '1984-05-06' })]).toEqual([false, false]);
    // Undated, by when it was first read in.
    const read = (...days: string[]) => is({ date: null, provenance: days.map((d) => ({ source, fetched_at: `${d}T10:00:00Z` })) });
    expect([read('2025-01-02', '2024-01-02'), read('2025-01-02'), read()]).toEqual([true, false, false]);
  });

  it('is not a laboratory test', () => {
    expect(['Laboratory', 'lab', 'Survey'].map((category) => is({ display: 'Alcohol use', fields: { category } }))).toEqual([false, false, true]);
  });

  it('is one its source says is, at any age', () => {
    const grown = { ...child, birth_date: '1984-05-06' };
    expect(['a parent', 'another person'].map((about) => is({ display: 'Hemoglobin', fields: { about } }, grown))).toEqual([true, true]);
    expect(is({ kind: 'condition', fields: { about: 'a parent' } }, grown)).toBe(false);
  });

  it('is one by what any source gave of it', () => {
    expect([is({ display: 'Total', given: [{ display: 'PHQ-9 total' }] }), is({ display: 'Total', given: [{ fields: { about: 'a parent' } }] }), is({ display: 'Total', given: [{}] })]).toEqual([true, true, false]);
    expect(is({ display: 'Total', given: [{ code: { system: 'http://loinc.org', code: '44261-6' } }] })).toBe(true);
    expect([isPaper({ title: 'Letter', given: [{ title: 'EPDS' }] }), isPaper({ title: 'Letter', given: [{}] })]).toEqual([true, false]);
  });

  it('is one by the resource its values are of', () => {
    const from = (n: number, x: object = {}) => ({ source: { ...source, organization_id: `org${n}` }, source_resource: { type: 'Observation', id: `o${n}` }, raw_path: `x/${n}.json`, ...x });
    const said = (raw_path?: string) => ({ ...(raw_path === undefined ? {} : { raw_path }), fields: { about: 'a parent' } });
    const of2 = (x: Partial<RecordEntry>) => is({ display: 'Hemoglobin', ...x });
    const two = [from(1), from(2)];
    // Of the only one, and of what no resource is known of.
    expect([of2({ provenance: [from(1)], given: [said('x/1.json')] }), of2({ provenance: [from(1)], given: [said('x/2.json')] }), of2({ provenance: two, given: [said()] })]).toEqual([true, false, true]);
    // Of the one it names, else of the first one.
    const given = [said('x/2.json')];
    expect(['x/2.json', 'x/1.json', 'x/gone.json', undefined].map((fields_from) => of2({ provenance: two, given, fields_from }))).toEqual([true, false, false, false]);
    expect(of2({ provenance: two, given: [said('x/1.json')] })).toBe(true);
    // A source's second resource writes nothing, unless its first says it is entered in error.
    const later = [from(1), from(1, { raw_path: 'x/2.json', source_resource: { type: 'Observation', id: 'o2' } })];
    expect(of2({ provenance: later, given, fields_from: 'x/2.json' })).toBe(false);
    const words = (status: string) => [{ raw_path: 'x/1.json', status }];
    expect(['final', 'entered-in-error', ' Entered_in error'].map((s) => of2({ provenance: later, given, fields_from: 'x/2.json', words: words(s) }))).toEqual([false, true, true]);
    // One with no id is the first of its type.
    const idless = (type: string) => [from(1), from(1, { raw_path: 'x/2.json', source_resource: { type, id: '' } })];
    expect(of2({ provenance: idless('Observation'), given, fields_from: 'x/2.json' })).toBe(true);
    expect(of2({ provenance: [...idless('Observation').slice(1).map((v) => ({ ...v, raw_path: 'x/0.json' })), ...idless('Observation')], given, fields_from: 'x/2.json' })).toBe(false);
  });

  it('is a paper a source served, and not one the household filed', () => {
    const household = { source: { kind: 'scan' } };
    expect([isPaper({}), isPaper({ date: '2024-03-05' }), isPaper({ title: 'Letter' }), isPaper({ provenance: household }), isPaper({ also_from: [household] })]).toEqual([true, false, false, false, false]);
  });

  it('is a paper only such records list', () => {
    const letter = paper({ title: 'Letter' });
    const [one, other] = [result({ documents: ['d_one'] }), result({ id: 'r_two', display: 'Hemoglobin', documents: ['d_one'] })];
    expect(of(child, { records: [one], documents: [letter] })).toEqual(['d_one', 'r_one']);
    expect(of(child, { records: [one, other], documents: [letter] })).toEqual(['r_one']);
    expect(of(child, { records: [one], documents: [paper({ title: 'Letter', provenance: { source: { kind: 'scan' } } })] })).toEqual(['r_one']);
  });

  it('is named by nothing that stays', () => {
    const claim: RecordEntry = { id: 'r_claim', kind: 'claim', display: 'Office visit', fields: { results: ['r_one', 'r_two'], items: [{ sequence: 1, records: ['r_one'] }, { sequence: 2 }] } };
    const bill = (id: string, same_statement_as?: string) => paper({ id, title: 'Bill', same_statement_as });
    const shown = shownIndex(child, {
      schema: 'medrec-index/v1',
      records: [result(), result({ id: 'r_two', display: 'Hemoglobin', documents: ['d_one', 'd_two'] }), claim],
      documents: [paper(), bill('d_two', 'd_one'), bill('d_three', 'd_one'), bill('d_four')],
    });
    expect(shown.about_another).toEqual(['d_one', 'r_one']);
    expect(shown.records).toEqual([result({ id: 'r_two', display: 'Hemoglobin', documents: ['d_two'] }), { ...claim, fields: { results: ['r_two'], items: [{ sequence: 1 }, { sequence: 2 }] } }]);
    // A statement's first copy that stays is the one the others are of.
    expect(shown.documents!.map((d) => [d.id, d.same_statement_as])).toEqual([['d_two', undefined], ['d_three', 'd_two'], ['d_four', undefined]]);
  });
});

describe("a child's chart", () => {
  const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? all(join(dir, f.name)) : [join(dir, f.name)]));
  const raw = ownFolder('child', join(scratch, 'raw'));
  const own = ownFolder('child', join(scratch, 'own'));
  writeViewsAt(own);
  const medrecs = ownFolder('child', join(scratch, 'medrecs'), { views: true });
  const stores = { 'files alone': raw, 'views this connector wrote': own, "medrec's views": medrecs };
  const ask = async (root: string, tool: string, args: object) => (await callTool(tool, args, { store: new ViewsStore(folderAt(root)), today: '2026-11-25' }))!;

  it.each(Object.entries(stores))('is answered without what is about another person, from %s', async (_n, root) => {
    for (const kind of ['results', 'tests', 'timeline', 'documents', 'claims', 'visits']) {
      for (const more of [{}, { response_format: 'detailed' }, { limit: 1 }]) {
        const r = await ask(root, 'medrec_records', { kind, person: 'Robin', ...more });
        const text = JSON.stringify(r.structuredContent);
        for (const id of IDS) expect(text, `${kind} ${id}`).not.toContain(id);
        expect(text.includes(LINE), kind).toBe(['results', 'tests', 'timeline', 'documents'].includes(kind));
        const cursor = r.structuredContent!.next_cursor;
        // The first page says it.
        if (cursor) expect(JSON.stringify((await ask(root, 'medrec_records', { kind, person: 'Robin', ...more, cursor })).structuredContent)).not.toContain('about-another');
      }
      expect(JSON.stringify((await ask(root, 'medrec_records', { kind })).structuredContent)).not.toContain('about-another');
    }
    for (const query of ['depression', 'score', 'alcohol']) expect(JSON.stringify((await ask(root, 'medrec_search', { query, person: 'Robin' })).structuredContent)).not.toMatch(new RegExp(IDS.join('|')));
    expect(JSON.stringify((await ask(root, 'medrec_summary', { person: 'Robin' })).structuredContent)).not.toMatch(/PHQ|GAD|Beck|another person/);
    for (const id of IDS.filter((x) => x.startsWith('d_'))) expect((await ask(root, 'medrec_document', { id })).isError).toBe(true);
  });

  it('is in views without it, which name it as medrec does', () => {
    const views = JSON.parse(readFileSync(join(own, 'views/views.json'), 'utf8')) as { people: Record<string, { about_another?: string[] }> };
    expect(Object.values(views.people).map((v) => v.about_another)).toEqual([IDS]);
    for (const f of all(join(own, 'views')).filter((f) => !f.endsWith('views.json'))) for (const id of IDS) expect(readFileSync(f).includes(id), `${f} ${id}`).toBe(false);
  });

  it('is read whole without what medrec named, though it would not be told here', async () => {
    const stale = ownFolder('child', join(scratch, 'stale'), { views: true });
    // Now a grown person's, as far as the files say: the views are older.
    const at = join(stale, 'household.json');
    const h = JSON.parse(readFileSync(at, 'utf8')) as { people: Person[] };
    for (const p of h.people) p.birth_date = '1984-05-06';
    writeFileSync(at, JSON.stringify(h));
    const r = await ask(stale, 'medrec_records', { kind: 'results', person: 'Robin', limit: 100 });
    expect(JSON.stringify(r.structuredContent)).not.toMatch(new RegExp(IDS.join('|')));
    expect(JSON.stringify(r.structuredContent)).toContain(LINE);
  });

  /** Every list and search of a folder's files, with what earlier calls left in the cache. */
  const answers = async (root: string, cache?: ParsedCache) => {
    const store = () => new ViewsStore(folderAt(root, cache));
    const out: unknown[] = [];
    for (const kind of ['results', 'tests', 'timeline', 'documents', 'claims', 'visits']) out.push((await callTool('medrec_records', { kind, person: 'Robin', limit: 100 }, { store: store(), today: '2026-11-25' }))!);
    for (const query of ['depression', 'score', 'alcohol', 'labs', 'example', 'sample']) out.push((await callTool('medrec_search', { query, person: 'Robin', limit: 50 }, { store: store(), today: '2026-11-25' }))!);
    out.push((await callTool('medrec_summary', { person: 'Robin' }, { store: store(), today: '2026-11-25' }))!);
    return JSON.stringify(out);
  };
  const edit = (root: string, file: string, f: (v: any) => void) => {
    const v = JSON.parse(readFileSync(join(root, file), 'utf8'));
    f(v);
    writeFileSync(join(root, file), JSON.stringify(v));
  };

  it('is answered by the birth date it has now, whatever the cache holds', async () => {
    const root = ownFolder('child', join(scratch, 'born'));
    const cache = new ParsedCache();
    const born = (day: string) => edit(root, 'household.json', (h) => h.people.forEach((p: Person) => (p.birth_date = day)));
    const seen = new Set<string>();
    for (const day of ['1984-05-06', '2015-02-03', '1984-05-06', '2015-02-03']) {
      born(day);
      const got = await answers(root, cache);
      expect(got).toBe(await answers(root));
      expect(IDS.some((id) => got.includes(id)), day).toBe(day.startsWith('1984'));
      seen.add(got);
    }
    expect(seen.size).toBe(2);
  });

  it("is answered by what medrec's views name now, whatever the cache holds", async () => {
    const root = ownFolder('child', join(scratch, 'named'), { views: true });
    // Of a grown person in views of before: only what they name is left out.
    edit(root, 'household.json', (h) => h.people.forEach((p: Person) => (p.birth_date = '1984-05-06')));
    const cache = new ParsedCache();
    const ONE = 'r_lowmoodaaaaaaaaaaaaa';
    for (const ids of [IDS, [ONE], [], IDS.filter((id) => id !== ONE), IDS]) {
      edit(root, 'views/views.json', (v) => Object.values(v.people as Record<string, { about_another?: string[] }>).forEach((p) => (p.about_another = ids)));
      const got = await answers(root, cache);
      expect(got).toBe(await answers(root));
      for (const id of ids) expect(got).not.toContain(id);
      expect(IDS.filter((id) => !ids.includes(id)).some((id) => got.includes(id))).toBe(ids.length < IDS.length);
    }
  });
});
