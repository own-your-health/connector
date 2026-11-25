// What is current by each source's word (src/records/standing.ts): the lists
// medrec's own fixture says a reader makes of its standing.json.

import { describe, expect, it } from 'vitest';
import { standingsOf, type Line, type StandingView } from '../src/records/standing';
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
