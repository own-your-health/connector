// Who a printed provider is (src/records/provider-labels.ts): the cases of
// medrec's own tests of src/provider_labels.rs, over its fixture
// (fixtures/labels/reader.json), then what the tools show over its folder.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { labelsFolder } from '../scripts/labels-folder.mjs';
import { synth } from '../scripts/synth.mjs';
import { ToolError } from '../src/mcp/errors';
import { ENVELOPE_RESERVE, SIZE_BUDGET, chars } from '../src/mcp/shape';
import { Folder, ParsedCache } from '../src/records/folder';
import type { JsonObject } from '../src/records/model';
import { NO_LABELS, printedOfClaim, printedOfDocument, printedOfEvent, printedOfRecord, printedOfTitle, providerLabelsOf, type LabelsFile, type Printed } from '../src/records/provider-labels';
import { RawStore } from '../src/records/store';
import { LABELS_LIMIT, callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName, type ViewsIndex } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import reader from './fixtures/labels/reader.json';
import { LocalSource, addDerived, folderAt, labelClaims } from './support';

const PERSON = 'p_robinaaaaaaaaaaaaaaa';

describe("a person's labels", () => {
  const VISIT = 'r_visitaaaaaaaaaaaaaaa';
  const TALK = 'r_talkaaaaaaaaaaaaaaaa';
  const OPEN = 'd_openaaaaaaaaaaaaaaaa';
  const CLOSED = 'd_closedaaaaaaaaaaaaaa';
  const labels = providerLabelsOf(reader, PERSON);
  const listed = (item: string, printed: readonly Printed[], whole: boolean, from = labels) => {
    const isPrivate = (id: string) => [TALK, CLOSED].includes(id);
    return from.shown(item, printed, { whole, isPrivate, heldBack: isPrivate });
  };
  const shown = (item: string, text: string, whole: boolean, from = labels) => listed(item, [{ field: 'provider', text, shown: true }], whole, from);
  const paper = { from: 'paper', document: CLOSED };

  it('stand beside what is printed', () => {
    expect(shown(VISIT, 'J SAMPLE', true)).toEqual([
      {
        field: 'provider',
        printed: 'J SAMPLE',
        name: 'Jordan Sample, MD',
        role: 'family doctor',
        phone: '555-010-0101',
        phone_from: { from: 'directory', date: '2026-03-08' },
        confidence: 'sure',
        evidence: [{ from: 'npi' }],
      },
    ]);
    expect(Object.keys(shown(VISIT, 'J SAMPLE', true)[0]!)).toEqual(['field', 'printed', 'name', 'role', 'phone', 'phone_from', 'confidence', 'evidence']);
  });

  it('have the text they came from, where a first name was what told', () => {
    const first = (printed: string) => ({ from: 'first_name', state: 'FL', city: 'Exampleton', printed });
    const of = (text: string) => shown(VISIT, text, true)[0]!;
    expect([of('Drew Specimen, MD').confidence, of('Drew Specimen, MD').evidence]).toEqual(['likely', [first('Drew Specimen, MD')]]);
    // Another text of the same provider is not why; a text said to be the same provider's has the text that was.
    expect(of('SPECIMEN, DREW MD').evidence).toEqual([first('SPECIMEN, DREW MD')]);
    expect(of('D SPECIMEN').evidence).toEqual([first('Drew Specimen, MD'), first('SPECIMEN, DREW MD')]);
  });

  it("have it for a claim without its fields too, by the claim's title", () => {
    const first = (printed: string) => ({ from: 'first_name', printed });
    const label = { name: 'A', confidence: 'likely', evidence: [first('Ann A'), { from: 'only_match', state: 'FL' }, first('A, ANN')] };
    const view = (v: object) => providerLabelsOf({ person: PERSON, labels: { v_a: label }, claims: { [VISIT]: 'v_a' }, ...v }, PERSON);
    const of = (v: object, title: string) => listed(VISIT, printedOfTitle(title), true, view(v))[0]!.evidence;
    const names = { by_name: { 'Ann A': 'v_a', 'A, ANN': 'v_a', 'ANN A': 'v_a', B: 'v_b' } };
    const only = { from: 'only_match', state: 'FL' };
    expect(of(names, 'Sample service \u00b7 Ann A')).toEqual([first('Ann A'), only]);
    expect(of(names, 'A, ANN')).toEqual([only, first('A, ANN')]);
    // A text that is not one that told, and a title that does not say which.
    for (const title of ['Sample service \u00b7 ANN A', 'Sample service', 'Sample service \u00b7 XAnn A', 'Ann A \u00b7 Sample service']) expect(of(names, title), title).toEqual(label.evidence);
    // The one text there is needs no title.
    expect(of({ by_name: { 'A, ANN': 'v_a' } }, 'Sample service')).toEqual([only, first('A, ANN')]);
    // An item's own texts come first: one the item has another label for is not it.
    expect(of({ by_name: { 'Ann A': 'v_a', 'A, ANN': 'v_a' }, by_item: { [VISIT]: { 'Ann A': 'v_b' } } }, 'Sample service')).toEqual([only, first('A, ANN')]);
    expect(of({ by_item: { [VISIT]: { 'Ann A': 'v_a', 'A, ANN': 'v_a' } } }, 'Sample service \u00b7  Ann A')).toEqual(label.evidence);
    expect(of({ by_item: { [VISIT]: { ' Ann A ': 'v_a', 'A, ANN': 'v_a' } } }, 'Sample service \u00b7 Ann A')).toEqual(label.evidence);
    expect(of({ by_item: { [VISIT]: { 'Ann A': 'v_a', 'A, ANN': 'v_a' } } }, 'Sample service \u00b7 Ann A')).toEqual([first('Ann A'), only]);
    // A title has its provider trimmed.
    const spaced = { ...label, evidence: [first(' Ann A '), first('A, ANN')] };
    for (const title of ['Ann A', 'Sample service \u00b7 Ann A']) {
      expect(of({ labels: { v_a: spaced }, by_name: { ' Ann A ': 'v_a', 'A, ANN': 'v_a' } }, title), title).toEqual([first(' Ann A ')]);
      // So it does not say which of two that differ by that.
      expect(of({ labels: { v_a: spaced }, by_name: { ' Ann A ': 'v_a', 'Ann A': 'v_a', 'A, ANN': 'v_a' } }, title), title).toEqual(spaced.evidence);
    }
    // A private one's are looked up in `private`.
    const priv = providerLabelsOf({ person: PERSON, by_name: { 'Ann A': 'v_a' }, private: { labels: { v_a: label }, claims: { [TALK]: 'v_a' }, by_name: { 'Ann A': 'v_a', 'A, ANN': 'v_a' } } }, PERSON);
    expect(listed(TALK, printedOfTitle('A, ANN'), false, priv)[0]!.evidence).toEqual([only, first('A, ANN')]);
  });

  it('are looked up exactly as printed, and by the item first', () => {
    expect(shown(VISIT, 'J Sample', true)).toEqual([]);
    expect(shown('r_otheraaaaaaaaaaaaaaa', 'J SAMPLE', true)[0]!.name).toBe('Jamie Sample, DO');
  });

  it('leave out what the item says by itself', () => {
    expect(listed(VISIT, [{ field: 'provider', text: 'J SAMPLE', shown: false }], true)[0]).not.toHaveProperty('printed');
  });

  it("are another person's, or none, when the file is", () => {
    expect(providerLabelsOf(reader, 'p_otheraaaaaaaaaaaaaaa')).toBe(NO_LABELS);
    expect(shown(VISIT, 'J SAMPLE', true, NO_LABELS)).toEqual([]);
  });

  it("show a private item's only in an answer about the person", () => {
    expect(shown(TALK, 'C EXAMPLE', false)[0]!.role).toBe('therapist');
    expect(shown(TALK, 'C EXAMPLE', true)).toEqual([]);
    // An open item has nothing of what only private ones say.
    expect(shown(VISIT, 'C EXAMPLE', false)).toEqual([]);
    // A private one's label that open items have too is in `labels`.
    expect(shown(TALK, 'J SAMPLE', false)[0]!.name).toBe('Jordan Sample, MD');
    // And an open item's label is never one only private items have.
    const crossed = { person: PERSON, labels: {}, by_name: { X: 'v_a' }, private: { labels: { v_a: { name: 'A', confidence: 'sure', evidence: [] } } } };
    expect(shown(VISIT, 'X', false, providerLabelsOf(crossed, PERSON))).toEqual([]);
    // A name only open items print is not a private one's.
    expect(shown(TALK, 'M TEMPLATE', false)).toEqual([]);
  });

  it("look an event's member up as itself", () => {
    const member = (record: string, text: string): Printed => ({ field: 'members', text, member: record, shown: true });
    const event: Printed[] = [{ field: 'place', text: 'J SAMPLE', shown: true }, member(VISIT, 'J SAMPLE'), member(TALK, 'C EXAMPLE')];
    const of = (whole: boolean) => listed('e_eventaaaaaaaaaaaaaa', event, whole).map((l) => [l.field, l.record]);
    // One that prints the same and has another label is listed too.
    expect(listed('e_eventaaaaaaaaaaaaaa', [...event, member('r_otheraaaaaaaaaaaaaaa', 'J SAMPLE')], true).map((l) => l.name)).toEqual(['Jordan Sample, MD', 'Jamie Sample, DO']);
    // The member prints the same as the place, with the same label: one.
    expect(of(true)).toEqual([['place', undefined]]);
    expect(of(false)).toEqual([
      ['place', undefined],
      ['members', TALK],
    ]);
  });

  it('are none on an item an answer about the household holds back', () => {
    expect(labels.shown(VISIT, [{ field: 'provider', text: 'J SAMPLE', shown: true }], { whole: true, isPrivate: () => false, heldBack: () => true })).toEqual([]);
    expect(labels.shown(VISIT, [{ field: 'provider', text: 'J SAMPLE', shown: true }], { whole: false, isPrivate: () => false, heldBack: () => true })).toHaveLength(1);
    // Nor on an event's open members, when the event is held back.
    const event = 'e_eventaaaaaaaaaaaaaa';
    const members: Printed[] = [{ field: 'members', text: 'J SAMPLE', member: VISIT, shown: true }];
    const held = (whole: boolean) => labels.shown(event, members, { whole, isPrivate: () => false, heldBack: (id) => id === event });
    expect([held(true).length, held(false).length]).toEqual([0, 1]);
  });

  it('give no reason an answer may not', () => {
    // Its one paper is private: no label about the household, and one about the person.
    expect(shown(VISIT, 'R PLACEHOLDER', true)).toEqual([]);
    const about = shown(VISIT, 'R PLACEHOLDER', false)[0]!;
    expect(about.evidence).toEqual([paper]);
    expect(about.phone_from).toEqual(paper);
    // With another reason it is shown without that one, and without a phone nothing it may name gives.
    const both = shown(VISIT, 'M TEMPLATE', true)[0]!;
    expect(both.evidence).toEqual([
      { from: 'only_match', state: 'FL' },
      { from: 'paper', document: OPEN },
    ]);
    expect(both).not.toHaveProperty('phone');
    expect(both).not.toHaveProperty('phone_from');
    // What the household said of private items only is not said to be.
    const said = shown(VISIT, 'P DUMMY', true)[0]!;
    expect([said.confidence, said.evidence]).toEqual(['household', []]);
    expect(said).not.toHaveProperty('phone');
    const own = shown(VISIT, 'P DUMMY', false)[0]!;
    expect((own.evidence as JsonObject[])[0]!.by).toBe('Robin Example');
    expect(own.phone).toBe('555-010-0166');
  });

  it('read what a later medrec writes as likely', () => {
    expect(shown(VISIT, 'L FILLER', true)).toEqual([
      { field: 'provider', printed: 'L FILLER', name: 'Lee Filler', confidence: 'likely', evidence: [{ from: 'telepathy' }] },
    ]);
  });

  it("find a claim's provider without its words", () => {
    const claims = { person: PERSON, labels: { v_a: { name: 'A', confidence: 'sure', evidence: [] } }, claims: { [VISIT]: 'v_a' }, private: { claims: { [TALK]: 'v_a' } } };
    const of = (item: string, whole: boolean) => listed(item, printedOfTitle('Sample service'), whole, providerLabelsOf(claims, PERSON));
    const entry = { field: 'provider', name: 'A', confidence: 'sure', evidence: [] };
    expect(of(VISIT, true)).toEqual([entry]);
    expect(of(TALK, false)).toEqual([entry]);
    expect(of(TALK, true)).toEqual([]);
    expect(of('r_otheraaaaaaaaaaaaaaa', true)).toEqual([]);
  });

  it('find nothing by a name every object has', () => {
    for (const text of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(shown(VISIT, text, false), text).toEqual([]);
      expect(shown(text, 'J SAMPLE', false)[0]!.name, text).toBe('Jordan Sample, MD');
    }
    const named = providerLabelsOf(JSON.parse('{"person":"p_x","labels":{"v_a":{"name":"A","confidence":"sure"}},"by_name":{"__proto__":"v_a"}}'), 'p_x');
    expect(shown(VISIT, '__proto__', true, named)[0]!.name).toBe('A');
  });

  it('are none where the file is not of its shape', () => {
    const entry = { name: 'A', confidence: 'sure', evidence: [{ from: 'npi' }] };
    for (const v of [
      {},
      { labels: [entry], by_name: { X: 0 } },
      { labels: { v_a: 'A' }, by_name: { X: 'v_a' } },
      { labels: { v_a: [entry] }, by_name: { X: 'v_a' } },
      { labels: { v_a: entry }, by_name: ['X'] },
      { labels: { v_a: entry }, by_name: { X: { id: 'v_a' } } },
      { labels: { v_a: entry }, by_item: { [VISIT]: 'v_a' } },
      { labels: { v_a: entry }, by_name: { X: 'v_b' } },
      { labels: null, by_name: null, by_item: null, claims: null, overrides: null, private: null },
      { labels: { v_a: { ...entry, confidence: 'likely', evidence: 'npi' } }, by_name: { X: 'v_a' } },
      { labels: { v_a: { ...entry, confidence: 'likely', evidence: [5, null, { from: 5 }, { from: 'paper' }, { from: 'household' }] } }, by_name: { X: 'v_a' } },
    ]) {
      expect(shown(VISIT, 'X', false, providerLabelsOf({ person: PERSON, ...v }, PERSON)), JSON.stringify(v)).toEqual([]);
    }
    const odd = { labels: { v_a: { name: 5, role: 'r', phone: 5, phone_from: { from: 'directory', date: '2026-01-01' }, confidence: 'sure', evidence: null } }, by_name: { X: 'v_a' } };
    const bits = { labels: { v_a: { confidence: 'sure', evidence: [{ from: 'only_match', state: 5 }, { from: 'npi', other: 'x' }] } }, by_name: { X: 'v_a' } };
    expect(shown(VISIT, 'X', false, providerLabelsOf({ person: PERSON, ...bits }, PERSON))[0]!.evidence).toEqual([{ from: 'only_match' }, { from: 'npi' }]);
    expect(shown(VISIT, 'X', false, providerLabelsOf({ person: PERSON, ...odd }, PERSON))).toEqual([{ field: 'provider', printed: 'X', role: 'r', confidence: 'sure', evidence: [] }]);
  });

  it('show a phone only with where it is from', () => {
    const of = (phone_from: unknown) => shown(VISIT, 'X', false, providerLabelsOf({ person: PERSON, labels: { v_a: { confidence: 'sure', phone: '555-010-0100', phone_from } }, by_name: { X: 'v_a' } }, PERSON))[0]!;
    expect(of({ from: 'directory', date: '2026-01-01', other: 'x' }).phone_from).toEqual({ from: 'directory', date: '2026-01-01' });
    expect(of({ from: 'directory' }).phone).toBe('555-010-0100');
    expect(of({ from: 'paper', document: OPEN }).phone_from).toEqual({ from: 'paper', document: OPEN });
    for (const v of [undefined, null, 'directory', {}, { from: 'a later one' }, { from: 'npi' }, { from: 'paper' }, { from: 'household', id: 'o_notsaid' }]) expect(of(v), JSON.stringify(v)).not.toHaveProperty('phone');
  });
});

describe('what is printed', () => {
  it('in a record is listed once, in a set order', () => {
    expect(printedOfRecord({ location: 'A', provider: 'B', code: 'C', facility: ['D'] } as JsonObject).map((p) => [p.field, p.text, p.shown])).toEqual([
      ['provider', 'B', true],
      ['location', 'A', true],
    ]);
    expect(printedOfRecord({ pharmacy: '8', location: '7', facility: '6', service_provider: '5', prescriber: '4', performer: '3', practitioner: '2', provider: '1' }).map((p) => p.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect([printedOfRecord(undefined), printedOfRecord(null)]).toEqual([[], []]);
  });

  it("in a claim's row is its provider", () => {
    expect(printedOfClaim({ provider: 'A', facility: 'B' })).toEqual([{ field: 'provider', text: 'A', shown: false }]);
    expect([printedOfClaim({ provider: 5 as never }), printedOfClaim(undefined), printedOfClaim(null)]).toEqual([[], [], []]);
  });

  it('in a document is its organization', () => {
    expect(printedOfDocument('A')).toEqual([{ field: 'organization', text: 'A', shown: true }]);
    expect([printedOfDocument(undefined), printedOfDocument(null)]).toEqual([[], []]);
  });

  it("in an event is its place and clinicians, and in full its own members' providers", () => {
    const e = {
      place: 'A',
      clinicians: ['B', 5, 'C'],
      members: [
        { record: 'r_visit', provider: 'B' },
        { record: 'r_talk', person: 'p_other', provider: 'D' },
        { document: 'd_open', title: 'E' },
        { record: 'r_none' },
        { document: 'd_open', provider: 'F' },
        'G',
      ],
    } as JsonObject;
    const of = (full: boolean) => printedOfEvent(e, full).map((p) => [p.field, p.text, p.member]);
    const short = [
      ['place', 'A', undefined],
      ['clinicians', 'B', undefined],
      ['clinicians', 'C', undefined],
    ];
    expect(of(false)).toEqual(short);
    expect(of(true)).toEqual([...short, ['members', 'B', 'r_visit']]);
    expect(printedOfEvent({ place: 5, clinicians: 'B', members: {} } as JsonObject, true)).toEqual([]);
    // Text is text, though it says nothing.
    expect(printedOfEvent({ place: '' } as JsonObject, true).map((p) => p.text)).toEqual(['']);
  });
});

describe("over medrec's own folder", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-labels-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  type Label = JsonObject & { field: string };
  type Item = { id: string; kind: string; private?: string; source?: string; provider_labels?: Label[] };
  type Page = { items: Item[]; next_cursor?: string; truncated?: boolean; warnings?: { code: string; message: string }[] };
  let n = 0;
  /** The folder with views as medrec writes them, after a change to its one person's index. */
  function folder(change: (index: { records: Record<string, any>[]; documents: Record<string, any>[] }) => void = () => {}, providers?: (v: any) => void): string {
    const root = labelsFolder(join(scratch, `f${n++}`));
    const at = join(root, 'Robin Example/index.json');
    const index = JSON.parse(readFileSync(at, 'utf8'));
    change(index);
    writeFileSync(at, JSON.stringify(index));
    writeViewsAt(root);
    addDerived(root, 'labels');
    if (providers) {
      const file = join(import.meta.dirname, `fixtures/providers/labels/${PERSON}.json`);
      const v = JSON.parse(readFileSync(file, 'utf8'));
      providers(v);
      put(root, v);
    }
    return root;
  }
  function put(root: string, v: unknown, person = PERSON): void {
    const body = JSON.stringify(v);
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(person) + storedName('providers.json', sum)), body);
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    index.people[person]!.files['providers.json'] = sum;
    writeFileSync(at, JSON.stringify(index));
  }
  /** A person's providers.json, made `size` bytes long. */
  function sized(root: string, size: number, person = PERSON): void {
    const index = JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex;
    const { more: _, ...v } = JSON.parse(readFileSync(join(root, personDir(person) + storedName('providers.json', index.people[person]!.files['providers.json']!)), 'utf8'));
    put(root, { ...v, more: 'x'.repeat(size - JSON.stringify({ ...v, more: '' }).length) }, person);
  }
  async function ask(root: string, name: string, args: Record<string, unknown>, store?: (s: ViewsStore) => ViewsStore) {
    const source = new LocalSource(root);
    const views = new ViewsStore(new Folder(source, new ParsedCache(), root));
    const r = (await callTool(name, args, { store: store ? store(views) : views, today: '2026-11-25' }))!;
    if (r.isError) throw new Error(r.content[0]!.text);
    return { out: r.structuredContent as unknown as Page, read: source.readPaths };
  }
  const list = async (root: string, args: Record<string, unknown>) => (await ask(root, 'medrec_records', { limit: 100, ...args })).out;
  const of = (p: Page, id: string) => p.items.find((i) => i.id === id)?.provider_labels;
  const SAMPLE = 'r_samplevisitaaaaaaaaa';
  const TALK = 'r_talkaaaaaaaaaaaaaaaa';
  const PORTAL = 'r_sampleportalaaaaaaaa';
  const BILL = 'd_billaaaaaaaaaaaaaaaa';
  const BOTH = 'r_privatebothaaaaaaaaa';
  const COUNSELING = 'd_counselingaaaaaaaaaa';
  const root = folder();

  it('a claim has its provider, without the words its title says', async () => {
    const claims = await list(root, { kind: 'claims' });
    expect(of(claims, SAMPLE)).toEqual([
      { field: 'provider', name: 'Jordan Sample, MD', role: 'family doctor', phone: '555-010-0101', phone_from: { from: 'directory', date: '2026-03-08' }, confidence: 'sure', evidence: [{ from: 'npi' }] },
    ]);
    expect(of(claims, 'r_twomatchesaaaaaaaaaa')).toBeUndefined();
    expect(of(await list(root, { kind: 'claims', response_format: 'detailed' }), SAMPLE)![0]!.printed).toBe('J SAMPLE');
    // The timeline's, found by the claim alone.
    expect(of(await list(root, { kind: 'timeline' }), SAMPLE)).toEqual(of(claims, SAMPLE));
  });

  it('any other record has them only in full', async () => {
    for (const kind of ['visits', 'timeline']) expect(of(await list(root, { kind, person: 'Robin' }), PORTAL), kind).toBeUndefined();
    expect(of(await list(root, { kind: 'visits', person: 'Robin', response_format: 'detailed' }), PORTAL)!.map((l) => [l.field, l.printed])).toEqual([
      ['practitioner', 'Jordan Sample, MD'],
      ['service_provider', 'Example Primary Care'],
    ]);
    expect(of(await list(root, { kind: 'timeline', person: 'Robin', response_format: 'detailed' }), PORTAL)).toBeUndefined();
    const too = folder((x) => (x.records.find((r) => r.id === PORTAL)!.fields.provider = 'J SAMPLE'));
    expect(of(await list(too, { kind: 'visits', person: 'Robin' }), PORTAL)).toBeUndefined();
  });

  it('a private item has them only in an answer about the person', async () => {
    const about = await list(root, { kind: 'claims', person: 'Robin' });
    expect(about.items.find((i) => i.id === TALK)!.private).toBe('mental_health');
    expect(of(about, TALK)![0]!.role).toBe('psychologist');
    // One whose reason is a private paper gives it there.
    expect(of(about, BOTH)).toEqual([{ field: 'provider', practice: 'Example Counseling Center', confidence: 'likely', evidence: [{ from: 'paper', document: 'd_counselingtwoaaaaaaa' }] }]);
    const named = await list(root, { kind: 'claims', name: 'Sample service' });
    expect(named.items.find((i) => i.id === TALK)!.private).toBe('mental_health');
    expect(named.items.find((i) => i.id === BOTH)!.private).toBe('household');
    expect([of(named, TALK), of(named, BOTH)]).toEqual([undefined, undefined]);
    expect(of(named, SAMPLE)).toBeDefined();
  });

  it('a document has its organization, wherever it is listed or read', async () => {
    for (const kind of ['documents', 'bills', 'timeline']) {
      const p = await list(root, { kind });
      expect(of(p, BILL)!.map((l) => [l.field, l.printed, l.name, l.confidence, (l.phone_from as JsonObject).from]), kind).toEqual([['organization', 'Example Family Practice', 'Our practice', 'household', 'household']]);
      expect(p.items.find((i) => i.id === BILL)!.source, kind).toBe('Example Family Practice');
    }
    const { out } = await ask(root, 'medrec_document', { id: BILL });
    expect((out as unknown as Item).provider_labels![0]!.name).toBe('Our practice');
  });

  it('medrec_document names no person, so a private one has none', async () => {
    const printed = folder((x) => x.documents.forEach((d) => (d.organization = 'J SAMPLE')), (v) => (v.private.by_name['J SAMPLE'] = v.by_name['J SAMPLE']));
    expect(of(await list(printed, { kind: 'documents', person: 'Robin' }), COUNSELING)![0]!.name).toBe('Jordan Sample, MD');
    const read = async (id: string) => (await ask(printed, 'medrec_document', { id })).out as unknown as Item;
    expect((await read(COUNSELING)).private).toBe('mental_health');
    expect((await read(COUNSELING)).provider_labels).toBeUndefined();
    expect((await read(BILL)).provider_labels).toHaveLength(1);
  });

  it("an event has its place and clinicians, and in full its members'", async () => {
    const events = (await list(root, { kind: 'events', person: 'Robin' })).items;
    const fields = (xs: Item[]) => new Set(xs.flatMap((i) => i.provider_labels ?? []).map((l) => l.field));
    expect(fields(events)).toEqual(new Set(['place', 'clinicians']));
    const full = (await list(root, { kind: 'events', person: 'Robin', response_format: 'detailed' })).items;
    expect(fields(full)).toEqual(new Set(['place', 'clinicians', 'members']));
    const one = full.find((i) => i.provider_labels?.some((l) => l.field === 'members'))!;
    expect((await list(root, { kind: 'events', id: one.id })).items[0]!.provider_labels).toEqual(one.provider_labels);
  });

  it('nothing is found by one, and search and the summary have none', async () => {
    for (const q of ['Our practice', 'psychologist', 'family doctor']) {
      for (const kind of ['claims', 'documents', 'bills', 'events', 'timeline']) expect((await list(root, { kind, name: q, person: 'Robin' })).items, `${kind} ${q}`).toEqual([]);
    }
    for (const [name, args] of [
      ['medrec_search', { query: 'sample' }],
      ['medrec_search', { query: 'Our practice' }],
      ['medrec_summary', { person: 'Robin' }],
      ['medrec_records', { kind: 'results' }],
      ['medrec_records', { kind: 'visits' }],
    ] as const) {
      const { out, read } = await ask(root, name, args);
      expect(JSON.stringify(out)).not.toContain('provider_labels');
      expect(read.some((f) => f.includes('providers.')), `${name} ${JSON.stringify(args)}`).toBe(false);
    }
  });

  it('a person none of whose items on the page prints a provider costs no read', async () => {
    const none = folder((x) => x.records.forEach((r) => delete r.fields.provider));
    expect((await ask(none, 'medrec_records', { kind: 'claims' })).read.some((f) => f.includes('providers.'))).toBe(false);
    expect((await ask(root, 'medrec_records', { kind: 'claims' })).read.filter((f) => f.includes('providers.')).map((f) => relative('views', f).split('/')[0])).toEqual([PERSON]);
    // Nor does one past the page.
    const past = folder((x) => delete x.records.reduce((a, b) => (a.kind === 'claim' && (b.kind !== 'claim' || a.date > b.date) ? a : b)).fields.provider);
    const top = await ask(past, 'medrec_records', { kind: 'claims', person: 'Robin', limit: 1 });
    expect([top.out.items.length, top.out.next_cursor !== undefined, top.read.some((f) => f.includes('providers.'))]).toEqual([1, true, false]);
    // A later page's are its own.
    const all = (await list(root, { kind: 'claims' })).items.length;
    const first = await list(root, { kind: 'claims', limit: all - 1 });
    expect(of(await list(root, { kind: 'claims', limit: all - 1, cursor: first.next_cursor }), 'r_officevisitaaaaaaaaa')).toBeDefined();
  });

  it('views that are not current give none, with no warning of their own', async () => {
    const none = async (change: (root: string) => void) => {
      const at = folder();
      change(at);
      const p = await list(at, { kind: 'claims', person: 'Robin' });
      expect(p.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(p)).not.toContain('provider_labels');
      return (p.warnings ?? []).map((w) => w.code);
    };
    const edit = (change: (v: ViewsIndex['people'][string]) => void) => (at: string) => {
      const index = JSON.parse(readFileSync(join(at, VIEWS_INDEX), 'utf8')) as ViewsIndex;
      change(index.people[PERSON]!);
      writeFileSync(join(at, VIEWS_INDEX), JSON.stringify(index));
    };
    for (const f of ['marks.json', 'provider-state.json', 'index.json']) expect(await none((at) => appendFileSync(join(at, 'Robin Example', f), ' ')), f).toEqual(['private-not-prepared']);
    expect(await none((at) => rmSync(join(at, 'Robin Example/provider-state.json')))).toEqual(['private-not-prepared']);
    expect(await none(edit((v) => delete v.files['providers.json']))).toEqual([]);
    expect(await none((at) => put(at, { schema: 'medrec-providers/v2', person: PERSON, labels: {} }))).toEqual([]);
    expect(await none((at) => put(at, { ...JSON.parse(readFileSync(join(import.meta.dirname, `fixtures/providers/labels/${PERSON}.json`), 'utf8')), person: 'p_otheraaaaaaaaaaaaaaa' }))).toEqual([]);
    // Another pass's, still arriving.
    expect(await none(edit((v) => (v.files['providers.json'] = '0'.repeat(32))))).toEqual([]);
  });

  it('a read of them that fails is never worth the answer', async () => {
    const instead = (providerLabels: () => Promise<LabelsFile>) => (s: ViewsStore) => Object.assign(Object.create(s), { providerLabels }) as ViewsStore;
    const unfound = (e: Error) => instead(() => Promise.reject(e));
    const unread = (e: Error) => instead(async () => ({ size: 1, read: () => Promise.reject(e) }));
    const whole = (await ask(root, 'medrec_records', { kind: 'claims', limit: 100 })).out;
    const bare = { ...whole, items: whole.items.map(({ provider_labels: _, ...i }) => i) };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (x) => void errors.push(x);
    try {
      for (const failing of [unfound, unread]) expect((await ask(root, 'medrec_records', { kind: 'claims', limit: 100 }, failing(ToolError.upstream('Drive is away')))).out).toEqual(bare);
      expect(errors).toEqual([]);
      for (const failing of [unfound, unread]) expect((await ask(root, 'medrec_records', { kind: 'claims', limit: 100 }, failing(new TypeError('a record')))).out).toEqual(bare);
      expect(((await ask(root, 'medrec_document', { id: BILL }, unread(new TypeError('a record')))).out as unknown as Item).provider_labels).toBeUndefined();
    } finally {
      console.error = log;
    }
    // The class alone: a message could quote a record.
    expect(errors).toEqual(Array.from({ length: 3 }, () => 'provider labels failed: TypeError'));
  });

  it('a providers.json that could cost the answer is not read', async () => {
    for (const [size, labels] of [
      [LABELS_LIMIT, 1],
      [LABELS_LIMIT + 1, undefined],
    ] as const) {
      const at = folder();
      sized(at, size);
      const { out, read } = await ask(at, 'medrec_records', { kind: 'claims', limit: 100 });
      expect([of(out, SAMPLE)?.length, read.some((x) => x.includes('providers'))]).toEqual([labels, labels !== undefined]);
      const not = labels ? [] : [{ code: 'provider-labels-not-read', message: "Robin Example's provider_labels are left out of this page: they are more than one answer reads" }];
      expect(out.warnings ?? []).toEqual([...((await list(root, { kind: 'claims' })).warnings ?? []), ...not]);
      // A page with nothing of theirs to say does not say so.
      expect((await list(at, { kind: 'conditions' })).warnings ?? []).toEqual((await list(root, { kind: 'conditions' })).warnings ?? []);
    }
  });

  describe('of several people', () => {
    const several = synth(join(scratch, 'several'));
    writeViewsAt(several);
    addDerived(several, 'large');
    labelClaims(several, 10);
    const { people } = JSON.parse(readFileSync(join(several, 'household.json'), 'utf8')) as { people: { id: string; name: string }[] };
    const id = (name: string) => people.find((p) => p.name === name)!.id;
    const owners = (items: Item[]) => new Set(items.map((i) => id((i as Item & { person: string }).person)));
    const readOf = (read: string[]) => read.filter((f) => f.includes('providers.')).map((f) => f.split('/').at(-2)!);

    it('only those who can be on a page cut by its size cost a read', async () => {
      const args = { kind: 'events', limit: 200, response_format: 'detailed' };
      const { out, read } = await ask(several, 'medrec_records', args);
      expect(out.truncated).toBe(true);
      expect(new Set(readOf(read))).toEqual(owners(out.items));
      // The next items, which a page of 200 that had room for them would hold, are of others too.
      expect(owners((await list(several, { kind: 'events', limit: 200 })).items).size).toBeGreaterThan(owners(out.items).size);
    });

    it('nor does the one whose item fills it', async () => {
      const store = new ViewsStore(new Folder(new LocalSource(several), new ParsedCache(), several));
      const unlabelled = Object.assign(Object.create(store), { providerLabels: async () => null }) as ViewsStore;
      const get = async (s: ViewsStore, args: object) => (await callTool('medrec_records', { kind: 'events', limit: 200, ...args }, { store: s, today: '2026-11-25' }))!;
      const all = (r: Awaited<ReturnType<typeof get>>) => r.structuredContent as unknown as Page & { items: { date: string }[] };
      // Until the item after a page is someone's who has none on it, and has labels.
      for (const { date: until } of all(await get(store, {})).items) {
        const whole = await get(unlabelled, { until, response_format: 'detailed' });
        // An event that alone is larger than a page is refused.
        if (whole.isError || !all(whole).truncated) continue;
        const page = owners(all(whole).items);
        const listed = all(await get(store, { until })).items;
        expect(all(whole).items.map((e) => e.id)).toEqual(listed.slice(0, all(whole).items.length).map((e) => e.id));
        const next = listed[all(whole).items.length]!;
        if (next.provider_labels === undefined || page.has([...owners([next])][0]!)) continue;
        const { read } = await ask(several, 'medrec_records', { kind: 'events', limit: 200, until, response_format: 'detailed' });
        expect(readOf(read).filter((p) => !page.has(p))).toEqual([]);
        return;
      }
      throw new Error('no page is followed by such an item');
    });

    it('as many as have room together are read, in the order of the household', async () => {
      const codes = ((await list(several, { kind: 'claims', limit: 200 })).warnings ?? []).map((w) => w.code);
      const [robin, sam, alex] = ['Robin Example', 'Sam Example', 'Alex Example'].map(id) as [string, string, string];
      for (const [sizes, read] of [
        [[LABELS_LIMIT - 60_000, 30_000, 30_000], [robin, sam, alex]],
        [[LABELS_LIMIT - 60_000, 30_000, 30_001], [robin, sam]],
        [[LABELS_LIMIT - 60_000, 60_001, 30_000], [robin, alex]],
        [[LABELS_LIMIT + 1, LABELS_LIMIT, 30_000], [sam]],
      ] as const) {
        [robin, sam, alex].forEach((p, i) => sized(several, sizes[i]!, p));
        const { out, read: files } = await ask(several, 'medrec_records', { kind: 'claims', limit: 200 });
        expect(owners(out.items)).toEqual(new Set([robin, sam, alex]));
        expect([readOf(files).sort(), owners(out.items.filter((i) => i.provider_labels))]).toEqual([[...read].sort(), new Set(read)]);
        const not = [robin, sam, alex].flatMap((p, i) => {
          const { name } = people.find((q) => q.id === p)!;
          const why = sizes[i]! > LABELS_LIMIT ? 'they are more than one answer reads' : `those of the others on it are as many as one answer reads. Ask about ${name} alone for them`;
          return (read as readonly string[]).includes(p) ? [] : [{ code: 'provider-labels-not-read', message: `${name}'s provider_labels are left out of this page: ${why}` }];
        });
        expect(out.warnings!.slice(0, codes.length).map((w) => w.code)).toEqual(codes);
        expect(out.warnings!.slice(codes.length)).toEqual(not);
      }
    });
  });

  it('answers from the files have none', async () => {
    const r = await callTool('medrec_records', { kind: 'claims', person: 'Robin' }, { store: new RawStore(folderAt(root)), today: '2026-11-25' });
    expect(JSON.stringify(r!.structuredContent)).not.toContain('provider_labels');
  });

  describe('on a page', () => {
    const many = (n: number, provider: (i: number) => string) =>
      folder(
        (x) => {
          const claim = x.records.find((r) => r.id === SAMPLE)!;
          for (let i = 0; i < n; i++) x.records.push({ ...structuredClone(claim), id: `r_many${String.fromCharCode(97 + Math.floor(i / 20), 97 + (i % 20))}aaaaaaaaaaaaaa`, key: `claim|many${i}`, fields: { ...claim.fields, provider: provider(i) } });
        },
        (v) => {
          for (let i = 0; i < n; i++) v.by_name[provider(i)] = v.by_name['J SAMPLE'];
        },
      );

    it('they count in its size', async () => {
      const at = many(190, () => 'J SAMPLE');
      let args: Record<string, unknown> = { kind: 'claims', person: 'Robin', limit: 200 };
      const seen: string[] = [];
      for (;;) {
        const p = await list(at, args);
        expect(chars(JSON.stringify(p))).toBeLessThanOrEqual(SIZE_BUDGET);
        for (const i of p.items) if (i.id.startsWith('r_many')) expect(i.provider_labels).toHaveLength(1);
        seen.push(...p.items.map((i) => i.id));
        if (p.next_cursor === undefined) break;
        expect(p.truncated).toBe(true);
        args = { ...args, cursor: p.next_cursor };
      }
      expect(seen.filter((id) => id.startsWith('r_many'))).toHaveLength(190);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('they are looked up only until they fill it', async () => {
      const at = many(190, () => 'J SAMPLE');
      let looked = 0;
      const counting = (s: ViewsStore) =>
        Object.assign(Object.create(s), {
          providerLabels: async (...a: Parameters<ViewsStore['providerLabels']>) => {
            const { size, read } = (await s.providerLabels(...a))!;
            return {
              size,
              read: async () => {
                const labels = await read();
                const { shown } = labels;
                labels.shown = (...b) => (looked++, shown.apply(labels, b));
                return labels;
              },
            };
          },
        }) as ViewsStore;
      const { out } = await ask(at, 'medrec_records', { kind: 'claims', person: 'Robin', limit: 200 }, counting);
      expect(out.truncated).toBe(true);
      expect([looked >= out.items.length, looked < 200]).toEqual([true, true]);
      expect((await list(at, { kind: 'claims', person: 'Robin', limit: 200 })).items).toEqual(out.items);
    });

    it('a label yields to a record it does not fit beside, and the page says so', async () => {
      const name = (i: number) => `J SAMPLE ${i}`;
      for (const [members, all] of [
        [10, true],
        [120, false],
      ] as const) {
        const at = many(members, name);
        const id = 'e_bigeventaaaaaaaaaaaa';
        const event = { id, kind: 'visit', start: '2025-02-04', end: '2025-02-04', title: 'Sample visit', place: 'J SAMPLE', members: Array.from({ length: members }, (_, i) => ({ record: `r_member${i}`, kind: 'claim', title: 'Sample service', provider: name(i) })) };
        const store = (s: ViewsStore) => Object.assign(Object.create(s), { events: async () => [event] }) as ViewsStore;
        for (const args of [{ kind: 'events', id }, { kind: 'events', person: 'Robin', response_format: 'detailed' }]) {
          const { out } = await ask(at, 'medrec_records', args, store);
          const labels = out.items[0]!.provider_labels!;
          expect(chars(JSON.stringify(out.items[0])) + 3 + ENVELOPE_RESERVE).toBeLessThanOrEqual(SIZE_BUDGET);
          const warned = (out.warnings ?? []).filter((w) => w.code === 'provider-labels-left-out');
          if (all) {
            expect(labels).toHaveLength(members + 1);
            expect(warned).toEqual([]);
          } else {
            expect(labels.length).toBeLessThan(members + 1);
            // One more would not have fitted.
            expect(chars(JSON.stringify(out.items[0])) + chars(JSON.stringify(labels.at(-1))) + 1 + 3 + ENVELOPE_RESERVE).toBeGreaterThan(SIZE_BUDGET);
            expect(labels.map((l) => l.printed)).toEqual(['J SAMPLE', ...Array.from({ length: labels.length - 1 }, (_, i) => name(i))]);
            expect(warned).toEqual([{ code: 'provider-labels-left-out', message: '1 item on this page: some of the provider_labels did not fit and are left out, the rest of it is whole' }]);
            expect(out.warnings![0]!.code).toBe('provider-labels-left-out');
          }
        }
      }
    });

    it.each(['Jordan Sample, MD', '\u{1F600}'.repeat(40), 'J\u00f6rdan "Sample" \\ MD'])('a label that fills a page beside its item to the character is shown (%s)', async (name) => {
      const ask1 = async (pad: number) => {
        const at = folder((x) => (x.records.find((r) => r.id === SAMPLE)!.fields.extra = 'x'.repeat(pad)), (v) => (v.labels[v.by_name['J SAMPLE']].name = name));
        const p = await list(at, { kind: 'claims', person: 'Robin', response_format: 'detailed', since: '2025-02-04', until: '2025-02-04' });
        expect(p.items.map((i) => i.id)).toEqual([SAMPLE]);
        return p;
      };
      const short = await ask1(10);
      expect(of(short, SAMPLE)![0]!.name).toBe(name);
      const fits = 10 + SIZE_BUDGET - ENVELOPE_RESERVE - 3 - chars(JSON.stringify(short.items[0]));
      expect([of(await ask1(fits), SAMPLE)?.length, of(await ask1(fits + 1), SAMPLE)?.length]).toEqual([1, undefined]);
    });

    it('an item with no room for any is whole, and counted only on its own page', async () => {
      const at = folder();
      const big = (id: string, start: string, pad: number) => ({ id, kind: 'visit', start, end: start, title: 'x'.repeat(pad), place: 'J SAMPLE' });
      const events = [big('e_biggestaaaaaaaaaaaaa', '2025-02-05', 30_350), big('e_smallaaaaaaaaaaaaaaa', '2025-02-04', 10), big('e_biggesthaaaaaaaaaaaa', '2025-02-03', 30_350)];
      const store = (s: ViewsStore) => Object.assign(Object.create(s), { events: async () => events }) as ViewsStore;
      const first = (await ask(at, 'medrec_records', { kind: 'events', person: 'Robin' }, store)).out;
      expect(first.items.map((i) => [i.id, i.provider_labels?.length])).toEqual([['e_biggestaaaaaaaaaaaaa', undefined]]);
      expect(first.warnings!.map((w) => w.message)).toEqual(['1 item on this page: some of the provider_labels did not fit and are left out, the rest of it is whole']);
      const after = (await ask(at, 'medrec_records', { kind: 'events', person: 'Robin', limit: 1, cursor: first.next_cursor }, store)).out;
      expect(after.items.map((i) => [i.id, i.provider_labels?.length])).toEqual([['e_smallaaaaaaaaaaaaaaa', 1]]);
      expect(after.warnings).toBeUndefined();
    });
  });
});
