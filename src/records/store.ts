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

import { shownIndex } from './about';
import { NO_NAMES, type CodeNames } from './code-names';
import { allOf, enteredInError, type Errors } from './errors';
import type { Folder } from './folder';
import type { Parts } from './parts';
import type { Privacy } from './private';
import type { LabelsFile } from './provider-labels';
import type { Standings } from './standing';
import { ToolError } from '../mcp/errors';
import type { DocumentEntry, Household, JsonObject, ListedRecord, Note, Person, PersonIndex, RecordEntry } from './model';
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
  /** Those entered in error: passed whatever their status, for the list to count. */
  errors?: ReadonlySet<string>;
  /** What is left out of them, where the answer names no person. */
  parts?: Parts;
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
  /** As a listed record's. */
  not_shown?: string;
  /** Ranked but left out of the answer (private.ts), and why: counted where it ranks, never shown. */
  held?: Why;
  snippet(): Promise<string>;
}

/** Why a list leaves an item out: it is private, and the question does not name it; or it is entered in error (`paid`: a bill the household marked a payment on). */
export type Why = 'private' | 'error' | 'paid';

/** Which hits a search leaves out where they rank, and why. */
export type Skip = (c: { id: string; title: string }) => Why | undefined;

/**
 * The first hits of `ranked` up to `want` not left out, with those left out
 * (`skip`) that rank among them, flagged `held`.
 */
export function upTo<T extends { held?: Why }>(ranked: T[], want: number, skip?: (x: T) => Why | undefined): T[] {
  const out: T[] = [];
  let kept = 0;
  for (const x of ranked) {
    if (kept >= want) break;
    x.held ??= skip?.(x);
    if (x.held === undefined) kept++;
    out.push(x);
  }
  return out;
}

/** What is paid and left on one bill, from the person's bills.json (medrec 0.9.1 and later). */
export interface Standing {
  settled: boolean;
  left?: string;
}

/** A person's bills, from their bills.json. */
export interface Bills {
  /** What is paid and left on each that stands, by document id. */
  standing: ReadonlyMap<string, Standing>;
  /** Those entered in error, and whether the household marked a payment on each (medrec 0.9.9 and later). */
  lost: ReadonlyMap<string, boolean>;
  /** How many payments are kept on the bill a paper entered in error is of, and not applied. */
  kept(paper: string): number;
}

/** A person's events, from their events.json. */
export interface Events {
  events: readonly JsonObject[];
  /** Those that are none without what is entered in error (medrec 0.9.9 and later). */
  lost: readonly JsonObject[];
  /** How many of the household's decisions name an item entered in error, and are not applied. */
  kept(id: string): number;
}

export const NO_EVENTS: Events = { events: [], lost: [], kept: () => 0 };

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
  /**
   * A person's documents, records, studies and notes as timeline events in the
   * range, ordered as the records tool lists them. Here and below, `parts` is
   * what the person's `privacy` gave: a store that knows none of it is given none.
   */
  timeline(h: Household, p: Person, range: Range, parts?: Parts): AsyncIterable<Event>;
  documents(h: Household, p: Person): Promise<DocumentEntry[]>;
  /** The document with this id, and whose it is; null when no one has it. */
  findDocument(h: Household, id: string): Promise<[Person, DocumentEntry] | null>;
  notes(h: Household, p: Person): Promise<Note[]>;
  /**
   * The person's `want` best hits, best first (score, then date, newest
   * first), not counting those `skip` holds back: these come where they
   * rank, flagged `held` (upTo). With `parts`, an item is found by what is
   * shown of it, and one found by the rest is held back.
   */
  search(h: Household, p: Person, terms: string[], range: Range, want: number, skip?: Skip, parts?: Parts): Promise<Candidate[]>;
  documentText(h: Household, p: Person, d: DocumentEntry): Promise<string>;
  /** The first 20 records filed from the document. Views from before medrec 0.9.9 give no ids. */
  documentRecords(h: Household, p: Person, d: DocumentEntry): Promise<{ id?: string; name: string }[]>;
  /** Fetch what the hits' snippets need in as few requests as the store can, before `snippet()` is called on each. */
  prepare?(hits: Candidate[]): Promise<void>;
  /**
   * The person's events, as medrec 0.9.0 and later write them in their views
   * (`events.json`, medrec-events/v1), in that file's order. Only medrec
   * groups records into events, so a person without current events gets a
   * personUnavailable error, however small their files.
   */
  events(h: Household, p: Person): Promise<Events>;
  /**
   * The person's private items (private.json, in full from medrec 0.9.5), or
   * why they are not known: never an error, since not knowing only holds
   * their items back from answers about everyone.
   */
  privacy(h: Household, p: Person): Promise<Privacy>;
  /** The person's bills (bills.json, medrec 0.9.1 and later); null when not known. */
  bills(h: Household, p: Person): Promise<Bills | null>;
  /** The plain names of the person's condition codes (code-names.json, medrec 0.9.4 and later); none when missing or stale. */
  codeNames(h: Household, p: Person): Promise<CodeNames>;
  /** Who the providers the person's items print are (providers.json, medrec 0.9.7 and later), to read; null when missing or stale. */
  providerLabels(h: Household, p: Person): Promise<LabelsFile | null>;
  /**
   * What each source says of the person's conditions, allergies and medicines
   * (standing.json, medrec 0.9.9 and later); null when missing or stale. With
   * `kind`, null too when the person has no record of it.
   */
  standings(h: Household, p: Person, kind?: string): Promise<Standings | null>;
  /**
   * The person's records and papers entered in error, by kind, which no list
   * shows; none in views from before medrec 0.9.9, which list them.
   */
  errors(h: Household, p: Person): Promise<Errors>;
  /** How many of their records and papers are about somebody else, and shown nowhere (medrec 0.9.9 and later). */
  aboutAnother(h: Household, p: Person): Promise<number>;
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
  return r.kind === kind && holds(f.range, r.date) && !(f.active && isEnded(r.status) && !f.errors?.has(r.id)) && (f.name === undefined || matchesCode(r, f.name));
}

/**
 * The first `want` items of several ordered lists merged, ties to the earlier
 * list: what a stable sort of their concatenation puts first. Of those `keep`
 * keeps, as many as `item` makes one of before it says no more are needed.
 */
export async function takeMerged<T, I>(lists: AsyncIterable<T>[], cmp: (a: T, b: T) => number, want: number, keep: (x: T) => boolean, item: (x: T) => I, full: (x: I) => boolean): Promise<{ x: T; item: I }[]> {
  const out: { x: T; item: I }[] = [];
  if (want <= 0) return out;
  for await (const x of merged(lists, cmp)) {
    if (!keep(x)) continue;
    const it = item(x);
    out.push({ x, item: it });
    if (out.length >= want || full(it)) break;
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
  /** Each person's hits left out where they rank. */
  skip?: (p: Person) => Skip | undefined,
  parts?: (p: Person) => Parts | undefined,
): Promise<{ p: Person; c: Candidate }[]> {
  const found = await Promise.all(people.map((p) => each(p, () => store.search(h, p, terms, range, want, skip?.(p), parts?.(p)), [])));
  const owner = new Map(found.flatMap((cs, i) => cs.map((c) => [c, people[i]!] as const)));
  return rankHits(found, want).map((c) => ({ p: owner.get(c)!, c }));
}

export function searchTerms(query: string): { terms: string[]; labs: boolean } {
  const terms = fold(query)
    .split(' ')
    .filter((t) => t !== '');
  return { terms, labs: LAB_QUERIES.includes(terms.join(' ')) };
}

/**
 * What of an open claim or paper is private is known from the views alone
 * (`privacy`), so a store of files is asked to leave none of it out. An
 * event's part is the tools' own to leave out.
 */
function noParts(parts: Parts | undefined): void {
  for (const id of parts?.keys() ?? []) if (!id.startsWith('e_')) throw new Error('private parts are of views, and this store reads files');
}

/** The store over the records folder's own files, read whole. */
export class RawStore implements Store {
  private readonly shown_ = new Map<string, Promise<{ idx: PersonIndex; from: string }>>();

  constructor(
    readonly folder: Folder,
    /** The ids medrec's views say are about somebody else, to leave out of a person's files too. */
    private readonly aside: (h: Household, p: Person) => Promise<readonly string[]> = async () => [],
  ) {}

  /** A person's index as answers show it, without what is about somebody else, and what that was told from: one for a call's several readers. */
  private shown(h: Household, p: Person): Promise<{ idx: PersonIndex; from: string }> {
    let s = this.shown_.get(p.id);
    if (!s) this.shown_.set(p.id, (s = this.show(h, p)));
    return s;
  }

  private async show(h: Household, p: Person): Promise<{ idx: PersonIndex; from: string }> {
    const also = await this.aside(h, p);
    const from = JSON.stringify([p.birth_date ?? null, also]);
    const path = `${p.folder}/index.json`;
    const made = async () => ({ value: shownIndex(p, await this.folder.index(p), also), size: (await this.folder.size(path)) ?? 0 });
    return { idx: await this.folder.derived(`shown:${p.id}`, [path], made, from), from };
  }

  protected async index(h: Household, p: Person): Promise<PersonIndex> {
    return (await this.shown(h, p)).idx;
  }

  /** The ids entered in error, of any kind. */
  private async errorsIn(h: Household, p: Person): Promise<ReadonlySet<string>> {
    return allOf(await this.errors(h, p));
  }

  /** Events are medrec's alone, in its views, which this store does not read. */
  async events(_h: Household, p: Person): Promise<Events> {
    throw eventsNotPrepared(p);
  }

  /** Private items are medrec's to mark, in its views, which this store does not read. */
  async privacy(_h: Household, _p: Person): Promise<Privacy> {
    return { areas: new Map(), unknown: { why: 'not-prepared', detail: 'this connector is reading their files, which do not say' } };
  }

  /** So are payments. */
  async bills(_h: Household, _p: Person): Promise<Bills | null> {
    return null;
  }

  /** And the names of codes. */
  async codeNames(_h: Household, _p: Person): Promise<CodeNames> {
    return NO_NAMES;
  }

  /** And who a printed provider is. */
  async providerLabels(_h: Household, _p: Person): Promise<LabelsFile | null> {
    return null;
  }

  /** And what each source says. */
  async standings(_h: Household, _p: Person, _kind?: string): Promise<Standings | null> {
    return null;
  }

  async errors(h: Household, p: Person): Promise<Errors> {
    return enteredInError(await this.index(h, p));
  }

  async aboutAnother(h: Household, p: Person): Promise<number> {
    return (await this.index(h, p)).about_another?.length ?? 0;
  }

  household(): Promise<Household> {
    return this.folder.household();
  }

  people(h: Household): Promise<PersonRow[]> {
    return Promise.all(h.people.map(async (p) => personRow(p, await this.index(h, p), (await this.folder.notes(p)).length)));
  }

  async summary(h: Household, p: Person, today: string, perList: number): Promise<Summary> {
    return summarize(h, p, await this.index(h, p), (await this.folder.notes(p)).length, today, perList, await this.errorsIn(h, p));
  }

  async *records(h: Household, p: Person, kind: string, filter: RecordFilter, detailed: boolean): AsyncIterable<ListedRecord> {
    noParts(filter.parts);
    const idx = await this.index(h, p);
    const from = sourcesOf(h, p.id, idx.imports);
    const rs = (idx.records ?? []).filter((r) => passes(r, kind, filter));
    for (const r of rs.sort(recordOrder(detailed))) yield { ...r, source: from(r) };
  }

  async tests(h: Household, p: Person, filter: RecordFilter, look?: ReadonlySet<string>): Promise<ResultRow[]> {
    const idx = await this.index(h, p);
    const rs = (idx.records ?? []).filter(
      (r) => r.kind === 'result' && holds(filter.range, r.date) && !filter.errors?.has(r.id) && (filter.name === undefined || matchesCode(r, filter.name)),
    );
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

  async *timeline(h: Household, p: Person, range: Range, parts?: Parts): AsyncIterable<Event> {
    noParts(parts);
    yield* timelineEvents(h, p, await this.index(h, p), await this.folder.notes(p), range).sort(eventOrder);
  }

  async documents(h: Household, p: Person): Promise<DocumentEntry[]> {
    return (await this.index(h, p)).documents ?? [];
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

  async search(h: Household, p: Person, terms: string[], range: Range, want: number, skip?: Skip, parts?: Parts): Promise<Candidate[]> {
    noParts(parts);
    const labs = LAB_QUERIES.includes(terms.join(' '));
    const { idx, from } = await this.shown(h, p);
    // Its items are of the index as shown, by their places in it.
    const items = await this.folder.derived(
      `search:${p.id}`,
      this.folder.personFiles(p),
      async () => {
        const list = searchables(idx, (await this.folder.text(p)).texts ?? {}, await this.folder.notes(p));
        return { value: list, size: list.reduce((n, x) => n + x.folded.length, 0) };
      },
      from,
    );
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

  async documentRecords(h: Household, p: Person, d: DocumentEntry): Promise<{ id?: string; name: string }[]> {
    const gone = await this.errorsIn(h, p);
    return ((await this.index(h, p)).records ?? [])
      .filter((r) => (r.documents ?? []).includes(d.id) && !gone.has(r.id))
      .slice(0, 20)
      .map((r) => ({ id: r.id, name: clip(r.display, CLIP) }));
  }
}

/** No events.json for this person: an older medrec, or views another writer made. */
export function eventsNotPrepared(p: Person): ToolError {
  return ToolError.upstream(`medrec has not prepared ${p.name}'s events for assistants`)
    .withFix("Tell the user medrec 0.9.0 or later prepares them on its next pass on the household's computer (medrec refresh), then ask again")
    .personUnavailable(p.id);
}
