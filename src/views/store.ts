// The store over the views medrec writes (src/views/format.ts): each call
// parses only the shards its answer needs. A person whose views are missing
// or older than their files is read whole when that is small enough, and
// otherwise gets an error that says the views are being prepared: never an
// answer from views that no longer match the records. Each view read is
// checked against the MD5 views.json gives it, so a pass still arriving on
// Drive is never mixed with the one before.

import { ToolError } from '../mcp/errors';
import type { Folder } from '../records/folder';
import type { DocumentEntry, Household, JsonObject, Note, Person, RecordEntry } from '../records/model';
import { RawStore, eventOrder, eventsNotPrepared, merged, passes, recordOrder, type Candidate, type RecordFilter, type Store } from '../records/store';
import { clip, cmpOpt, cmpStr, day } from '../records/text';
import {
  CLIP,
  LAB_QUERIES,
  SUMMARY_LINES,
  holds,
  matchesCode,
  resultRow,
  score,
  searchables,
  snippetAt,
  snippetIn,
  snippetWindow,
  timelineEvents,
  type Event,
  type PersonRow,
  type Range,
  type ResultRow,
  type Summary,
} from '../records/views';
import {
  VIEWS_DIR,
  HAY_ITEMS,
  personDir,
  storedName,
  viewName,
  VIEWS_INDEX,
  EVENTS_SCHEMA,
  VIEWS_SCHEMA,
  hex,
  paths,
  prefixOf,
  type DocumentView,
  type LabRow,
  type NameRow,
  type PersonViews,
  ITEMS_HEADER,
  type ItemMeta,
  type SearchShard,
  type SlimRecord,
  type Run,
  type Span,
  UNDATED,
  type SummaryView,
  type TestSeries,
  type ViewsIndex,
} from './format';

/** Bytes of index.json and text.json a person may have and still be read whole, within the Free plan's CPU. */
export const RAW_LIMIT = 300_000;

const decoder = new TextDecoder();

/** `matchesCode` over a name a kind's records carry. */
function nameMatches(code: string | null, display: string, codeDisplay: string | null, q: string): boolean {
  return matchesCode({ id: '', kind: '', display, code: { code, display: codeDisplay } } as RecordEntry, q);
}

/**
 * The shards a range can touch, newest first: dated shards from the highest
 * number down, then the undated file when no range leaves it out.
 */
function* shardsFor(run: Run, r: Range): Iterable<number> {
  for (let i = run.shards.length - 1; i >= 0; i--) {
    const [newest, oldest] = run.shards[i]!;
    // Lower numbers are older still.
    if (r.since !== undefined && cmpStr(newest, r.since) < 0) return;
    if (r.until !== undefined && cmpStr(oldest, r.until) > 0) continue;
    yield i;
  }
  if (run.undated > 0 && r.since === undefined && r.until === undefined) yield UNDATED;
}

/** A search hit from the views: its snippet is made from a few bytes of its pack. */
interface ViewsCandidate extends Candidate {
  hay?: { path: string; start: number; bytes: number; at: number; reader: PersonReader };
}

/**
 * One person's views, each read checked against the MD5 views.json gives
 * it. A view that is missing, or from another pass still arriving, is
 * refused. The survey has every view's MD5, so a check costs no request.
 */
class PersonReader {
  constructor(
    private readonly folder: Folder,
    readonly p: Person,
    readonly v: PersonViews,
  ) {}

  /** Whether the views include this file. */
  has(path: string): boolean {
    const name = viewName(this.p.id, path);
    return name !== undefined && this.v.files[name] !== undefined;
  }

  /**
   * Where the view at `path` (as `paths` names it) is stored, checked: the
   * survey has a file by that name, with the MD5 views.json gives it.
   */
  async check(path: string): Promise<string> {
    const name = viewName(this.p.id, path);
    const want = name === undefined ? undefined : this.v.files[name];
    if (want === undefined) throw preparing(this.p);
    const stored = personDir(this.p.id) + storedName(name!, want);
    const [got] = await this.folder.md5([stored]);
    if (got !== want) throw preparing(this.p);
    return stored;
  }

  async json<T>(path: string): Promise<T> {
    const x = await this.folder.parsed<T>(await this.check(path));
    if (x === null) throw preparing(this.p);
    return x;
  }

  async binary(path: string): Promise<Uint8Array> {
    const b = await this.folder.binary(await this.check(path));
    if (!b) throw preparing(this.p);
    return b;
  }

  async bytes(path: string, start: number, end: number): Promise<Uint8Array> {
    const b = await this.folder.bytes(await this.check(path), start, end);
    if (!b || b.length !== end - start) throw preparing(this.p);
    return b;
  }
}

export class ViewsStore implements Store {
  private readonly raw: RawStore;
  private state_: Promise<{ index: ViewsIndex | null; newer?: string; older?: string; fresh: Set<string> }> | null = null;
  /** Byte ranges fetched for snippets this call, by file: each one's first byte, and the bytes. */
  private windows = new Map<string, { start: number; bytes: Uint8Array }[]>();

  constructor(private readonly folder: Folder) {
    this.raw = new RawStore(folder);
  }

  household(): Promise<Household> {
    return this.folder.household();
  }

  /** The views, and whose still match household.json, index.json and text.json: one MD5 request for everyone. */
  private state(h: Household) {
    this.state_ ??= (async () => {
      const index = await this.folder.parsed<ViewsIndex>(VIEWS_INDEX);
      if (!index || index.schema !== VIEWS_SCHEMA) {
        // A later layout needs a later connector, and an earlier one a new pass of the writer; anything else is no views at all.
        const v = Number(/^medrec-views\/v(\d+)$/.exec(index?.schema ?? '')?.[1] ?? NaN);
        const current = Number(VIEWS_SCHEMA.slice(VIEWS_SCHEMA.lastIndexOf('v') + 1));
        const skew = v > current ? { newer: index!.schema } : v < current ? { older: index!.schema } : {};
        return { index: null, ...skew, fresh: new Set<string>() };
      }
      const files = ['household.json', ...h.people.flatMap((p) => [`${p.folder}/index.json`, `${p.folder}/text.json`])];
      // One request: these files' MD5s, everyone's notes.md and overrides.json (for events), and every view.
      await this.folder.survey(
        h.people.map((p) => `${VIEWS_DIR}/${p.id}`),
        [...files, ...h.people.flatMap((p) => [`${p.folder}/notes.md`, `${p.folder}/overrides.json`])],
      );
      const md5 = await this.folder.md5(files);
      const fresh = new Set<string>();
      if (md5[0] === index.household) {
        h.people.forEach((p, i) => {
          const v = index.people[p.id];
          if (v?.files && md5[1 + 2 * i] === v.index && md5[2 + 2 * i] === v.text) fresh.add(p.id);
        });
      }
      return { index, fresh };
    })();
    return this.state_;
  }

  async events(h: Household, p: Person): Promise<JsonObject[]> {
    const st = await this.state(h);
    if (st.newer) {
      throw ToolError.upstream(`medrec prepared ${p.name}'s records in a newer layout (${st.newer}) than this connector reads`).withFix(
        "Tell the user the connector needs updating: its README's Updating section has the steps",
      ).personUnavailable(p.id);
    }
    const v = st.index?.people[p.id];
    // medrec writes both beside every events.json; without them, what the events were made from cannot be checked.
    const from = v?.overrides !== undefined && v.linked !== null && typeof v.linked === 'object' && !Array.isArray(v.linked);
    if (!v?.files || v.files['events.json'] === undefined || !from) throw eventsNotPrepared(p);
    if (!st.fresh.has(p.id) || !(await this.eventsFresh(h, p, v))) {
      throw ToolError.upstream(`${p.name}'s records changed after medrec last prepared their events for assistants`).withFix(
        "Tell the user medrec prepares them on its next pass on the household's computer, then ask again; if it persists, the computer may be off",
      ).personUnavailable(p.id);
    }
    const e = await new PersonReader(this.folder, p, v).json<{ schema?: string; events?: JsonObject[] }>(paths.events(p.id));
    if (e.schema !== EVENTS_SCHEMA) {
      throw ToolError.upstream(`medrec prepared ${p.name}'s events in a layout (${String(e.schema)}) this connector does not read`).withFix(
        "Tell the user the connector needs updating: its README's Updating section has the steps",
      ).personUnavailable(p.id);
    }
    return e.events ?? [];
  }

  /**
   * Whether what else the person's events were made from is as they were:
   * their overrides.json, and the index.json and text.json of each linked
   * person (a newborn's guardians, a guardian's newborns). The survey holds
   * every MD5 this asks for.
   */
  private async eventsFresh(h: Household, p: Person, v: PersonViews): Promise<boolean> {
    const linked = Object.entries(v.linked!);
    const people = linked.map(([id]) => h.people.find((q) => q.id === id));
    if (people.some((q) => q === undefined)) return false;
    const md5 = await this.folder.md5([`${p.folder}/overrides.json`, ...people.flatMap((q) => [`${q!.folder}/index.json`, `${q!.folder}/text.json`])]);
    if (md5[0] !== (v.overrides ?? null)) return false;
    return linked.every(([, l], i) => md5[1 + 2 * i] === l.index && md5[2 + 2 * i] === l.text);
  }

  /** The person's views, or null to read their files whole (they are small); an error when neither will do. */
  private async views(h: Household, p: Person): Promise<PersonReader | null> {
    const st = await this.state(h);
    if (st.fresh.has(p.id)) return new PersonReader(this.folder, p, st.index!.people[p.id]!);
    const sizes = await Promise.all([this.folder.size(`${p.folder}/index.json`), this.folder.size(`${p.folder}/text.json`)]);
    if ((sizes[0] ?? 0) + (sizes[1] ?? 0) <= RAW_LIMIT) return null;
    if (st.newer) {
      throw ToolError.upstream(`medrec prepared ${p.name}'s records in a newer layout (${st.newer}) than this connector reads, and they are too large to read here without it`).withFix(
        "Tell the user the connector needs updating: its README's Updating section has the steps",
      ).personUnavailable(p.id);
    }
    if (st.older) {
      throw ToolError.upstream(`${p.name}'s records were prepared for assistants in an older layout (${st.older}) than this connector reads, and they are too large to read here without it`).withFix(
        "Tell the user medrec 0.8.0 or later prepares them in the current one on its next pass (medrec refresh), or `npm run views` does if they use it; then ask again",
      ).personUnavailable(p.id);
    }
    if (!st.index?.people[p.id]) {
      throw ToolError.upstream(`medrec has not prepared ${p.name}'s records for assistants, and they are too large to read here until it does`).withFix(
        "Tell the user medrec 0.8.0 or later prepares them on its next pass on the household's computer (medrec refresh), then ask again",
      ).personUnavailable(p.id);
    }
    throw ToolError.upstream(`${p.name}'s records changed after medrec last prepared them for assistants, and are too large to read here until it does`).withFix(
      "Tell the user medrec prepares them on its next pass on the household's computer, then ask again; if it persists, the computer may be off",
    ).personUnavailable(p.id);
  }

  private row(p: Person, v: PersonViews, notes: number): PersonRow {
    return {
      id: p.id,
      name: p.name,
      ...(p.birth_date !== null && p.birth_date !== undefined ? { birth_date: p.birth_date } : {}),
      adult: p.adult ?? false,
      documents: v.row.documents,
      records: v.row.records,
      studies: v.row.studies,
      notes,
      ...(v.row.newest !== undefined ? { newest: v.row.newest } : {}),
      ...(v.row.last_import !== undefined ? { last_import: v.row.last_import } : {}),
    };
  }

  /**
   * Everyone's row. A large person whose views are stale gets the counts as
   * last prepared: medrec_summary lists everyone, and one person's pending
   * refresh should not refuse a question about another. Every call that
   * reads that person's records still refuses.
   */
  async people(h: Household): Promise<PersonRow[]> {
    return Promise.all(
      h.people.map(async (p) => {
        const v = await this.views(h, p).then(
          (r) => r?.v ?? null,
          async (e: unknown) => {
            const last = e instanceof ToolError && e.unavailable === p.id ? (await this.state(h)).index?.people[p.id] : undefined;
            if (last) return last;
            throw e;
          },
        );
        if (!v) return (await this.raw.people({ ...h, people: [p] }))[0]!;
        return this.row(p, v, (await this.folder.notes(p)).length);
      }),
    );
  }

  async summary(h: Household, p: Person, today: string, perList: number): Promise<Summary> {
    const r = await this.views(h, p);
    if (!r || perList !== SUMMARY_LINES) return this.raw.summary(h, p, today, perList);
    const s = await r.json<SummaryView>(paths.summary(p.id));
    return {
      ...s,
      person: this.row(p, r.v, (await this.folder.notes(p)).length),
      as_of: today,
      bills: { items: s.bills.items.map((b) => ({ ...b, past_due: b.due_date !== undefined && b.due_date !== null && cmpStr(b.due_date, today) < 0 })), more: s.bills.more },
    };
  }

  async *records(h: Household, p: Person, kind: string, filter: RecordFilter, detailed: boolean): AsyncIterable<RecordEntry> {
    const r = await this.views(h, p);
    if (!r) return yield* this.raw.records(h, p, kind, filter, detailed);
    const run = r.v.records[kind] ?? { shards: [], undated: 0 };
    let only: Set<number> | null = null;
    if (filter.name !== undefined) {
      const names = await r.json<NameRow[]>(paths.names(p.id, kind));
      only = new Set(names.filter(([c, d, cd]) => nameMatches(c, d, cd, filter.name!)).flatMap((n) => n[3]));
    }
    for (const i of shardsFor(run, filter.range)) {
      if (only && !only.has(i)) continue;
      const shard = (await r.json<SlimRecord[]>(paths.records(p.id, kind, i))) as RecordEntry[];
      const pass = shard.filter((x) => passes(x, kind, filter));
      // A shard holds whole days in the concise order; detailed orders by the full date within them.
      if (detailed) pass.sort(recordOrder(true));
      yield* pass;
    }
  }

  async tests(h: Household, p: Person, filter: RecordFilter): Promise<ResultRow[]> {
    const reader = await this.views(h, p);
    if (!reader) return this.raw.tests(h, p, filter);
    const series = await reader.json<TestSeries[]>(paths.tests(p.id));
    const rows: { rank: number; shard: number; pos: number; results: number; first?: string }[] = [];
    for (const t of series) {
      let head: TestSeries['entries'][number] | undefined;
      let n = 0;
      let first: string | undefined;
      for (const e of t.entries) {
        const [date, ni] = e;
        if (!holds(filter.range, date)) continue;
        if (filter.name !== undefined) {
          const [c, d, cd] = t.names[ni]!;
          if (!nameMatches(c, d, cd, filter.name)) continue;
        }
        n++;
        if (!head) {
          head = e;
          first = day(date);
        } else if (date !== null) first = day(date);
      }
      if (head) rows.push({ rank: head[4], shard: head[2], pos: head[3], results: n, ...(first !== undefined ? { first } : {}) });
    }
    rows.sort((a, b) => a.rank - b.rank);
    const out: ResultRow[] = [];
    for (const r of rows) {
      const shard = (await reader.json<SlimRecord[]>(paths.records(p.id, 'result', r.shard))) as RecordEntry[];
      const rec = shard[r.pos];
      if (!rec) throw preparing(p);
      out.push({ ...resultRow(h, rec), results: r.results, first_date: r.first });
    }
    return out;
  }

  async *timeline(h: Household, p: Person, range: Range): AsyncIterable<Event> {
    const r = await this.views(h, p);
    if (!r) return yield* this.raw.timeline(h, p, range);
    const folder = this.folder;
    async function* fromViews(): AsyncIterable<Event> {
      for (const i of shardsFor(r!.v.timeline, range)) {
        for (const e of await r!.json<Omit<Event, 'person' | 'person_name'>[]>(paths.timeline(p.id, i))) {
          if (holds(range, e.date)) yield { ...e, person: p.id, person_name: p.name };
        }
      }
    }
    async function* fromNotes(): AsyncIterable<Event> {
      const empty = { schema: 'medrec-index/v1', documents: [], records: [], studies: [] };
      yield* timelineEvents(h, p, empty, await folder.notes(p), range).sort(eventOrder);
    }
    // In the files' order notes come after the rest, so on a tie the views' events go first.
    yield* merged([fromViews(), fromNotes()], eventOrder);
  }

  async documents(h: Household, p: Person): Promise<DocumentEntry[]> {
    const r = await this.views(h, p);
    if (!r) return this.raw.documents(h, p);
    return r.json<DocumentView[]>(paths.documents(p.id));
  }

  /**
   * Looks through everyone it can read. A person it cannot read right now
   * (views stale, still arriving, or a newer layout) is passed over, and their
   * error is the answer only when no one else has the id: it may be theirs.
   */
  async findDocument(h: Household, id: string): Promise<[Person, DocumentEntry] | null> {
    let unreadable: ToolError | undefined;
    for (const p of h.people) {
      let docs: DocumentEntry[];
      try {
        docs = await this.documents(h, p);
      } catch (e) {
        if (!(e instanceof ToolError && e.unavailable === p.id)) throw e;
        unreadable ??= e;
        continue;
      }
      const d = docs.find((x) => x.id === id);
      if (d) return [p, d];
    }
    if (unreadable) throw unreadable;
    return null;
  }

  notes(_h: Household, p: Person): Promise<Note[]> {
    return this.folder.notes(p);
  }

  async documentText(h: Household, p: Person, d: DocumentEntry): Promise<string> {
    const r = await this.views(h, p);
    if (!r) return this.raw.documentText(h, p, d);
    const at = (d as DocumentView).text_at;
    if (!at) return '';
    const [pack, start, bytes] = at;
    return decoder.decode(await r.bytes(paths.text(p.id, pack), start, start + bytes));
  }

  async documentRecords(h: Household, p: Person, d: DocumentEntry): Promise<string[]> {
    if (!(await this.views(h, p))) return this.raw.documentRecords(h, p, d);
    return ((d as DocumentView).linked ?? []).map((n) => clip(n, CLIP));
  }

  /** A person's search items (search-items.bin): their count, and each one's text and details. */
  private async items(r: PersonReader): Promise<Items> {
    const b = await r.binary(paths.items(r.p.id));
    if (b.length < 4) throw preparing(r.p);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = view.getUint32(0, true);
    if (b.length < ITEMS_HEADER(n)) throw preparing(r.p);
    const base = ITEMS_HEADER(n);
    const text = (i: number) => view.getUint32(4 * (1 + i), true);
    const metaAt = (i: number) => view.getUint32(4 * (2 + n + i), true);
    return {
      n,
      text: (i) => [text(i), text(i + 1)],
      meta: (i) => JSON.parse(decoder.decode(b.subarray(base + metaAt(i), base + metaAt(i + 1)))) as ItemMeta,
    };
  }

  async search(h: Household, p: Person, terms: string[], range: Range, want: number): Promise<Candidate[]> {
    const r = await this.views(h, p);
    if (!r) return this.raw.search(h, p, terms, range, want);
    const labs = LAB_QUERIES.includes(terms.join(' '));

    const items = await this.items(r);
    // Refused here rather than at the snippets, so a question about everyone can leave this person out.
    for (let k = 0; k * HAY_ITEMS < items.n; k++) await r.check(paths.hay(p.id, k));
    const [lo, hi] = runOf(items, range);
    // Items holding every term, each as a word prefix: occurrences, and the first one's byte.
    const scores = new Float64Array(items.n);
    const firstAt = new Float64Array(items.n).fill(Infinity);
    const terms_ = new Uint8Array(items.n);
    let matched = 0;
    for (let ti = 0; ti < terms.length; ti++) {
      const t = terms[ti]!;
      // A term of two characters or more is in one two-character shard; of one, in its one-character shard.
      const short = [...t].length < 2;
      const key = hex(prefixOf(t, short ? 1 : 2));
      const at = short ? paths.first(p.id, key) : paths.search(p.id, key);
      matched = 0;
      // No shard: no word starts so.
      if (r.has(at)) {
        const shard = await r.json<SearchShard>(at);
        for (const w in shard) {
          if (!w.startsWith(t)) continue;
          const list = shard[w]!;
          for (let j = 0; j < list.length; j += 3) {
            const ord = list[j]!;
            // Held every term before this one, and this word is the term's first in the item, or a later one.
            if (terms_[ord] !== ti && terms_[ord] !== ti + 1) continue;
            if (terms_[ord] === ti) {
              terms_[ord] = ti + 1;
              matched++;
            }
            scores[ord]! += list[j + 1]!;
            if (list[j + 2]! < firstAt[ord]!) firstAt[ord] = list[j + 2]!;
          }
        }
      }
      if (matched === 0) break;
    }
    const all = terms.length;
    const isHit = (ord: number) => matched > 0 && terms_[ord] === all;

    // The best `want` by score, then item number, highest first: medrec's order, as the numbers run
    // oldest to newest. Keys sort ascending: -(score, then number).
    const keys: number[] = [];
    if (matched > 0) for (let ord = lo; ord < hi; ord++) if (terms_[ord] === all) keys.push(-(scores[ord]! * 2 ** 26 + ord));
    const best = Float64Array.from(keys).sort().subarray(0, want);
    type Ranked = { c: ViewsCandidate; seq: number };
    const ranked: Ranked[] = [];
    best.forEach((key, seq) => {
      const ord = -key % 2 ** 26;
      const [date, kind, id, title] = items.meta(ord);
      const [start, end] = items.text(ord);
      // Offsets count over every pack; a pack starts at its first item's text.
      const k = Math.floor(ord / HAY_ITEMS);
      const base = items.text(k * HAY_ITEMS)[0];
      const c: ViewsCandidate = {
        kind,
        id,
        date: date ?? undefined,
        title,
        score: scores[ord]!,
        hay: { path: paths.hay(p.id, k), start: start - base, bytes: end - start, at: firstAt[ord]!, reader: r },
        snippet: () => this.snippet(c),
      };
      ranked.push({ c, seq });
    });

    // Notes are read as they are, and come after everything else in the files' order.
    const notes = await this.folder.notes(p);
    const noteItems = searchables({ schema: 'medrec-index/v1' }, {}, notes);
    noteItems.forEach((item, i) => {
      if (!holds(range, item.date)) return;
      const m = score(item.folded, terms);
      if (!m) return;
      ranked.push({
        seq: want + i,
        c: { kind: item.kind, id: item.id, date: item.date, title: item.title, score: m.score, snippet: async () => snippetAt(item.hay({ schema: 'medrec-index/v1' }, {}, notes), m.first) },
      });
    });
    ranked.sort((a, b) => b.c.score - a.c.score || cmpOpt(b.c.date, a.c.date) || a.seq - b.seq);
    const out = ranked.slice(0, want).map((r) => r.c);

    // A lab query's finds by kind score 0: after every text hit, highest item number first.
    for (let i = r.v.search.labs - 1; labs && out.length < want && i >= 0; i--) {
      const rows = await r.json<LabRow[]>(paths.labs(p.id, i));
      for (let j = rows.length - 1; j >= 0 && out.length < want; j--) {
        const [ord, date, kind, id, title, snippet] = rows[j]!;
        if (isHit(ord) || !holds(range, date)) continue;
        out.push({ kind, id, date: date ?? undefined, title, score: 0, snippet: async () => snippet });
      }
    }
    return out;
  }

  /** Reads the bytes the hits' snippets need from each person's hay packs: near ones as one range, and as many ranges as the call may still make. */
  async prepare(hits: Candidate[]): Promise<void> {
    const wanted = new Map<string, [number, number][]>();
    const readers = new Map<string, PersonReader>();
    for (const c of hits as ViewsCandidate[]) {
      if (!c.hay || this.covered(c)) continue;
      const [ws, we] = snippetWindow(c.hay.bytes, c.hay.at);
      const list = wanted.get(c.hay.path) ?? (wanted.set(c.hay.path, []), wanted.get(c.hay.path)!);
      list.push([c.hay.start + ws, c.hay.start + we]);
      readers.set(c.hay.path, c.hay.reader);
    }
    await Promise.all(
      [...planRanges(wanted, Math.min(this.folder.remaining() - 2, SNIPPET_RANGES))].map(async ([path, spans]) => {
        const reader = readers.get(path)!;
        const got = await Promise.all(spans.map(async ([a, b]) => ({ start: a, bytes: await reader.bytes(path, a, b) })));
        this.windows.set(path, [...(this.windows.get(path) ?? []), ...got]);
      }),
    );
  }

  /** The fetched window holding the hit's snippet, if one does. */
  private covered(c: ViewsCandidate): { start: number; bytes: Uint8Array } | undefined {
    const hay = c.hay!;
    const [ws, we] = snippetWindow(hay.bytes, hay.at);
    return this.windows.get(hay.path)?.find((w) => w.start <= hay.start + ws && w.start + w.bytes.length >= hay.start + we);
  }

  private async snippet(c: ViewsCandidate): Promise<string> {
    let w = this.covered(c);
    if (!w) {
      await this.prepare([c]);
      w = this.covered(c)!;
    }
    // The window holds the file's bytes from w.start; the item's text starts at hay.start.
    return snippetIn(w.bytes, w.start - c.hay!.start, c.hay!.bytes, c.hay!.at);
  }
}

interface Items {
  n: number;
  /** Item i's text: its first byte over the hay packs and the byte after its last. */
  text(i: number): [number, number];
  meta(i: number): ItemMeta;
}

/**
 * The item numbers whose dates the range holds, as [first, after last]: the
 * numbers run oldest first with undated items before every dated one, so
 * they are one run.
 */
function runOf(items: Items, r: Range): [number, number] {
  if (r.since === undefined && r.until === undefined) return [0, items.n];
  const dayOf = (i: number) => day(items.meta(i)[0]);
  // The first number for which `pred` holds, where it holds from some number on.
  const from = (pred: (i: number) => boolean) => {
    let a = 0;
    let b = items.n;
    while (a < b) {
      const m = (a + b) >> 1;
      if (pred(m)) b = m;
      else a = m + 1;
    }
    return a;
  };
  const lo = from((i) => {
    const d = dayOf(i);
    return d !== undefined && (r.since === undefined || cmpStr(d, r.since) >= 0);
  });
  const hi = r.until === undefined ? items.n : from((i) => {
    const d = dayOf(i);
    return d !== undefined && cmpStr(d, r.until!) > 0;
  });
  return [lo, Math.max(lo, hi)];
}

/** Spans this close are read as one range. */
const NEAR = 16_384;

/**
 * At most this many ranges for one page's snippets. Fewer, longer ranges
 * cost CPU in reading their bodies, and more, shorter ones in their
 * requests. Around 16 cost least in the bench (bench/views.cpu.ts).
 */
const SNIPPET_RANGES = 16;

/**
 * The ranges to read for each file's spans: spans within NEAR bytes joined,
 * then the closest pair anywhere joined until at most `max` ranges remain
 * (one a file at the least). Joining the closest first reads the fewest bytes.
 */
export function planRanges(wanted: Map<string, [number, number][]>, max: number): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let total = 0;
  for (const [path, spans] of wanted) {
    const list: [number, number][] = [];
    for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
      const last = list[list.length - 1];
      if (last && a - last[1] <= NEAR) last[1] = Math.max(last[1], b);
      else list.push([a, b]);
    }
    out.set(path, list);
    total += list.length;
  }
  while (total > Math.max(max, out.size)) {
    let best: [number, number][] | undefined;
    let at = 0;
    let gap = Number.POSITIVE_INFINITY;
    for (const list of out.values()) {
      for (let i = 0; i + 1 < list.length; i++) {
        const g = list[i + 1]![0] - list[i]![1];
        if (g < gap) {
          gap = g;
          best = list;
          at = i;
        }
      }
    }
    if (!best) break;
    best[at]![1] = Math.max(best[at]![1], best[at + 1]![1]);
    best.splice(at + 1, 1);
    total--;
  }
  return out;
}

function preparing(p: Person): ToolError {
  // A view missing, or not the one views.json names: medrec's next pass is still arriving.
  return ToolError.upstream(`${p.name}'s records are being prepared for assistants right now`).withFix('Ask again in a minute').personUnavailable(p.id);
}

export type { ViewsCandidate };
