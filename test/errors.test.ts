// What is entered in error (src/records/errors.ts, standing.ts, tools.ts): the
// parts that medrec's answers in test/golden do not reach, over medrec's own
// fixtures and views.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OWN, ownFolder } from '../scripts/own-folder.mjs';
import { shownIndex } from '../src/records/about';
import { allOf, enteredInError } from '../src/records/errors';
import type { DocumentEntry, Household, Json, Person, PersonIndex, Provenance, RecordEntry } from '../src/records/model';
import { withoutPapers } from '../src/records/papers';
import { SUMMARY_LINES, summarize } from '../src/records/views';
import { billsInError, differ, paperNote, saysOf } from '../src/records/standing';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName, type ViewsIndex } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

describe('what is said of what is entered in error', () => {
  it('counts bills, and those the household marked a payment on', () => {
    expect([billsInError(1, 0), billsInError(2, 0), billsInError(1, 1), billsInError(2, 1), billsInError(2, 2), billsInError(3, 2)]).toEqual([
      '1 bill entered in error, not shown',
      '2 bills entered in error, not shown',
      '1 bill entered in error, with a payment you marked',
      '2 bills entered in error, 1 with a payment you marked',
      '2 bills entered in error, each with a payment you marked',
      '3 bills entered in error, 2 with a payment you marked',
    ]);
  });

  it('gives each word, whatever it lacks', () => {
    const says: Json = [
      { source: 'Example Health', read: '2024-07-02', status: 'current' },
      { source: 'Example Clinic', verification: 'entered-in-error' },
      { source: null, unheard: true },
      { source: 'Example Lab', status: 'final', verification: 'Confirmed' },
      { source: 'a file', unheard: true, household: true },
    ];
    expect(saysOf(says)).toEqual(['Example Health: current (read 2024-07-02)', 'Example Clinic: no status, entered-in-error', 'a source with no name: not heard', 'Example Lab: final', "the household's own file"]);
    expect(differ(says)).toEqual({ standing: 'sources differ', says: saysOf(says).join('; ') });
    for (const none of [undefined, null, [], 'x', {}]) expect(differ(none)).toEqual({});
  });

  it('says of a paper what is kept, and nothing of one no source says it of', () => {
    const says = [{ source: 'Example Health', status: 'entered-in-error' }];
    const nothing = { decisions: 0, payments: 0, corrections: 0 };
    const error = 'Entered in error (Example Health: entered-in-error): it is in no list, event, bill or total.';
    expect(paperNote(says, true, nothing)).toBe(error);
    expect(paperNote(says, true, { decisions: 1, payments: 2, corrections: 0 })).toBe(`${error} Kept and not applied: 1 decision about its event, 2 payments on it.`);
    expect(paperNote(says, true, { decisions: 2, payments: 1, corrections: 1 })).toBe(`${error} Kept and not applied: 2 decisions about its event, 1 payment on it, 1 correction of a provider it names.`);
    expect(paperNote(says, false, { decisions: 1, payments: 1, corrections: 1 })).toBe('Its sources differ (Example Health: entered-in-error).');
    expect(paperNote(undefined, false, nothing)).toBeUndefined();
  });

  it('makes a statement its next copy where its first is entered in error', () => {
    const papers = [{ id: 'a' }, { id: 'b', same_statement_as: 'a' }, { id: 'c', same_statement_as: 'a' }, { id: 'd', same_statement_as: null }, { id: 'e', same_statement_as: 'd' }];
    const of = (...errors: string[]) => withoutPapers(papers, new Set(errors)).map((d) => [d.id, d.same_statement_as ?? null]);
    expect(of()).toEqual([['a', null], ['b', 'a'], ['c', 'a'], ['d', null], ['e', 'd']]);
    expect(of('a')).toEqual([['b', null], ['c', 'b'], ['d', null], ['e', 'd']]);
    expect(of('a', 'b', 'e')).toEqual([['c', null], ['d', null]]);
  });
});

describe("over medrec's views", () => {
  const PAPER = 'd_skinbillaaaaaaaaaaaa';
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-errors-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let n = 0;
  let root = '';
  beforeEach(() => {
    root = ownFolder('errors', join(scratch, String(n++)), { views: true });
  });
  const ask = async (name: string, args: Record<string, unknown>) => (await callTool(name, args, { store: new ViewsStore(folderAt(root)), today: '2026-11-25' }))!.structuredContent as Record<string, any>;
  /** A pass that has not uploaded one of the person's views yet. */
  const without = (view: string) => {
    const [pid, v] = Object.entries((JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex).people)[0]!;
    rmSync(join(root, personDir(pid) + storedName(view, v.files[view]!)));
  };
  const bills = async () => {
    const r = await ask('medrec_records', { kind: 'bills', person: 'Robin' });
    return { ids: r.items.map((i: { id: string }) => i.id), warnings: r.warnings.map((w: { code: string; message: string }) => (w.code === 'entered-in-error' ? w.message : w.code)) };
  };

  it('lists the bills that stand without a current bills.json, which payments were marked on not known', async () => {
    const now = await bills();
    expect(now).toEqual({ ids: ['d_eyebillaaaaaaaaaaaaa'], warnings: ['2 bills entered in error, 1 with a payment you marked'] });
    without('bills.json');
    expect(await bills()).toEqual({ ids: now.ids, warnings: ['2 bills entered in error, not shown', 'bills-not-prepared'] });
  });

  it('summarizes what stands where standing.json has not arrived, and says what it leaves out', async () => {
    root = ownFolder('words', join(scratch, String(n++)), { views: true });
    const index = JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex;
    const errors = Object.values(index.people)[0]!.in_error as Record<string, string[]>;
    const sections = async () => (await ask('medrec_summary', { person: 'Robin' })).summary.sections as { section: string; note?: string; items: { id?: string; standing?: string }[] }[];
    for (const gone of [false, true]) {
      if (gone) without('standing.json');
      for (const [section, kind] of [['medications', 'medication'], ['conditions', 'condition'], ['allergies', 'allergy'], ['latest_results', 'result']] as const) {
        const s = (await sections()).find((x) => x.section === section)!;
        expect(s.note, section).toContain(`${errors[kind]!.length} entered in error, not shown`);
        expect(s.items.filter((x) => errors[kind]!.includes(x.id!)), section).toEqual([]);
        if (kind !== 'result') expect(s.items.some((x) => x.standing !== undefined), section).toBe(!gone);
      }
    }
  });

  it('opens a paper entered in error with what it can read of what is kept', async () => {
    const error = 'Entered in error (Sample Clinic East: entered-in-error (read 2024-07-03)): it is in no list, event, bill or total.';
    const text = 'No text was extracted from this document: an image without OCR, or a file medrec cannot read.';
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} Kept and not applied: 1 payment on it. ${text}`);
    without('bills.json');
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} ${text}`);
    without('events.json');
    without('private.json');
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} ${text}`);
  });
});

describe('what is entered in error, as an index says', () => {
  const from = (n: number, x: Partial<Provenance> = {}): Provenance => ({ source: { kind: 'fhir', cli: 'fakeprov', organization_id: `org${n}` }, source_resource: { type: 'Observation', id: `o${n}` }, raw_path: `x/${n}.json`, ...x });
  const word = (n: number, status?: string, verification?: string) => ({ raw_path: `x/${n}.json`, ...(status === undefined ? {} : { status }), ...(verification === undefined ? {} : { verification }) });
  const is = (x: Partial<RecordEntry>) => enteredInError({ schema: 'medrec-index/v1', records: [{ id: 'r_one', kind: 'result', display: 'Example', ...x }] }).get('result')?.has('r_one') ?? false;
  const isPaper = (x: Partial<DocumentEntry>) => enteredInError({ schema: 'medrec-index/v1', documents: [{ id: 'd_one', path: 'x.pdf', ...x }] }).get('document')?.has('d_one') ?? false;
  const ERROR = 'entered-in-error';

  it('is what every source of it says', () => {
    const two = { provenance: [from(1), from(2)] };
    expect([is({ ...two, words: [word(1, ERROR), word(2, 'x', ERROR)] }), is({ ...two, words: [word(1, ERROR), word(2, 'final')] }), is({ ...two, words: [word(1, ERROR)] })]).toEqual([true, false, false]);
    expect(['Entered in Error', ' entered_in_error ', 'error', undefined].map((s) => is({ provenance: [from(1)], words: [word(1, s)] }))).toEqual([true, true, false, false]);
  });

  it('is by its own status where a source keeps no word, as its only one or the one that wrote it', () => {
    const own = { status: ERROR };
    expect([is(own), is({ ...own, provenance: [from(1)] }), is({ fields: { verification_status: ERROR } }), is({})]).toEqual([true, true, true, false]);
    const two = { ...own, provenance: [from(1), from(2)], words: [word(2, ERROR)] };
    expect([undefined, 'x/1.json', 'x/2.json', 'x/gone.json'].map((fields_from) => is({ ...two, fields_from }))).toEqual([false, true, false, false]);
    // A source's second resource writes nothing.
    const later = { ...own, provenance: [from(2), from(1), from(1, { raw_path: 'x/3.json' })], words: [word(1, ERROR), word(2, 'final')], fields_from: 'x/3.json' };
    expect(is(later)).toBe(false);
  });

  it('is no dose, and one its sources differ on is, whatever its status', () => {
    const dose = (id: string, words: object[]): RecordEntry => ({ id, kind: 'immunization', date: '2024-03-04', display: 'Example vaccine', status: ERROR, provenance: [from(1), from(2)], words: words as RecordEntry['words'] });
    const idx: PersonIndex = { schema: 'medrec-index/v1', records: [dose('r_both', [word(1, ERROR), word(2, ERROR)]), dose('r_one', [word(1, ERROR), word(2, 'completed')])] };
    const p: Person = { id: 'p_one', name: 'Robin Example', folder: 'Robin Example', adult: true };
    const s = summarize({ schema: 'medrec-household/v1', people: [p] } as unknown as Household, p, idx, 0, '2024-06-01', SUMMARY_LINES, allOf(enteredInError(idx)));
    expect(s.immunizations.items.map((v) => [v.id, v.doses])).toEqual([['r_one', 1]]);
  });

  it('is of a paper what each source that has it says, and of none the household filed', () => {
    const other = { also_from: [from(2)] };
    expect([
      isPaper({ provenance: from(1), words: [word(1, ERROR)] }),
      isPaper({ provenance: from(1) }),
      isPaper({ provenance: from(1), ...other, words: [word(1, ERROR)] }),
      isPaper({ provenance: from(1), ...other, words: [word(1, ERROR), word(2, undefined, ERROR)] }),
      isPaper({ provenance: { source: { kind: 'scan' } }, words: [word(1, ERROR)] }),
      isPaper({}),
    ]).toEqual([true, false, false, true, false, false]);
  });

  it.each(OWN)('is what medrec\'s views of test/fixtures/%s name', (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'oyh-errors-own-'));
    const root = ownFolder(name, join(dir, 'x'), { views: true });
    const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: Person[] };
    const views = JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex;
    for (const p of h.people) {
      const idx = JSON.parse(readFileSync(join(root, p.folder, 'index.json'), 'utf8')) as PersonIndex;
      const got = [...enteredInError(shownIndex(p, idx))].map(([kind, ids]) => [kind, [...ids].sort()]);
      const want = Object.entries((views.people[p.id]!.in_error ?? {}) as Record<string, string[]>).map(([kind, ids]) => [kind, [...ids].sort()]);
      expect(got.sort()).toEqual(want.sort());
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('what is entered in error, with no views from medrec', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-errors-files-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const files = ownFolder('errors', join(scratch, 'files'));
  const own = ownFolder('errors', join(scratch, 'own'));
  writeViewsAt(own);
  const medrecs = ownFolder('errors', join(scratch, 'medrecs'), { views: true });
  const ask = async (root: string, name: string, args: object) => (await callTool(name, args, { store: new ViewsStore(folderAt(root)), today: '2026-11-25' }))!.structuredContent as Record<string, any>;
  const said = (r: Record<string, any>) => (r.warnings ?? []).filter((w: { code: string }) => w.code === 'entered-in-error');

  it.each(['files', 'own'])('is in no list, and counted: %s', async (of) => {
    const root = { files, own }[of]!;
    let counted = 0;
    for (const person of [{}, { person: 'Robin' }]) {
      for (const kind of ['results', 'tests', 'reports', 'immunizations', 'visits', 'procedures', 'claims', 'documents', 'timeline', 'conditions', 'medications', 'allergies']) {
        const want = await ask(medrecs, 'medrec_records', { kind, limit: 100, ...person });
        const got = await ask(root, 'medrec_records', { kind, limit: 100, ...person });
        // With no private.json nothing can be listed of a whole household.
        if ('person' in person) expect(got.items.map((i: { id: string }) => i.id), kind).toEqual(want.items.map((i: { id: string }) => i.id));
        if ('person' in person) expect(said(got), kind).toEqual(said(want));
        counted += said(got).length;
      }
    }
    expect(counted).toBeGreaterThan(3);
    const summary = async (r: string) => (await ask(r, 'medrec_summary', { person: 'Robin' })).summary as { counts: object; sections: { section: string; note?: string; items: { id?: string }[] }[] };
    const [got, want] = [await summary(root), await summary(medrecs)];
    expect(got.counts).toEqual(want.counts);
    for (const section of ['immunizations', 'latest_results', 'recent_visits']) expect(got.sections.find((s) => s.section === section)).toEqual(want.sections.find((s) => s.section === section));
    for (const query of ['example', 'sample', 'skin']) {
      const [g, w] = [await ask(root, 'medrec_search', { query, person: 'Robin', limit: 50 }), await ask(medrecs, 'medrec_search', { query, person: 'Robin', limit: 50 })];
      expect([g.items.map((i: { id: string }) => i.id), said(g)]).toEqual([w.items.map((i: { id: string }) => i.id), said(w)]);
    }
  });

  it('opens by its id as entered in error', async () => {
    const PAPER = 'd_skinbillaaaaaaaaaaaa';
    for (const root of [files, own]) expect((await ask(root, 'medrec_document', { id: PAPER, person: 'Robin' })).hint).toContain('Entered in error');
  });
});
