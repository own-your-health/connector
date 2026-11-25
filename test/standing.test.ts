// What is current by each source's word (src/records/standing.ts): the lists
// medrec's own fixture says a reader makes of its standing.json, and the rows an
// answer makes of them (src/records/standing-rows.ts).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { standingsOf, type Line, type StandingView } from '../src/records/standing';
import { standingRows, type Asked } from '../src/records/standing-rows';
import { RawStore, type RecordFilter } from '../src/records/store';
import { folderAt } from './support';
import fixture from './fixtures/words/lists.json';
import view from './fixtures/words/standing.json';

interface Case {
  why: string;
  kind: string;
  day: string;
  hidden: string[];
  lists: Record<string, unknown>;
}

describe("medrec's lists of what is current", () => {
  const st = standingsOf(view as unknown as StandingView, fixture.person)!;
  const lines = (ls: Line[]) =>
    ls.map((l) => ({
      records: l.records,
      ...(l.against.length > 0 ? { against: l.against } : {}),
      ...(l.differs ? { differs: true } : {}),
      ...(l.filled ? { filled: l.filled } : {}),
      ...(l.unheard.length > 0 ? { unheard: l.unheard } : {}),
    }));
  (fixture.cases as unknown as Case[]).forEach((c, i) => {
    it(`${i} ${c.kind} on ${c.day}: ${c.why}`, () => {
      const got = st.lists(c.kind, (id) => !c.hidden.includes(id), c.day);
      expect({
        current: lines(got.current),
        ...(got.on_hold.length > 0 ? { on_hold: lines(got.on_hold) } : {}),
        ...(got.ended_by_date.length > 0 ? { ended_by_date: lines(got.ended_by_date) } : {}),
        ...(got.in_error > 0 ? { in_error: got.in_error } : {}),
        ...(got.without_problem_list.length > 0 ? { without_problem_list: got.without_problem_list } : {}),
      }).toEqual({ current: [], ...c.lists });
    });
  });

  it('reads no one else\'s view', () => {
    expect(standingsOf(view as unknown as StandingView, 'p_another')).toBeNull();
  });
});

describe('the rows of a list', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-standing-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const st = standingsOf(view as unknown as StandingView, fixture.person)!;
  const store = new RawStore(folderAt(ownFolder('words', join(scratch, 'words'))));
  const h = await store.household();
  const filter = (x: Partial<RecordFilter> = {}): RecordFilter => ({ range: {}, active: false, ...x });
  const of = async (x: Partial<Asked>) => {
    const asked: Asked = { kind: 'medication', today: '2024-07-01', filter: filter(), detailed: false, ...x };
    const { rows, notes } = await standingRows(st, (f) => store.records(h, h.people[0]!, asked.kind, f, false), asked);
    const out = [];
    for await (const r of rows) out.push({ id: r.record.id, group: r.group, standing: r.standing, says: r.says });
    return { rows: out, notes };
  };
  const row = async (id: string, x: Partial<Asked>) => (await of(x)).rows.find((r) => r.id === id);
  const held = (...ids: string[]) => (id: string) => ids.includes(id);
  const active = (x: Partial<RecordFilter> = {}) => ({ filter: filter({ active: true, ...x }) });
  // Two records of one line, whose sources differ; a medicine, and the fills beside it.
  const [RASH, RASH_ENDED] = ['r_tworecordsaaaaaaaaaa', 'r_tworecordsotheraaaaa'];
  const [CAPSULE, FILL] = ['r_endsaaaaaaaaaaaaaaaa', 'r_fillafteraaaaaaaaaaa'];

  it('name what a private line says where the answer lists it', async () => {
    const list = { kind: 'condition', ...active() };
    const differ = (await row(RASH, list))!;
    expect(differ.standing).toBe('current, sources differ');
    expect(differ.says).toContain('resolved');
    // Held back, it makes no line differ, and has no row of its own where it would have none alone.
    const less = await of({ ...list, heldBack: held(RASH_ENDED) });
    expect(less.rows.find((r) => r.id === RASH)).toEqual({ ...differ, standing: 'current', says: expect.not.stringContaining('resolved') });
    expect(less.rows.map((r) => r.id)).not.toContain(RASH_ENDED);
    // The question names it.
    expect(await row(RASH, { kind: 'condition', ...active({ name: 'sample rash' }), heldBack: held(RASH_ENDED) })).toEqual(differ);
    // By its code, which names nothing.
    expect((await row(RASH, { kind: 'condition', ...active({ name: 'C-3' }), heldBack: held(RASH_ENDED) }))!.standing).toBe('current');
  });

  it('keep a row of each held back one, for the list to count', async () => {
    const [all, less] = [await of({ kind: 'condition', ...active() }), await of({ kind: 'condition', ...active(), heldBack: held(RASH) })];
    expect(less.rows.map((r) => r.id).sort()).toEqual(all.rows.map((r) => r.id).sort());
  });

  it('name the last fill the answer may show', async () => {
    for (const how of [{ filter: filter() }, active()]) {
      const whole = (await row(CAPSULE, how))!;
      expect(whole.standing).toContain('2024-05-02');
      expect((await row(CAPSULE, { ...how, heldBack: held(FILL) }))!.standing).toContain('2024-04-10');
      const name = { filter: { ...how.filter, name: 'sample capsule' } };
      expect(await row(CAPSULE, { ...name, heldBack: held(FILL) })).toEqual(whole);
      // Not one outside the days asked of.
      const before = { filter: { ...name.filter, range: { until: '2024-05-01' } } };
      expect((await row(CAPSULE, { ...before, heldBack: held(FILL) }))!.standing).toContain('2024-04-10');
    }
  });

  it('say which sources send no problem list, by what the answer may show', async () => {
    const visits = ['r_visitonlyaaaaaaaaaaa', 'r_onlistvisitaaaaaaaaa', 'r_visitendedaaaaaaaaaa'];
    expect((await of({ kind: 'condition', ...active() })).notes).toHaveLength(1);
    expect((await of({ kind: 'condition', ...active(), heldBack: held(...visits) })).notes).toEqual([]);
    expect((await of({ kind: 'condition' })).notes).toEqual([]);
  });

  it('have the current ones first, then those on hold, then those ended by their date', async () => {
    const groups = (await of(active())).rows.map((r) => r.group);
    expect(groups).toEqual([...groups].sort());
    expect(new Set(groups)).toEqual(new Set([0, 1, 2]));
  });
});
