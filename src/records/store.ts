// What the tools read, one level above the files: a person's records of one
// kind in the order the records tool lists them, a summary, the best search
// hits, a document's text. Two stores answer it the same way:
//
// - RawStore reads household.json and each person's index.json, text.json
//   and notes.md whole (medrec-cli docs/data-contract.md). Every answer of
//   `medrec mcp` is reproduced from them.
// - ViewsStore (src/views/store.ts) reads the small files medrec writes
//   beside them for this connector, so a call parses kilobytes, not
//   megabytes, and fits the Workers Free plan's 10 ms of CPU.
//
// Lists are async iterables in their final order, so a tool reads only as
// many items as the page it answers needs.

import { NO_NAMES, type CodeNames } from './code-names';
import type { Folder } from './folder';
import type { Privacy } from './private';
import { NO_LABELS, type ProviderLabels } from './provider-labels';
import { ToolError } from '../mcp/errors';
import type { DocumentEntry, Household, JsonObject, ListedRecord, Note, Person, RecordEntry } from './model';
import { sourcesOf } from './sources';
import { clip, cmpOpt, cmpStr, day, fold } from './text';
import {
  CLIP,
  LAB_QUERIES,
  type Event,
  type PersonRow,
  type Range,
  type ResultRow,
  type Summary,
  holds,
  isEnded,
  latestResults,
  matchesCode,
  newestFirst,
  personRow,
  searchables,
  score,
  seriesKey,
  snippetAt,
  summarize,
  timelineEvents,
} from './views';

export interface RecordFilter {
  range: Range;
  /** Leave out records whose status says they ended. */
  active: boolean;
  /** `matchesCode`: an exact code, or part of the name. */
  name?: string;
}

/** A search hit before its snippet is made: only the hits a page returns get one. */
export interface Candidate {
  kind: string;
  id: string;
  date?: string;
  title: string;
  score: number;
  /** Ranked but held back from the answer (private.ts): counted where it ranks, never shown. */
  held?: boolean;
  snippet(): Promise<string>;
}

/** Which hits a search holds back where they rank: private items a question about everyone does not name. */
export type Skip = (c: { id: string; title: string }) => boolean;

/**
 * The first hits of `ranked` up to `want` not held back, with those held back
 * (`skip`) that rank among them, flagged `held`.
 */
export function upTo<T extends { held?: boolean }>(ranked: T[], want: number, skip?: (x: T) => boolean): T[] {
  const out: T[] = [];
  let kept = 0;
  for (const x of ranked) {
    if (kept >= want) break;
    if (x.held || skip?.(x)) x.held = true;
    else kept++;
    out.push(x);
  }
  return out;
}

/** What is paid and left on one bill, from the person's bills.json (medrec 0.9.1 and later). */
export interface Standing {
  settled: boolean;
  left?: string;
}

/**
 * What the tools read. A person-scoped method that cannot read that person's
 * records right now, while nothing else is wrong (views stale, still
 * arriving, or in a layout this connector does not know), throws a ToolError
 * made with `personUnavailable(p.id)`. A question about everyone then
 * answers without them (partial.ts). Every other failure, a corrupt file, a
 * Drive sign-in or the request budget, is never so marked, and fails the call.
 */
export interface Store {
  household(): Promise<Household>;
  people(h: Household): Promise<PersonRow[]>;
  summary(h: Household, p: Person, today: string, perList: number): Promise<Summary>;
  /** A person's records of one kind that pass the filter, ordered as the records tool lists them in that format. */
  records(h: Household, p: Person, kind: string, filter: RecordFilter, detailed: boolean): AsyncIterable<ListedRecord>;
  /** `latestResults` over the person's results that pass the filter. */
  /**
   * The person's test series, each by its latest result. `look` names ids to
   * find among each series' results: a row's `members` lists those it holds.
   */
  tests(h: Household, p: Person, filter: RecordFilter, look?: ReadonlySet<string>): Promise<ResultRow[]>;
  /** A person's documents, records, studies and notes as timeline events in the range, ordered as the records tool lists them. */
  timeline(h: Household, p: Person, range: Range): AsyncIterable<Event>;
  documents(h: Household, p: Person): Promise<DocumentEntry[]>;
  /** The document with this id, and whose it is; null when no one has it. */
  findDocument(h: Household, id: string): Promise<[Person, DocumentEntry] | null>;
  notes(h: Household, p: Person): Promise<Note[]>;
  /**
   * The person's `want` best hits, best first (score, then date, newest
   * first), not counting those `skip` holds back: these come where they
   * rank, flagged `held` (upTo).
   */
  search(h: Household, p: Person, terms: string[], range: Range, want: number, skip?: Skip): Promise<Candidate[]>;
  documentText(h: Household, p: Person, d: DocumentEntry): Promise<string>;
  /** The names of the first 20 records filed from the document. */
  documentRecords(h: Household, p: Person, d: DocumentEntry): Promise<string[]>;
  /** Fetch what the hits' snippets need in as few requests as the store can, before `snippet()` is called on each. */
  prepare?(hits: Candidate[]): Promise<void>;
  /**
   * The person's events, as medrec 0.9.0 and later write them in their views
   * (`events.json`, medrec-events/v1), in that file's order. Only medrec
   * groups records into events, so a person without current events gets a
   * personUnavailable error, however small their files.
   */
  events(h: Household, p: Person): Promise<JsonObject[]>;
  /**
   * The person's private items (private.json, in full from medrec 0.9.5), or
   * why they are not known: never an error, since not knowing only holds
   * their items back from answers about everyone.
   */
  privacy(h: Household, p: Person): Promise<Privacy>;
  /** What is paid and left on each of the person's bills by document id (bills.json, medrec 0.9.1 and later); null when not known. */
  bills(h: Household, p: Person): Promise<ReadonlyMap<string, Standing> | null>;
  /** The plain names of the person's condition codes (code-names.json, medrec 0.9.4 and later); none when missing or stale. */
  codeNames(h: Household, p: Person): Promise<CodeNames>;
  /** Who the providers the person's items print are (providers.json, medrec 0.9.7 and later); none when missing or stale. */
  providerLabels(h: Household, p: Person): Promise<ProviderLabels>;
}

/** The records tool's order: date, newest first (the day only, unless detailed), then title. */
export function recordOrder(detailed: boolean) {
  const date = (r: RecordEntry) => (detailed ? (r.date ?? undefined) : day(r.date));
  return (a: RecordEntry, b: RecordEntry) => cmpOpt(date(b), date(a)) || cmpStr(clip(a.display, CLIP), clip(b.display, CLIP));
}

/** The records tool's timeline order: medrec's sort by date, kind and title, then the tool's by date and clipped title. */
export const eventOrder = (a: Event, b: Event) =>
  cmpOpt(b.date, a.date) || cmpStr(clip(a.title, CLIP), clip(b.title, CLIP)) || cmpStr(a.kind, b.kind) || cmpStr(a.title, b.title);

export function passes(r: RecordEntry, kind: string, f: RecordFilter): boolean {
  return r.kind === kind && holds(f.range, r.date) && !(f.active && isEnded(r.status)) && (f.name === undefined || matchesCode(r, f.name));
}

/**
 * The first `want` items of several ordered lists merged, ties to the earlier
 * list: what a stable sort of their concatenation puts first.
 */
export async function takeMerged<T>(lists: AsyncIterable<T>[], cmp: (a: T, b: T) => number, want: number, keep: (x: T) => boolean = () => true): Promise<T[]> {
  const out: T[] = [];
  if (want <= 0) return out;
  for await (const x of merged(lists, cmp)) {
    if (!keep(x)) continue;
    out.push(x);
    if (out.length >= want) break;
  }
  return out;
}

/** Ordered lists merged into one, ties to the earlier list, each read only as far as needed. */
export async function* merged<T>(lists: AsyncIterable<T>[], cmp: (a: T, b: T) => number): AsyncIterable<T> {
  const its = lists.map((l) => l[Symbol.asyncIterator]());
  const next = async (it: AsyncIterator<T>): Promise<T | undefined> => {
    const r = await it.next();
    return r.done ? undefined : r.value;
  };
  try {
    const heads = await Promise.all(its.map(next));
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (h === undefined) continue;
        if (best === -1 || cmp(h, heads[best]!) < 0) best = i;
      }
      if (best === -1) return;
      yield heads[best]!;
      heads[best] = await next(its[best]!);
    }
  } finally {
    await Promise.all(its.map((it) => it.return?.()));
  }
}

/** Every person's best hits merged as medrec ranks them: score, then date, newest first; ties in household order. */
export function rankHits(perPerson: Candidate[][], want: number): Candidate[] {
  return upTo(
    perPerson.flat().sort((a, b) => b.score - a.score || cmpOpt(b.date, a.date)),
    want,
  );
}

/** The people's `want` best hits for the terms, ranked together (rankHits), each with whose it is. */
export async function searchHousehold(
  store: Store,
  h: Household,
  people: Person[],
  terms: string[],
  range: Range,
  want: number,
  /** Asks one person, or leaves them out (partial.ts LeftOut.of); by default the person's error is the answer. */
  each: <T>(p: Person, f: () => Promise<T>, none: T) => Promise<T> = (_p, f) => f(),
  /** Each person's hits held back where they rank. */
  skip?: (p: Person) => Skip | undefined,
): Promise<{ p: Person; c: Candidate }[]> {
  const found = await Promise.all(people.map((p) => each(p, () => store.search(h, p, terms, range, want, skip?.(p)), [])));
  const owner = new Map(found.flatMap((cs, i) => cs.map((c) => [c, people[i]!] as const)));
  return rankHits(found, want).map((c) => ({ p: owner.get(c)!, c }));
}

export function searchTerms(query: string): { terms: string[]; labs: boolean } {
  const terms = fold(query)
    .split(' ')
    .filter((t) => t !== '');
  return { terms, labs: LAB_QUERIES.includes(terms.join(' ')) };
}

/** The store over the records folder's own files, read whole. */
export class RawStore implements Store {
  constructor(readonly folder: Folder) {}

  /** Events are medrec's alone, in its views, which this store does not read. */
  async events(_h: Household, p: Person): Promise<JsonObject[]> {
    throw eventsNotPrepared(p);
  }

  /** Private items are medrec's to mark, in its views, which this store does not read. */
  async privacy(_h: Household, _p: Person): Promise<Privacy> {
    return { areas: new Map(), unknown: { why: 'not-prepared', detail: 'this connector is reading their files, which do not say' } };
  }

  /** So are payments. */
  async bills(_h: Household, _p: Person): Promise<ReadonlyMap<string, Standing> | null> {
    return null;
  }

  /** And the names of codes. */
  async codeNames(_h: Household, _p: Person): Promise<CodeNames> {
    return NO_NAMES;
  }

  /** And who a printed provider is. */
  async providerLabels(_h: Household, _p: Person): Promise<ProviderLabels> {
    return NO_LABELS;
  }

  household(): Promise<Household> {
    return this.folder.household();
  }

  people(h: Household): Promise<PersonRow[]> {
    return Promise.all(h.people.map(async (p) => personRow(p, await this.folder.index(p), (await this.folder.notes(p)).length)));
  }

  async summary(h: Household, p: Person, today: string, perList: number): Promise<Summary> {
    return summarize(h, p, await this.folder.index(p), (await this.folder.notes(p)).length, today, perList);
  }

  async *records(h: Household, p: Person, kind: string, filter: RecordFilter, detailed: boolean): AsyncIterable<ListedRecord> {
    const idx = await this.folder.index(p);
    const from = sourcesOf(h, p.id, idx.imports);
    const rs = (idx.records ?? []).filter((r) => passes(r, kind, filter));
    for (const r of rs.sort(recordOrder(detailed))) yield { ...r, source: from(r) };
  }

  async tests(h: Household, p: Person, filter: RecordFilter, look?: ReadonlySet<string>): Promise<ResultRow[]> {
    const idx = await this.folder.index(p);
    const rs = (idx.records ?? []).filter((r) => r.kind === 'result' && holds(filter.range, r.date) && (filter.name === undefined || matchesCode(r, filter.name)));
    const sorted = newestFirst(rs);
    const rows = latestResults(sorted, sourcesOf(h, p.id, idx.imports));
    if (!look || look.size === 0) return rows;
    const keyOf = new Map(sorted.map((r) => [r.id, seriesKey(r)]));
    const found = new Map<string, string[]>();
    for (const r of sorted) if (look.has(r.id)) found.set(keyOf.get(r.id)!, [...(found.get(keyOf.get(r.id)!) ?? []), r.id]);
    return rows.map((row) => {
      const members = row.id === undefined ? undefined : found.get(keyOf.get(row.id)!);
      return members ? { ...row, members } : row;
    });
  }

  async *timeline(h: Household, p: Person, range: Range): AsyncIterable<Event> {
    yield* timelineEvents(h, p, await this.folder.index(p), await this.folder.notes(p), range).sort(eventOrder);
  }

  async documents(_h: Household, p: Person): Promise<DocumentEntry[]> {
    return (await this.folder.index(p)).documents ?? [];
  }

  async findDocument(h: Household, id: string): Promise<[Person, DocumentEntry] | null> {
    for (const p of h.people) {
      const d = (await this.documents(h, p)).find((x) => x.id === id);
      if (d) return [p, d];
    }
    return null;
  }

  notes(_h: Household, p: Person): Promise<Note[]> {
    return this.folder.notes(p);
  }

  async search(h: Household, p: Person, terms: string[], range: Range, want: number, skip?: Skip): Promise<Candidate[]> {
    const labs = LAB_QUERIES.includes(terms.join(' '));
    const items = await this.folder.derived(`search:${p.id}`, this.folder.personFiles(p), async () => {
      const list = searchables(await this.folder.index(p), (await this.folder.text(p)).texts ?? {}, await this.folder.notes(p));
      return { value: list, size: list.reduce((n, x) => n + x.folded.length, 0) };
    });
    const found: Candidate[] = [];
    for (const item of items) {
      if (!holds(range, item.date)) continue;
      // A lab query finds every lab record by its kind, after the items whose text holds it.
      const m = score(item.folded, terms) ?? (labs && item.lab ? { score: 0, first: -1 } : null);
      if (!m) continue;
      found.push({
        kind: item.kind,
        id: item.id,
        date: item.date,
        title: item.title,
        score: m.score,
        snippet: async () => {
          const idx = await this.folder.index(p);
          if (m.first === -1) return item.lab!(idx);
          return snippetAt(item.hay(idx, (await this.folder.text(p)).texts ?? {}, await this.folder.notes(p)), m.first);
        },
      });
    }
    return upTo(
      found.sort((a, b) => b.score - a.score || cmpOpt(b.date, a.date)),
      want,
      skip,
    );
  }

  async documentText(_h: Household, p: Person, d: DocumentEntry): Promise<string> {
    return (await this.folder.text(p)).texts?.[d.id] ?? '';
  }

  async documentRecords(_h: Household, p: Person, d: DocumentEntry): Promise<string[]> {
    return ((await this.folder.index(p)).records ?? [])
      .filter((r) => (r.documents ?? []).includes(d.id))
      .slice(0, 20)
      .map((r) => clip(r.display, CLIP));
  }
}

/** No events.json for this person: an older medrec, or views another writer made. */
export function eventsNotPrepared(p: Person): ToolError {
  return ToolError.upstream(`medrec has not prepared ${p.name}'s events for assistants`)
    .withFix("Tell the user medrec 0.9.0 or later prepares them on its next pass on the household's computer (medrec refresh), then ask again")
    .personUnavailable(p.id);
}
