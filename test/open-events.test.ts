// What an event's members, links and could_join hold back (src/records/tools.ts
// shownFields), over medrec's own folder.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { labelsFolder } from '../scripts/labels-folder.mjs';
import type { JsonObject } from '../src/records/model';
import { ToolError } from '../src/mcp/errors';
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

  describe("another person's paper or event", () => {
    const sam = { ...robin, id: 'p_samaaaaaaaaaaaaaaaa', name: 'Sam Example', folder: 'Sam Example' };
    const gone = 'p_nobodyaaaaaaaaaaaaa';
    const paper = (n: string, person: string) => ({ document: `d_${n}`, kind: 'bill', title: 'Bill', role: 'paper', person });
    const link = (n: string, person?: string) => ({ event: `e_${n}`, ...(person ? { person } : {}), relation: 'newborn' });
    const over = (privacy: Privacy, event: JsonObject) =>
      instead({
        household: async () => ({ ...h, people: [robin, sam] }),
        events: async (_h: unknown, p: typeof robin) => (p.id === robin.id ? [event] : []),
        privacy: async (_h: unknown, p: typeof robin) => (p.id === robin.id ? { areas } : privacy),
        providerLabels: async () => null,
      });
    const known: Privacy = { areas: new Map([['d_closed', 'mental_health'], ['e_closed', 'mental_health']]) };
    const unknown: Privacy = { areas: new Map(), unknown: { why: 'marks-unreadable' } };
    const fields = async (args: object, privacy: Privacy, event: JsonObject) => (await one(args, over(privacy, event))).fields as JsonObject;
    const about = { person: 'Robin', response_format: 'detailed' };
    const answer = async (args: object, s: ViewsStore) => (await callTool('medrec_records', { kind: 'events', ...args }, { store: s, today: '2026-11-25' }))!;
    const warnings = async (args: object, s: ViewsStore) => ((await answer(args, s)).structuredContent!.warnings ?? []) as { code: string; message: string }[];

    it("is judged as that person's, in an answer about the first too, and held back when nobody can judge it", async () => {
      const event = { ...open, members: [...open.members, paper('closed', sam.id), paper('open', sam.id), paper('nobody', gone)] };
      expect(await fields({ id: open.id }, known, event)).toMatchObject({ members: [...own, paper('open', sam.id)], private_members: hidden + 2 });
      expect(await fields({ id: open.id }, unknown, event)).toMatchObject({ members: own, private_members: hidden + 3 });
      expect(await fields(about, known, event)).toMatchObject({ members: [...open.members, paper('open', sam.id)], private_members: 2 });
      expect(await fields(about, unknown, event)).toMatchObject({ members: open.members, private_members: 3 });
      // A private event the question names keeps its own.
      const named = { ...closed, members: [...closed.members, paper('closed', sam.id)] };
      expect(await fields({ id: closed.id }, known, named)).toMatchObject({ members: closed.members, private_members: 1 });
    });

    it('is linked only where that person has it shown', async () => {
      const links = [link('closed', sam.id), link('open', sam.id), link('nobody', gone)];
      for (const args of [{ id: open.id }, about]) {
        expect((await fields(args, known, { ...open, links })).links).toEqual([link('open', sam.id)]);
        // Nothing left is nothing said.
        expect(Object.keys(await fields(args, unknown, { ...open, links }))).not.toContain('links');
      }
    });

    it("the person's own are named only in an answer about them, where they are private", async () => {
      const event = { ...open, links: [link('x'), { ...link('x'), event: closed.id }], could_join: ['e_x', closed.id] };
      const all = await fields(about, known, event);
      expect([all.links, all.could_join]).toEqual([event.links, event.could_join]);
      const some = await fields({ id: open.id }, known, event);
      expect([some.links, some.could_join]).toEqual([[link('x')], ['e_x']]);
      expect(Object.keys(await fields({ id: open.id }, known, { ...open, could_join: [closed.id] }))).not.toContain('could_join');
    });

    it('left out because nobody can judge it is said, in an answer about the first', async () => {
      const linked = { ...open, links: [link('open', sam.id)] };
      const says = async (u: Privacy['unknown'], event: JsonObject = linked, args: object = about) => (await warnings(args, over({ areas: new Map(), unknown: u }, event))).filter((w) => w.message.includes('Sam'));
      expect(await says({ why: 'not-prepared', detail: 'because' })).toEqual([{ code: 'private-not-prepared', message: "Which of Sam Example's items are private is not known (because): the events on this page leave out Sam Example's documents and events. Ask about Sam Example for them" }]);
      expect((await says({ why: 'marks-unreadable' })).map((w) => w.code)).toEqual(['private-marks-unreadable']);
      expect((await says({ why: 'labels-unreadable' })).map((w) => w.code)).toEqual(['private-labels-unreadable']);
      // Not where the page names nothing of theirs, or lists no members.
      expect(await says({ why: 'marks-unreadable' }, open)).toEqual([]);
      expect(await says({ why: 'marks-unreadable' }, linked, { person: 'Robin' })).toEqual([]);
      // An answer about everyone says it once, as for anyone.
      expect((await says({ why: 'marks-unreadable' }, linked, { id: open.id })).map((w) => w.code)).toEqual(['private-marks-unreadable']);
      expect(await warnings(about, over(known, linked))).toEqual([]);
    });

    it('whose private.json cannot be read is left out, and the rest is answered', async () => {
      const linked = { ...open, links: [link('open', sam.id)] };
      const failing = (e: Error) => Object.assign(over(known, linked), { privacy: async (_h: unknown, p: typeof robin) => (p.id === robin.id ? { areas } : Promise.reject(e)) }) as ViewsStore;
      const s = failing(ToolError.upstream('Google Drive answered 503'));
      const { fields } = await one(about, s);
      expect([fields!.members, Object.keys(fields!).includes('links')]).toEqual([open.members, false]);
      expect((await warnings(about, s)).map((w) => [w.code, w.message.includes('could not be read just now')])).toEqual([['private-not-prepared', true]]);
      // A sign-in that has ended is the answer.
      expect((await answer(about, failing(ToolError.auth('it has ended')))).isError).toBe(true);
    });
  });

  it('are all of them when which are private is not known', async () => {
    const { fields } = await one({ id: open.id }, instead({ privacy: async () => ({ areas: new Map(), unknown: { why: 'marks-unreadable' } }), providerLabels: async () => null }));
    expect([fields!.members, fields!.private_members]).toEqual([[], open.members.length]);
  });
});
