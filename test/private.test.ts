// The private-left-out count a page reports, as medrec's views::LeftOut::on_page
// gives it: after the previous page's last item, up to its own last, the last
// page to the end; the pages add up to the whole count.

import { describe, expect, it } from 'vitest';
import type { Person } from '../src/records/model';
import { Gate } from '../src/records/private';

const robin = { id: 'p_robin', name: 'Robin Example' } as Person;

/** A gate that has seen `order` in the tool's order: `h` an item held back, `k` one kept. */
function seen(order: string): Gate {
  const gate = new Gate(true, new Map([[robin.id, { areas: new Map([...order].flatMap((c, i) => (c === 'h' ? [[`r_${i}`, 'mental_health']] : []))) }]]));
  [...order].forEach((_, i) => gate.keep(robin, `r_${i}`, () => false));
  return gate;
}

describe('per-page private-left-out counts', () => {
  // Kept items k0..k4 with held ones around them: h k0 h h k1 k2 h k3 k4 h
  const order = 'hkhhkkhkkh';

  it('counts from the start to its last item on the first page, and to the end on the last', () => {
    expect(seen(order).leftOut(0, 2, false)).toBe(3);
    expect(seen(order).leftOut(2, 2, false)).toBe(1);
    expect(seen(order).leftOut(4, 1, true)).toBe(1);
    expect(seen(order).leftOut(0, 5, true)).toBe(5);
  });

  it('adds up to the whole count whatever the page size', () => {
    for (const limit of [1, 2, 3, 4, 5]) {
      let total = 0;
      for (let offset = 0; offset < 5; offset += limit) total += seen(order).leftOut(offset, Math.min(limit, 5 - offset), offset + limit >= 5);
      expect(total, `limit ${limit}`).toBe(5);
    }
  });

  it('counts 0 on a page past the kept items, as a stale cursor reaches', () => {
    expect(seen(order).leftOut(5, 0, true)).toBe(0);
    expect(seen(order).leftOut(9, 0, true)).toBe(0);
  });

  it('counts nothing past the previous item on an empty page that is not the last', () => {
    expect(seen(order).leftOut(2, 0, false)).toBe(0);
  });

  it('counts everything held back when nothing is kept', () => {
    expect(seen('hhh').leftOut(0, 0, true)).toBe(3);
  });
});
