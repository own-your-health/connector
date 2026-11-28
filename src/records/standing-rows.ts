// The rows of a person's list of conditions, allergies or medicines, by what
// each source says (standing.ts), and which of a person's private records an
// answer about the whole household counts in them.

import type { ListedRecord, RecordEntry } from './model';
import { names } from './private';
import type { Row, Standings } from './standing';
import { recordOrder, type RecordFilter } from './store';
import { clip } from './text';
import { CLIP, holds, matchesCode } from './views';

/** A list's rows, in its order, and what it says of sources with no problem list. */
export interface ListRows {
  rows: AsyncIterable<Row<ListedRecord>>;
  notes: string[];
}

export interface Asked {
  kind: string;
  today: string;
  filter: RecordFilter;
  detailed: boolean;
  /** In an answer about the whole household: the ids it holds back where the question does not name them. */
  heldBack?: (id: string) => boolean;
}

/** `read` gives the person's records of the kind that pass a filter, in the list's order. */
export async function standingRows(st: Standings, read: (f: RecordFilter) => AsyncIterable<ListedRecord>, { kind, today, filter, detailed, heldBack }: Asked): Promise<ListRows> {
  const { range, name, active } = filter;
  const asked = (x: RecordEntry) => holds(range, x.date) && (name === undefined || matchesCode(x, name));
  // A private one counts on a line only where the answer lists it.
  const listed = (x: RecordEntry) => name !== undefined && asked(x) && names(clip(x.display, CLIP), name);
  if (active) {
    const shows = (x: RecordEntry) => !heldBack?.(x.id) || listed(x);
    // A claim, which a medicine's fill can be, is never one the question lists by name.
    const { rows, notes } = st.active(await all(read({ range: {}, active: false })), kind, today, asked, shows, (id) => !heldBack?.(id));
    const order = recordOrder(detailed);
    return { rows: each(rows.sort((a, b) => a.group - b.group || order(a.record, b.record))), notes };
  }
  // A fill beside a medicine may be one the question names.
  const found = heldBack && name !== undefined ? await all(read(filter)) : undefined;
  const open = new Set(found?.filter(listed).map((x) => x.id));
  const mayShow = (id: string) => !heldBack?.(id) || open.has(id);
  return { rows: mapped(found ? each(found) : read(filter), (x) => st.row(x, mayShow, today)), notes: [] };
}

export async function* each<T>(xs: Iterable<T>): AsyncIterable<T> {
  yield* xs;
}

export async function* mapped<T, U>(xs: AsyncIterable<T>, f: (x: T) => U): AsyncIterable<U> {
  for await (const x of xs) yield f(x);
}

async function all<T>(xs: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of xs) out.push(x);
  return out;
}
