// What of an open item is private (src/records/parts.ts): out of an answer that
// names no person, and whole in one about its person.

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import type { Json, JsonObject } from '../src/records/model';
import { removed } from '../src/records/numbers';
import { OpenText, shownClaim, shownEvent, shownText } from '../src/records/parts';
import type { Privacy } from '../src/records/private';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName, type ViewsIndex } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { DEMO, addDerived, folderAt } from './support';

const PERSON = 'p_robinaaaaaaaaaaaaaaa';
const scratch = mkdtempSync(join(tmpdir(), 'oyh-parts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ask = async (root: string | ViewsStore, tool: string, args: object) => {
  const store = typeof root === 'string' ? new ViewsStore(folderAt(root)) : root;
  return (await callTool(tool, args, { store, today: '2026-11-25' }))!;
};
type Items = { items: (JsonObject & { id: string; title: string; not_shown?: string; fields?: JsonObject })[]; warnings?: { code: string; message: string }[]; next_cursor?: string };
const items = async (root: string | ViewsStore, tool: string, args: object) => (await ask(root, tool, args)).structuredContent as unknown as Items;

describe("a paper's text", () => {
  const spans = (text: string, ...lines: string[]): JsonObject => ({ text: lines.map((l) => [Buffer.byteLength(text.slice(0, text.indexOf(l))), Buffer.byteLength(l)]) });

  it('says how many lines that follow one another it is without', () => {
    const text = 'Café\nOne é\nTwo\nTotal due\fThree\nThanks';
    expect(shownText(text, spans(text, 'One é', 'Two', 'Three'))).toBe('Café\n(2 lines not shown)\nTotal due\f(1 line not shown)\nThanks');
    // A page's end is between two that are not.
    expect(shownText('One\fTwo', { text: [[0, 3], [4, 3]] })).toBe('(1 line not shown)\f(1 line not shown)');
    expect(shownText('One\n\nTwo', { text: [[0, 3], [5, 3]] })).toBe('(1 line not shown)\n\n(1 line not shown)');
    expect(shownText('One\r\nTwo', { text: [[0, 4], [5, 3]] })).toBe('(2 lines not shown)');
  });

  it('is whole without a part, and none where the lines are not its own', () => {
    expect([shownText('One', undefined), shownText('One', { text: [] })]).toEqual(['One', 'One']);
    const others: [string, Json][] = [
      ['One', [[2, 9]]],
      ['One', [[4, 0]]],
      ['One\nTwo', [[0, 5], [4, 3]]],
      ['One, two', [[5, 2], [0, 2]]],
      ['Café one', [[0, 4]]],
      ['Café one', [[4, 3]]],
      ['One', [[0.5, 1]]],
      ['One', [[-1, 2]]],
      ['One', ['0']],
      ['One', null],
    ];
    for (const [text, of] of others) expect([text, of, shownText(text, { text: of })]).toEqual([text, of, '']);
  });
});

describe('a claim', () => {
  const claim = { id: 'r_one', kind: 'claim', display: 'One and Two · Example', fields: { provider: 'Example', items: [{ sequence: 1 }, { sequence: 2 }], category: 'mixed', diagnoses: [{ sequence: 1 }], payer_notes: ['a', 'b'], visit: 'r_v' } };

  it('is shown by the lines that are left', () => {
    const shown = shownClaim(claim, { display: 'One · Example', lines: [1], payer_notes: [0], category: 'visit', says: '1 service and 1 payer note not shown' });
    expect(shown).toEqual({ ...claim, display: 'One · Example', not_shown: '1 service and 1 payer note not shown', fields: { ...claim.fields, items: [{ sequence: 1 }], payer_notes: ['b'], category: 'visit' } });
    expect(Object.keys(shown.fields!)).toEqual(Object.keys(claim.fields));
  });

  it('has no list with nothing left, its keys as medrec leaves them', () => {
    const shown = shownClaim(claim, { display: 'Claim', lines: [0, 1], diagnoses: [0], category: null, says: 's' });
    expect(Object.keys(shown.fields!)).toEqual(['provider', 'visit', 'payer_notes']);
    expect(removed({ a: 1, b: 2, c: 3 }, 'a')).toEqual({ c: 3, b: 2 });
    expect([Object.keys(removed({ a: 1, b: 2, c: 3 }, 'a')), Object.keys(removed({ a: 1, b: 2 }, 'b')), removed({ a: 1 }, 'x')]).toEqual([['c', 'b'], ['a'], { a: 1 }]);
  });

  it('has no list that its part is not of', () => {
    for (const lines of [[2], [0, 7], ['0'], [0.5]]) expect(shownClaim(claim, { display: 'One', lines, says: 's' }).fields).not.toHaveProperty('items');
  });

  it('is whole without a part', () => expect(shownClaim(claim, undefined)).toBe(claim));
});

describe('an event', () => {
  const event = { id: 'e_one', title: 'Lab', what: 'Two', place: 'Example', money: null, members: [{ record: 'r_one', title: 'One and Two' }, { document: 'd_one', title: 'x' }] } as JsonObject & { members: JsonObject[] };
  const named = (id: string) => (id === 'r_one' ? { display: 'One' } : undefined);

  it('says what its open items say, and calls a claim by its lines that are left', () => {
    expect(shownEvent(event, { kind: 'office', what: 'One', place: null, says: '1 service not shown' }, named)).toEqual({
      id: 'e_one', title: 'Lab', what: 'One', money: null, kind: 'office', not_shown: '1 service not shown', members: [{ record: 'r_one', title: 'One' }, event.members[1]],
    });
    // Its open claims may have none.
    expect(shownEvent(event, { place: null }, () => undefined)).not.toHaveProperty('not_shown');
    expect(shownEvent(event, undefined, named)).toEqual({ ...event, members: [{ record: 'r_one', title: 'One' }, event.members[1]] });
  });

  it('is whole without a part', () => expect(shownEvent(event, undefined, () => undefined)).toBe(event));
});

describe('the text a search reads', () => {
  it('is its own without the cuts, after the name it is shown by', () => {
    const own = 'Old é name\none drug two café drug three';
    const bytes = new TextEncoder().encode(own);
    const at = (s: string, from = 0) => Buffer.byteLength(own.slice(0, own.indexOf(s, from)));
    const cuts = [[0, Buffer.byteLength('Old é name\n')], [at('drug'), 5], [at('drug three'), 5]];
    const open = OpenText.of({ cuts, words: { drug: [0], one: [1, 5] }, lab: false }, 'Né w', bytes.length)!;
    const want = new TextEncoder().encode('Né w\none two café three');
    expect([open.bytes, open.lab, open.word('drug'), open.word('one'), open.word('two'), open.words('o')]).toEqual([want.length, false, { n: 0, first: Infinity }, { n: 1, first: 5 }, undefined, ['one']]);
    expect(open.moved(at('two'))).toBe(Buffer.byteLength('Né w\none '));
    for (let from = 0; from <= want.length; from++) {
      for (let to = from; to <= want.length; to++) {
        const [a, b] = open.source(from, to);
        expect([...open.read(bytes.subarray(a, b), a, from, to)]).toEqual([...want.subarray(from, to)]);
      }
    }
  });

  it("starts with its own name where that is not cut, as a paper's is", () => {
    const open = OpenText.of({ cuts: [[6, 4]] }, 'Title', 14)!;
    expect([open.bytes, open.moved(12), open.lab]).toEqual([10, 8, true]);
  });

  it('is none where the cuts are of another', () => {
    for (const cuts of [[[6, 9]], [[15, 0]], [[6, 4], [0, 2]], [[0]], undefined] as (Json | undefined)[]) expect(OpenText.of({ ...(cuts === undefined ? {} : { cuts }) }, 'Title', 14)).toBeUndefined();
  });
});

describe('answers over private parts', async () => {
  const root = ownFolder('parts', join(scratch, 'parts'), { views: true });
  // Of the private lines, diagnoses, notes and papers.
  const HELD = /feelings|depression|drug screen|group hour|tobacco|F41\.1|behavioral|psychotherapy|paid apart|PHQ|fagerstrom|96127|health hour/i;
  const parts = new Set(Object.keys((JSON.parse(readFileSync(join(root, 'views', PERSON, readdirSync(join(root, 'views', PERSON)).find((f) => f.startsWith('private.'))!), 'utf8')) as { parts: JsonObject }).parts));
  // What an answer shows of the items with a part.
  const shown = (r: Items) => JSON.stringify(r.items.filter((x) => parts.has(x.id)));
  const KINDS = ['claims', 'timeline', 'events', 'documents', 'bills', 'visits', 'procedures'];

  it.each(KINDS)('that name no person say none of it: %s', async (kind) => {
    for (const more of [{}, { response_format: 'detailed' }, { limit: 2 }, { name: 'sample' }]) {
      let args: object = { kind, ...more };
      for (;;) {
        const r = await items(root, 'medrec_records', args);
        expect(shown(r)).not.toMatch(HELD);
        if (r.next_cursor === undefined) break;
        args = { ...args, cursor: r.next_cursor };
      }
    }
  });

  it('are found by nothing of it', async () => {
    for (const query of ['sample', 'form', 'example', 'total', 'visit', 'drug', 'screen', 'paid', 'health']) {
      expect(shown(await items(root, 'medrec_search', { query })), query).not.toMatch(HELD);
    }
    for (const query of ['feelings', 'depression', 'f41', 'phq', '96127', 'behavioral']) {
      const r = await items(root, 'medrec_search', { query });
      expect([query, shown(r), r.warnings!.map((w) => w.code)]).toEqual([query, '[]', ['private-left-out']]);
    }
    for (const name of ['feelings', 'depression', 'drug screen']) expect(shown(await items(root, 'medrec_records', { kind: 'claims', name })), name).toEqual('[]');
    // Each is found by it in an answer about the person.
    expect(shown(await items(root, 'medrec_search', { query: 'feelings', person: 'Robin' }))).not.toBe('[]');
  });

  it('say how much they leave out, and about the person leave out nothing', async () => {
    const all = await items(root, 'medrec_records', { kind: 'claims', response_format: 'detailed', limit: 100 });
    const hers = await items(root, 'medrec_records', { kind: 'claims', response_format: 'detailed', limit: 100, person: 'Robin' });
    const less = all.items.filter((x) => x.not_shown !== undefined);
    expect(less.length).toBeGreaterThan(5);
    for (const x of less) {
      const whole = hers.items.find((y) => y.id === x.id)!;
      expect(whole.not_shown).toBeUndefined();
      const n = (f: JsonObject | undefined, k: string) => (Array.isArray(f?.[k]) ? (f[k] as unknown[]).length : 0);
      const out = ['items', 'diagnoses', 'payer_notes'].map((k) => n(whole.fields, k) - n(x.fields, k));
      const words = (c: number, one: string, many: string) => (c === 0 ? [] : [`${c} ${c === 1 ? one : many}`]);
      const said = [...words(out[0]!, 'service', 'services'), ...words(out[1]!, 'diagnosis', 'diagnoses'), ...words(out[2]!, 'payer note', 'payer notes')];
      expect(x.not_shown).toBe(`${said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : said[0]} not shown`);
      // What it cost stays.
      expect(x.fields!.amounts).toEqual(whole.fields!.amounts);
    }
    expect(JSON.stringify(hers.items)).toMatch(HELD);
  });

  it('give a bill without the lines, and all of it to its person', async () => {
    const open = (args: object) => ask(root, 'medrec_document', { id: 'd_accountaaaaaaaaaaaaa', ...args });
    const less = (await open({})).structuredContent as { text: string; text_chars: number; hint: string };
    expect(less.text).not.toMatch(HELD);
    expect(less.text).toContain('(2 lines not shown)');
    expect(less.hint).toBe('3 lines not shown: pass Robin Example as person for all of it.');
    const whole = (await open({ person: 'Robin' })).structuredContent as { text: string; text_chars: number; hint?: string };
    expect(whole.text).toMatch(HELD);
    expect(whole.hint).toBeUndefined();
    // Its size and its pages are those of what is given.
    expect([less.text_chars, whole.text_chars]).toEqual([less, whole].map((x) => [...x.text.replaceAll(/--- page \d+ ---/g, '\f')].length));
  });

  it('refuse a paper to another person', async () => {
    const two = join(scratch, 'two');
    cpSync(root, two, { recursive: true });
    const at = join(two, 'household.json');
    const h = JSON.parse(readFileSync(at, 'utf8')) as { people: JsonObject[] };
    h.people.push({ ...h.people[0]!, id: 'p_samaaaaaaaaaaaaaaaaa', name: 'Sam Example', folder: 'Sam Example' });
    writeFileSync(at, JSON.stringify(h));
    const r = await ask(two, 'medrec_document', { id: 'd_accountaaaaaaaaaaaaa', person: 'Sam' });
    expect([r.isError, r.content[0]!.text]).toEqual([true, 'usage: d_accountaaaaaaaaaaaaa is a document of Robin Example. Fix the arguments as described and call the tool again.']);
  });

  it('hold back a hit whose part they cannot search', async () => {
    const older = join(scratch, 'older');
    cpSync(root, older, { recursive: true });
    const at = join(older, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
    for (const v of Object.values(index.people)) delete v.files['search-parts.json'];
    writeFileSync(at, JSON.stringify(index));
    for (const query of ['sample', 'feelings', 'example', 'labs']) {
      const r = await items(older, 'medrec_search', { query });
      expect([query, shown(r), r.items.filter((x) => x.not_shown !== undefined)]).toEqual([query, '[]', []]);
      expect(r.warnings!.map((w) => w.code)).toEqual(['private-left-out']);
    }
  });

  it('read a view that is another pass’s as one still arriving', async () => {
    const other = join(scratch, 'other');
    cpSync(root, other, { recursive: true });
    const dir = join(other, 'views', PERSON);
    for (const f of readdirSync(dir).filter((x) => x.startsWith('search-parts.'))) writeFileSync(join(dir, f), '{}');
    expect((await ask(other, 'medrec_search', { query: 'sample' })).content[0]!.text).toContain('being prepared');
  });
});

describe('claims of one day that are shown by one name', async () => {
  const root = join(scratch, 'one-name');
  const h = JSON.parse(readFileSync(join(ownFolder('parts', root), 'household.json'), 'utf8')) as { people: { folder: string }[] };
  const at = join(root, h.people[0]!.folder, 'index.json');
  const index = JSON.parse(readFileSync(at, 'utf8')) as { records: JsonObject[] };
  const some = index.records.find((r) => r.kind === 'claim')!;
  // In the files' order, which is not that of their own names.
  const names = { r_first: 'Visit · Example', r_second: 'Look and Visit · Example', r_third: 'Form and Visit · Example', r_other: 'Walk · Example', r_day: 'Visit · Example' };
  index.records = Object.entries(names).map(([id, display]) => ({ ...some, id, key: id, display, date: id === 'r_day' ? '2024-01-01' : '2024-12-01' }));
  writeFileSync(at, JSON.stringify(index));
  writeViewsAt(root);
  const part = (display: string): JsonObject => ({ display, date: '2024-12-01', lines: [0], says: '1 service not shown' });
  const privacy: Privacy = { areas: new Map(), parts: new Map([['r_second', part('Visit · Example')], ['r_third', part('Visit · Example')]]) };
  const store = Object.assign(Object.create(new ViewsStore(folderAt(root))), { privacy: async () => privacy }) as ViewsStore;

  it.each([
    ['claims', {}],
    ['claims', { response_format: 'detailed' }],
    ['claims', { name: 'visit' }],
    ['timeline', { since: '2024-01-01' }],
  ])('are as the files have them: %s %j', async (kind, more) => {
    const r = await items(store, 'medrec_records', { kind, ...more });
    const visits = (of: Items) => of.items.map((x) => x.id).filter((id) => id in names && id !== 'r_other');
    expect(visits(r)).toEqual(['r_first', 'r_second', 'r_third', 'r_day']);
    expect(r.items.filter((x) => x.not_shown !== undefined).map((x) => x.id)).toEqual(['r_second', 'r_third']);
    // By their own names where the question names the person.
    const hers = await items(store, 'medrec_records', { kind, ...more, person: 'Robin' });
    expect(visits(hers)).toEqual(['r_third', 'r_second', 'r_first', 'r_day']);
  });
});

describe('a place that is of a linked stay', async () => {
  const root = join(scratch, 'demo');
  cpSync(DEMO, root, { recursive: true });
  writeViewsAt(root);
  addDerived(root, 'records');
  const base = new ViewsStore(folderAt(root));
  const h = await base.household();
  const child = h.people.find((p) => p.name.startsWith('Jamie'))!;
  const born = (await base.events(h, child)).events.find((e) => e.place_from === 'linked')!;
  const [link] = born.links as { person: string; event: string }[];
  const parent = h.people.find((p) => p.id === link!.person)!;
  const ask_ = async (change: (v: Privacy) => Privacy, args: object) => {
    const store = Object.assign(Object.create(base), { privacy: async (hh: typeof h, p: (typeof h.people)[number]) => (p.id === parent.id ? change(await base.privacy(hh, p)) : base.privacy(hh, p)) }) as ViewsStore;
    const day = born.start as string;
    const on = { since: day, until: day };
    return (await items(store, 'medrec_records', { kind: 'events', limit: 100, ...on, ...args })).items.find((e) => e.id === born.id);
  };
  const FORMS = [{}, { person: child.name }, { person: child.name, response_format: 'detailed' }, { response_format: 'detailed' }];

  it.each(FORMS)('is shown when the stay holds nothing private: %j', async (args) => {
    expect((await ask_((v) => v, args))!.source).toBe(born.place);
  });

  it.each(FORMS)('is not when it does, or when that is not known: %j', async (args) => {
    const not: Privacy[] = [
      { areas: new Map() },
      { areas: new Map(), clear: new Set(['e_other']) },
      { areas: new Map(), clear: new Set([link!.event]), unknown: { why: 'marks-unreadable' } },
      { areas: new Map(), unknown: { why: 'not-prepared', detail: 'x' } },
    ];
    for (const v of not) {
      const e = (await ask_(() => v, args))!;
      expect(e.source).toBeUndefined();
      expect(JSON.stringify(e)).not.toContain(JSON.stringify(born.place));
    }
  });

  it('is not found by a place that is not shown', async () => {
    const name = born.place as string;
    expect(await ask_((v) => v, { person: child.name, name })).toBeDefined();
    expect(await ask_(() => ({ areas: new Map() }), { person: child.name, name })).toBeUndefined();
  });
});

describe('what views name', () => {
  it('is stored under its content', () => {
    const root = ownFolder('parts', join(scratch, 'named'), { views: true });
    const index = JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex;
    for (const [pid, v] of Object.entries(index.people)) {
      const md5 = v.files['search-parts.json'];
      if (md5 === undefined) continue;
      expect(createHash('md5').update(readFileSync(join(root, personDir(pid) + storedName('search-parts.json', md5)))).digest('hex')).toBe(md5);
    }
  });
});
