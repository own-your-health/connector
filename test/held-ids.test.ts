// What an answer about the whole household leaves out of a record's fields
// (src/records/tools.ts withoutHeld) and a document's records, over the demo.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../src/records/model';
import type { Privacy } from '../src/records/private';
import { callTool } from '../src/records/tools';
import { writeViewsAt } from '../src/views/local';
import type { DocumentView } from '../src/views/format';
import { ViewsStore } from '../src/views/store';
import { DEMO, addDerived, folderAt } from './support';

type Claim = { id: string; title: string; private?: string; fields: JsonObject & { visit?: string; results?: string[]; items?: { records?: string[] }[] } };

describe('the ids of items held back', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-held-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'f');
  cpSync(DEMO, root, { recursive: true });
  writeViewsAt(root);
  addDerived(root, 'records');
  const store = new ViewsStore(folderAt(root));
  const ask = async (privacy: Privacy, args: object) => {
    const s = Object.assign(Object.create(store), { privacy: async () => privacy, providerLabels: async () => null }) as ViewsStore;
    const r = (await callTool('medrec_records', { kind: 'claims', response_format: 'detailed', limit: 100, ...args }, { store: s, today: '2026-11-25' }))!;
    return r.structuredContent!.items as unknown as Claim[];
  };
  const none: Privacy = { areas: new Map() };
  const held = (...ids: string[]): Privacy => ({ areas: new Map(ids.map((id) => [id, 'mental_health'])) });
  const all = await ask(none, {});
  const lab = all.find((c) => (c.fields.results?.length ?? 0) > 1)!;
  const visit = all.find((c) => c.fields.visit !== undefined)!;
  const of = (items: Claim[], c: Claim) => items.find((i) => i.id === c.id)!.fields;
  const person = (c: Claim) => ({ person: (c as unknown as { person: string }).person });

  it('are out of its lists, which keep the rest', async () => {
    const [first, ...rest] = lab.fields.results!;
    const fields = of(await ask(held(first!), {}), lab);
    expect(fields.results).toEqual(rest);
    expect(JSON.stringify(fields)).not.toContain(first);
    // Nothing else changes.
    const without = (f: JsonObject) => JSON.parse(JSON.stringify(f).replaceAll(`"${first}",`, '').replaceAll(`,"${first}"`, ''));
    expect(JSON.parse(JSON.stringify(fields))).toEqual(without(lab.fields));
  });

  it('leave no key with nothing left', async () => {
    const fields = of(await ask(held(...lab.fields.results!), {}), lab);
    expect(Object.keys(fields)).not.toContain('results');
    expect(fields.items!.map((l) => Object.keys(l).includes('records'))).toEqual(lab.fields.items!.map((l) => l.records?.some((id) => !lab.fields.results!.includes(id)) ?? false));
    expect(Object.keys(of(await ask(held(visit.fields.visit!), {}), visit))).not.toContain('visit');
  });

  it('are all there in an answer about the person', async () => {
    expect(of(await ask(held(...lab.fields.results!), person(lab)), lab)).toEqual(lab.fields);
  });

  it('are out of a private record the question names, which names that record alone', async () => {
    const named = (await ask(held(lab.id, ...lab.fields.results!), { name: lab.title })).find((c) => c.id === lab.id)!;
    expect([named.private, Object.keys(named.fields).includes('results')]).toEqual(['mental_health', false]);
  });

  it('are every id of a person whose private items are not known', async () => {
    const named = await ask({ areas: new Map(), unknown: { why: 'marks-unreadable' } }, { name: lab.title });
    expect(JSON.stringify(of(named, lab))).not.toMatch(/"[rdem]_/);
  });
});

describe("a document's records", async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-linked-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const [prepared, raw] = ['prepared', 'raw'].map((n) => join(scratch, n)) as [string, string];
  for (const root of [prepared, raw]) cpSync(DEMO, root, { recursive: true });
  writeViewsAt(prepared);
  const stores = { prepared: new ViewsStore(folderAt(prepared)), raw: new ViewsStore(folderAt(raw)) };
  const h = await stores.prepared.household();
  const all = (await Promise.all(h.people.map(async (p) => (await stores.prepared.documents(h, p)).map((d) => ({ p, d }))))).flat();
  const { d } = all.find(({ d }) => (d as DocumentView).linked)!;
  const { linked, linked_ids } = d as DocumentView;
  const names = async (privacy: Privacy, over: object = {}, store: ViewsStore = stores.prepared) => {
    const s = Object.assign(Object.create(store), { privacy: async () => privacy, providerLabels: async () => null, ...over }) as ViewsStore;
    return (await callTool('medrec_document', { id: d.id }, { store: s, today: '2026-11-25' }))!.structuredContent!.records as string[] | undefined;
  };
  const known = (...ids: string[]): Privacy => ({ areas: new Map(ids.map((id) => [id, 'mental_health'])) });
  const unknown: Privacy = { areas: new Map(), unknown: { why: 'marks-unreadable' } };

  it.each(Object.entries(stores))('leave out the private ones (%s)', async (_n, store) => {
    expect([linked!.length > 0, linked_ids!.length]).toEqual([true, linked!.length]);
    expect(await names(known(), {}, store)).toEqual(linked);
    expect(await names(known('r_anotheraaaaaaaaaaaaa'), {}, store)).toEqual(linked);
    expect(await names(known(linked_ids![0]!), {}, store)).toEqual(linked!.length > 1 ? linked!.slice(1) : undefined);
    expect(await names(unknown, {}, store)).toBeUndefined();
  });

  it('are all named where the document is private', async () => {
    expect(await names(known(d.id, ...linked_ids!))).toEqual(linked);
  });

  it('are none, where views do not say which they are and any record is private', async () => {
    const older = { documentRecords: async () => linked!.map((name) => ({ name })) };
    expect(await names(known(), older)).toEqual(linked);
    expect(await names(known('d_anotheraaaaaaaaaaaaa'), older)).toEqual(linked);
    expect(await names(known('r_anotheraaaaaaaaaaaaa'), older)).toBeUndefined();
    expect(await names(unknown, older)).toBeUndefined();
    expect(await names(known(d.id, 'r_anotheraaaaaaaaaaaaa'), older)).toEqual(linked);
  });
});
