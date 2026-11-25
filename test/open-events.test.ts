// An open event's private members (src/records/tools.ts openMembers), over
// medrec's own folder: an answer that names no person counts them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { labelsFolder } from '../scripts/labels-folder.mjs';
import type { JsonObject } from '../src/records/model';
import type { Privacy } from '../src/records/private';
import { callTool } from '../src/records/tools';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { addDerived, folderAt } from './support';

type Member = JsonObject & { record?: string; document?: string };
type Item = { id: string; private?: string; fields?: { members?: Member[]; private_members?: number } };

describe("an open event's private members", async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-open-events-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const root = labelsFolder(join(scratch, 'f'));
  writeViewsAt(root);
  addDerived(root, 'labels');
  const store = new ViewsStore(folderAt(root));
  const h = await store.household();
  const robin = h.people[0]!;
  const { areas } = await store.privacy(h, robin);
  const events = (await store.events(h, robin)) as (JsonObject & { id: string; start: string; members: Member[] })[];
  const id = (m: Member) => m.record ?? m.document!;
  const open = events.find((e) => !areas.has(e.id) && e.members.some((m) => areas.has(id(m))))!;
  const closed = events.find((e) => areas.has(e.id))!;
  const items = async (args: object, s: ViewsStore = store) => {
    const r = (await callTool('medrec_records', { kind: 'events', ...args }, { store: s, today: '2026-11-25' }))!;
    return r.structuredContent!.items as unknown as Item[];
  };
  const one = async (args: object, s?: ViewsStore) => (await items(args, s)).find((i) => i.id === (('id' in args && args.id) || open.id))!;
  const instead = (over: object) => Object.assign(Object.create(store), over) as ViewsStore;
  const own = open.members.filter((m) => !areas.has(id(m)));
  const hidden = open.members.length - own.length;

  it('are counted in an answer that names no person, with detail or by id', async () => {
    expect([own.length > 0, hidden > 0]).toEqual([true, true]);
    for (const args of [{ response_format: 'detailed' }, { id: open.id }, { id: open.id, response_format: 'detailed' }]) {
      const { fields } = await one(args);
      expect([fields!.members, fields!.private_members], JSON.stringify(args)).toEqual([own, hidden]);
      expect(Object.keys(fields!).indexOf('private_members')).toBe(Object.keys(fields!).indexOf('members') + 1);
    }
    expect(JSON.stringify(await items({ response_format: 'detailed' }))).not.toMatch(new RegExp(open.members.filter((m) => areas.has(id(m))).map(id).join('|')));
    expect((await one({})).fields).toBeUndefined();
  });

  it('are in an answer about the person', async () => {
    const { fields } = await one({ person: 'Robin', response_format: 'detailed' });
    expect([fields!.members, fields!.private_members]).toEqual([open.members, undefined]);
  });

  it('are in a private event the question names', async () => {
    const it = await one({ id: closed.id });
    expect([it.private !== undefined, it.fields!.members, it.fields!.private_members]).toEqual([true, closed.members, undefined]);
  });

  it("another person's is judged as that person's, and held back when nobody can judge it", async () => {
    const sam = { ...robin, id: 'p_samaaaaaaaaaaaaaaaa', name: 'Sam Example', folder: 'Sam Example' };
    const paper = (n: string, person: string) => ({ document: `d_${n}`, kind: 'bill', title: 'Bill', role: 'paper', person });
    const members = [...own, paper('closed', sam.id), paper('open', sam.id), paper('nobody', 'p_nobodyaaaaaaaaaaaaa')];
    const over = (privacy: Privacy) =>
      instead({
        household: async () => ({ ...h, people: [robin, sam] }),
        events: async (_h: unknown, p: typeof robin) => (p.id === robin.id ? [{ ...open, members }] : []),
        privacy: async (_h: unknown, p: typeof robin) => (p.id === robin.id ? { areas } : privacy),
        providerLabels: async () => null,
      });
    const of = async (privacy: Privacy) => (await one({ id: open.id }, over(privacy))).fields!;
    expect(await of({ areas: new Map([['d_closed', 'mental_health']]) })).toMatchObject({ members: [...own, paper('open', sam.id)], private_members: 2 });
    expect(await of({ areas: new Map(), unknown: { why: 'marks-unreadable' } })).toMatchObject({ members: own, private_members: 3 });
  });

  it('are all of them when which are private is not known', async () => {
    const { fields } = await one({ id: open.id }, instead({ privacy: async () => ({ areas: new Map(), unknown: { why: 'marks-unreadable' } }), providerLabels: async () => null }));
    expect([fields!.members, fields!.private_members]).toEqual([[], open.members.length]);
  });
});
