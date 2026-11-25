// The store over the views medrec writes (src/views/format.ts): each call
// parses only the shards its answer needs. A person whose views are missing
// or older than their files is read whole when that is small enough, and
// otherwise gets an error that says the views are being prepared: never an
// answer from views that no longer match the records. Each view read is
// checked against the MD5 views.json gives it, so a pass still arriving on
// Drive is never mixed with the one before.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ToolError } from '../mcp/errors';
import { NO_NAMES, codeNamesOf, type CodeNames, type CodeNamesView } from '../records/code-names';
import type { Folder } from '../records/folder';
import type { DocumentEntry, Household, JsonObject, ListedRecord, Note, Person, RecordEntry } from '../records/model';
import { parseExact } from '../records/numbers';
import { atBase, sourcesOf } from '../records/sources';
import { RawStore, eventOrder, eventsNotPrepared, merged, passes, recordOrder, upTo, type Bills, type Candidate, type Events, type RecordFilter, type Skip, type Store } from '../records/store';
import type { Privacy } from '../records/private';
import { NO_LABELS, PROVIDERS_SCHEMA, providerLabelsOf, type LabelsFile, type ProvidersView } from '../records/provider-labels';
import { STANDING_SCHEMA, allOf, errorsOf, standingsOf, type StandingView, type Standings } from '../records/standing';
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
  BILLS_SCHEMA,
  CODE_NAMES_SCHEMA,
  PRIVATE_SCHEMA,
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

  async json<T>(path: string, parse?: (text: string) => unknown): Promise<T> {
    const x = await this.folder.parsed<T>(await this.check(path), parse);
    if (x === null) throw preparing(this.p);
    return x;
  }

  /** A shard of a kind's records, with their numbers as index.json writes them. */
  records(kind: string, shard: number): Promise<SlimRecord[]> {
    return this.json<SlimRecord[]>(paths.records(this.p.id, kind, shard), parseExact);
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

/** The files in a person's folder a view only medrec makes can depend on, by the name views.json gives their MD5. */
const MADE_FROM = { overrides: 'overrides.json', marks: 'marks.json', provider_state: 'provider-state.json' } as const;

/** Those each view medrec 0.9.1 and later make was made from, beside overrides.json. */
const DEPENDS = {
  'bills.json': ['marks'],
  'private.json': ['marks', 'provider_state'],
  'code-names.json': ['marks', 'provider_state'],
  'providers.json': ['marks', 'provider_state'],
} as const satisfies Record<string, readonly (keyof typeof MADE_FROM)[]>;

/** private.json as a reader needs it (medrec-private/v1). */
export type PrivateView = { marks_unreadable?: boolean; labels_unreadable?: boolean; unreported_studies?: unknown } & Partial<Record<'records' | 'documents' | 'events' | 'studies', Record<string, { area?: unknown }>>>;

/** The private items private.json gives, each by id with its area; all of the person's held back when their marks, or what their provider labels make private, did not read. */
export function privacyOf(view: PrivateView): Privacy {
  const areas = new Map<string, string>();
  for (const kind of ['records', 'documents', 'events', 'studies'] as const) {
    for (const [id, w] of Object.entries(view[kind] ?? {})) if (typeof w?.area === 'string') areas.set(id, w.area);
  }
  // First: every item is held back either way, and a newer medrec would not read the marks.
  if (view.labels_unreadable === true) return { areas, unknown: { why: 'labels-unreadable' } };
  if (view.marks_unreadable === true) return { areas, unknown: { why: 'marks-unreadable' } };
  const unreported = view.unreported_studies ?? [];
  if (view.studies === undefined || !Array.isArray(unreported) || !unreported.every((x) => typeof x === 'string')) {
    // medrec 0.9.4 and earlier say of no document or study that a private record or report makes it private.
    return { areas, unknown: { why: 'not-prepared', detail: 'the views medrec wrote for them do not cover linked documents and imaging studies' } };
  }
  return { areas, unjudged: new Set(unreported) };
}

/** bills.json as a reader needs it (medrec-bills/v1). */
export type BillsView = { bills?: Record<string, { settled?: unknown; left?: unknown }>; in_error?: Record<string, { as?: unknown; bill?: unknown; not_applied?: { from?: unknown }[] }> };

/** What bills.json gives of a person's bills, by document id. */
export function billsOf(view: BillsView): Bills {
  const gone = new Map(Object.entries(view.in_error ?? {}));
  const kept = (id: string) => gone.get(id)?.not_applied ?? [];
  return {
    standing: new Map(Object.entries(view.bills ?? {}).map(([id, b]) => [id, { settled: b.settled === true, ...(typeof b.left === 'string' ? { left: b.left } : {}) }])),
    lost: new Map([...gone].filter(([, g]) => g.as === 'bill').map(([id]) => [id, kept(id).some((x) => x.from === 'household')])),
    kept: (paper) => {
      const of = gone.get(paper)?.bill;
      return kept(typeof of === 'string' ? of : paper).length;
    },
  };
}

/** events.json as a reader needs it (medrec-events/v1). */
type EventsView = { schema?: string; events?: JsonObject[]; events_in_error?: JsonObject[]; in_error?: Record<string, { not_applied?: unknown[] }> };

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
      // One request: these files' MD5s, everyone's notes.md, what only medrec's own views were made from, and every view.
      await this.folder.survey(
        h.people.map((p) => `${VIEWS_DIR}/${p.id}`),
        [...files, ...h.people.flatMap((p) => ['notes.md', ...Object.values(MADE_FROM)].map((f) => `${p.folder}/${f}`))],
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

  async events(h: Household, p: Person): Promise<Events> {
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
    if (!st.fresh.has(p.id) || !(await this.derivedFresh(h, p, v, []))) {
      throw ToolError.upstream(`${p.name}'s records changed after medrec last prepared their events for assistants`).withFix(
        "Tell the user medrec prepares them on its next pass on the household's computer, then ask again; if it persists, the computer may be off",
      ).personUnavailable(p.id);
    }
    const e = await new PersonReader(this.folder, p, v).json<EventsView>(paths.events(p.id));
    if (e.schema !== EVENTS_SCHEMA) {
      throw ToolError.upstream(`medrec prepared ${p.name}'s events in a layout (${String(e.schema)}) this connector does not read`).withFix(
        "Tell the user the connector needs updating: its README's Updating section has the steps",
      ).personUnavailable(p.id);
    }
    const gone = new Map(Object.entries(e.in_error ?? {}));
    return { events: e.events ?? [], lost: e.events_in_error ?? [], kept: (id) => gone.get(id)?.not_applied?.length ?? 0 };
  }

  /**
   * Whether what else a view only medrec makes was made from is as it was:
   * the person's overrides.json, the files in `too`, and the index.json and
   * text.json of each linked person (a newborn's guardians, a guardian's
   * newborns). The survey holds every MD5 this asks for.
   */
  private async derivedFresh(h: Household, p: Person, v: PersonViews, too: readonly (keyof typeof MADE_FROM)[]): Promise<boolean> {
    const linked = Object.entries(v.linked!);
    const people = linked.map(([id]) => h.people.find((q) => q.id === id));
    if (people.some((q) => q === undefined)) return false;
    const keys = ['overrides', ...too] as const;
    const own = keys.map((k) => `${p.folder}/${MADE_FROM[k]}`);
    const md5 = await this.folder.md5([...own, ...people.flatMap((q) => [`${q!.folder}/index.json`, `${q!.folder}/text.json`])]);
    if (keys.some((k, i) => md5[i] !== (v[k] ?? null))) return false;
    const at = own.length;
    return linked.every(([, l], i) => md5[at + 2 * i] === l.index && md5[at + 1 + 2 * i] === l.text);
  }

  /**
   * A view medrec 0.9.1 and later make from the person's views and their
   * marks.json (bills.json), and from what a provider directory gave too
   * (private.json, code-names.json, providers.json), when it is current, in
   * `schema`; otherwise why not.
   */
  private async derived<T>(h: Household, p: Person, name: keyof typeof DEPENDS, schema: string, empty?: string): Promise<{ view: T } | { not: string }> {
    const found = await this.findDerived(h, p, name);
    return 'not' in found ? found : this.readDerived<T>(p, found.v, name, schema, empty);
  }

  private async readDerived<T>(p: Person, v: PersonViews, name: keyof typeof DEPENDS, schema: string, empty?: string): Promise<{ view: T } | { not: string }> {
    // The view medrec writes for a person with nothing in it, known by its MD5 without reading it.
    if (empty !== undefined && createHash('md5').update(empty).digest('hex') === v.files[name]) return { view: JSON.parse(empty) as T };
    let view: { schema?: string };
    try {
      view = await new PersonReader(this.folder, p, v).json<{ schema?: string }>(`${VIEWS_DIR}/${p.id}/${name}`);
    } catch (e) {
      if (e instanceof ToolError && e.unavailable === p.id) return { not: `medrec's ${name} for them is still arriving` };
      throw e;
    }
    if (view.schema !== schema) return { not: `their ${name} is in a layout (${String(view.schema)}) this connector does not read` };
    return { view: view as T };
  }

  /** The person's entry in views.json when such a view is current; otherwise why not. It costs no request. */
  private async findDerived(h: Household, p: Person, name: keyof typeof DEPENDS): Promise<{ v: PersonViews } | { not: string }> {
    const st = await this.state(h);
    if (st.newer) return { not: `their views are in a newer layout (${st.newer}) than this connector reads` };
    const v = st.index?.people[p.id];
    // medrec writes these three beside every such view; without them, what it was made from cannot be checked.
    const from = v?.overrides !== undefined && v.marks !== undefined && v.linked !== null && typeof v.linked === 'object' && !Array.isArray(v.linked);
    if (!v?.files || v.files[name] === undefined || !from) return { not: `medrec has written no ${name} for them yet` };
    const on: readonly (keyof typeof MADE_FROM)[] = DEPENDS[name];
    if (on.includes('provider_state') && (v.provider_state ?? null) === null && (await this.hasProviderState(p))) {
      return { not: `their views were made without the ${MADE_FROM.provider_state} now in their folder` };
    }
    if (!st.fresh.has(p.id) || !(await this.derivedFresh(h, p, v, on))) return { not: `their records changed after medrec last wrote their ${name}` };
    return { v };
  }

  async privacy(h: Household, p: Person): Promise<Privacy> {
    // As medrec 0.9.5 and later write it for a person with nothing private and no study without a report.
    const empty = JSON.stringify({ schema: PRIVATE_SCHEMA, person: p.id, records: {}, documents: {}, events: {}, studies: {} });
    const got = await this.derived<PrivateView>(h, p, 'private.json', PRIVATE_SCHEMA, empty);
    const known: Privacy = 'not' in got ? { areas: new Map(), unknown: { why: 'not-prepared', detail: got.not } } : privacyOf(got.view);
    if (known.unknown?.why !== 'not-prepared') return known;
    // An earlier medrec's pass names no provider-state.json, so once that file is gone too, it would end this warning with the labels unjudged.
    const { index } = await this.state(h);
    const labels = index !== null && (typeof index.people[p.id]?.provider_state === 'string' || (await this.hasProviderState(p)));
    return labels ? { ...known, unknown: { ...known.unknown, needs: '0.9.7' } } : known;
  }

  /** Whether the person's folder holds what a provider directory gave. The survey has it, so it costs no request. */
  private async hasProviderState(p: Person): Promise<boolean> {
    return (await this.folder.md5([`${p.folder}/${MADE_FROM.provider_state}`]))[0] !== null;
  }

  async bills(h: Household, p: Person): Promise<Bills | null> {
    const got = await this.derived<BillsView>(h, p, 'bills.json', BILLS_SCHEMA);
    return 'not' in got ? null : billsOf(got.view);
  }

  async codeNames(h: Household, p: Person): Promise<CodeNames> {
    const got = await this.derived<CodeNamesView>(h, p, 'code-names.json', CODE_NAMES_SCHEMA);
    return 'not' in got ? NO_NAMES : codeNamesOf(got.view, p.id);
  }

  async providerLabels(h: Household, p: Person): Promise<LabelsFile | null> {
    const found = await this.findDerived(h, p, 'providers.json');
    if ('not' in found) return null;
    return {
      // The survey has it.
      size: (await this.folder.size(personDir(p.id) + storedName('providers.json', found.v.files['providers.json']!))) ?? 0,
      read: async () => {
        const got = await this.readDerived<ProvidersView>(p, found.v, 'providers.json', PROVIDERS_SCHEMA);
        return 'not' in got ? NO_LABELS : providerLabelsOf(got.view, p.id);
      },
    };
  }

  async standings(h: Household, p: Person, kind?: string): Promise<Standings | null> {
    const st = await this.state(h);
    // Made from household.json and index.json alone, so it is as current as the person's views.
    const v = st.fresh.has(p.id) ? st.index!.people[p.id]! : undefined;
    if (!v || v.files['standing.json'] === undefined || (kind !== undefined && !v.records[kind])) return null;
    let view: StandingView & { schema?: unknown };
    try {
      view = await new PersonReader(this.folder, p, v).json(`${VIEWS_DIR}/${p.id}/standing.json`);
    } catch (e) {
      if (e instanceof ToolError && e.unavailable === p.id) return null;
      throw e;
    }
    return view.schema === STANDING_SCHEMA ? standingsOf(view, p.id) : null;
  }

  async errors(h: Household, p: Person): Promise<ReadonlySet<string>> {
    const st = await this.state(h);
    return st.fresh.has(p.id) ? allOf(errorsOf(st.index!.people[p.id]!.in_error)) : new Set();
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

  async *records(h: Household, p: Person, kind: string, filter: RecordFilter, detailed: boolean): AsyncIterable<ListedRecord> {
    const r = await this.views(h, p);
    if (!r) return yield* this.raw.records(h, p, kind, filter, detailed);
    const from = viewSources(h, p);
    const run = r.v.records[kind];
    // No record of the kind: no shards of it, nor names.
    if (!run) return;
    let only: Set<number> | null = null;
    if (filter.name !== undefined) {
      const names = await r.json<NameRow[]>(paths.names(p.id, kind));
      only = new Set(names.filter(([c, d, cd]) => nameMatches(c, d, cd, filter.name!)).flatMap((n) => n[3]));
    }
    for (const i of shardsFor(run, filter.range)) {
      if (only && !only.has(i)) continue;
      const shard = await r.records(kind, i);
      const pass = shard.filter((x) => passes(x, kind, filter));
      // A shard holds whole days in the concise order; detailed orders by the full date within them.
      if (detailed) pass.sort(recordOrder(true));
      for (const x of pass) yield { ...x, source: from(x) };
    }
  }

  async tests(h: Household, p: Person, filter: RecordFilter, look?: ReadonlySet<string>): Promise<ResultRow[]> {
    const reader = await this.views(h, p);
    if (!reader) return this.raw.tests(h, p, filter, look);
    const series = await reader.json<TestSeries[]>(paths.tests(p.id));
    const wanted = look && look.size > 0 ? await this.resultsAmong(reader, series, look, filter) : undefined;
    const rows: { rank: number; shard: number; pos: number; results: number; first?: string; members: string[] }[] = [];
    series.forEach((t, si) => {
      let head: TestSeries['entries'][number] | undefined;
      let n = 0;
      let first: string | undefined;
      const members: string[] = [];
      t.entries.forEach((e, ei) => {
        const [date, ni] = e;
        if (!holds(filter.range, date)) return;
        if (filter.name !== undefined) {
          const [c, d, cd] = t.names[ni]!;
          if (!nameMatches(c, d, cd, filter.name)) return;
        }
        n++;
        const id = wanted?.get(entryKey(si, ei));
        if (id !== undefined) members.push(id);
        if (!head) {
          head = e;
          first = day(date);
        } else if (date !== null) first = day(date);
      });
      if (head) rows.push({ rank: head[4], shard: head[2], pos: head[3], results: n, ...(first !== undefined ? { first } : {}), members });
    });
    rows.sort((a, b) => a.rank - b.rank);
    const out: ResultRow[] = [];
    const from = viewSources(h, p);
    for (const r of rows) {
      const shard = await reader.records('result', r.shard);
      const rec = shard[r.pos];
      if (!rec) throw preparing(p);
      out.push({ ...resultRow(rec, from(rec)), results: r.results, first_date: r.first, ...(r.members.length > 0 ? { members: r.members } : {}) });
    }
    return out;
  }

  /**
   * Where each of `look`'s ids that is a result the filter holds sits in
   * tests.json, as entryKey(series, entry). search-items.bin gives each id's
   * kind, date and name, which pick out its entry; a shard is read only when
   * two results of one date share a name, and the filter holds one of them. A
   * private result that has no place cannot hold its series back, so these
   * views do not answer.
   */
  private async resultsAmong(r: PersonReader, series: TestSeries[], look: ReadonlySet<string>, filter: RecordFilter): Promise<Map<string, string>> {
    const items = await this.items(r);
    const found = items.find(look);
    if (found.length !== look.size) throw preparing(r.p);
    const byDateName = new Map<string, [number, number][]>();
    series.forEach((t, si) =>
      t.entries.forEach(([date, ni], ei) => {
        const k = `${date ?? ''}\u0000${t.names[ni]![1]}`;
        byDateName.set(k, [...(byDateName.get(k) ?? []), [si, ei]]);
      }),
    );
    const named = ([si, ei]: [number, number]) => filter.name === undefined || nameMatches(...series[si]!.names[series[si]!.entries[ei]![1]]!, filter.name);
    const out = new Map<string, string>();
    for (const i of found) {
      const [date, kind, id, title] = items.meta(i);
      if (kind !== 'result' || !holds(filter.range, date)) continue;
      const at = byDateName.get(`${date ?? ''}\u0000${title}`) ?? [];
      const asked = at.filter(named);
      let place = at.length === 1 ? asked[0] : undefined;
      if (at.length > 1) {
        for (const [si, ei] of asked) {
          const [, , shard, pos] = series[si]!.entries[ei]!;
          const recs = await r.records('result', shard);
          if (recs[pos]?.id !== id) continue;
          place = [si, ei];
          break;
        }
      }
      if (place) out.set(entryKey(...place), id);
      // Every entry it may be was looked at, and none is it.
      else if (asked.length === at.length) throw preparing(r.p);
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

  async documentRecords(h: Household, p: Person, d: DocumentEntry): Promise<{ id?: string; name: string }[]> {
    if (!(await this.views(h, p))) return this.raw.documentRecords(h, p, d);
    const { linked = [], linked_ids = [] } = d as DocumentView;
    return linked.map((n, i) => ({ id: linked_ids[i], name: clip(n, CLIP) }));
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
    const meta = (i: number) => JSON.parse(decoder.decode(b.subarray(base + metaAt(i), base + metaAt(i + 1)))) as ItemMeta;
    return {
      n,
      text: (i) => [text(i), text(i + 1)],
      meta,
      find(ids) {
        // One pass over the details as Latin-1, a character a byte, so each quoted id's place is its byte offset.
        const details = Buffer.from(b.buffer, b.byteOffset + base, b.byteLength - base).toString('latin1');
        const out: number[] = [];
        for (const m of details.matchAll(/"(r_[^"\\]*)"/g)) {
          if (!ids.has(m[1]!)) continue;
          // The item whose details hold this byte: the last whose details start at or before it.
          let lo = 0;
          let hi = n - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (metaAt(mid) <= m.index) lo = mid;
            else hi = mid - 1;
          }
          if (meta(lo)[2] === m[1]) out.push(lo);
        }
        return [...new Set(out)];
      },
    };
  }

  async search(h: Household, p: Person, terms: string[], range: Range, want: number, skip?: Skip): Promise<Candidate[]> {
    const r = await this.views(h, p);
    if (!r) return this.raw.search(h, p, terms, range, want, skip);
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
    const all_ = Float64Array.from(keys).sort();
    type Ranked = { c: ViewsCandidate; seq: number };
    const ranked: Ranked[] = [];
    let kept = 0;
    for (let seq = 0; seq < all_.length && kept < want; seq++) {
      const key = all_[seq]!;
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
      c.held = skip?.(c);
      if (c.held === undefined) kept++;
      ranked.push({ c, seq });
    }

    // Notes are read as they are, and come after everything else in the files' order.
    const notes = await this.folder.notes(p);
    const noteItems = searchables({ schema: 'medrec-index/v1' }, {}, notes);
    noteItems.forEach((item, i) => {
      if (!holds(range, item.date)) return;
      const m = score(item.folded, terms);
      if (!m) return;
      ranked.push({
        seq: all_.length + i,
        c: { kind: item.kind, id: item.id, date: item.date, title: item.title, score: m.score, snippet: async () => snippetAt(item.hay({ schema: 'medrec-index/v1' }, {}, notes), m.first) },
      });
    });
    ranked.sort((a, b) => b.c.score - a.c.score || cmpOpt(b.c.date, a.c.date) || a.seq - b.seq);
    const out: Candidate[] = upTo(
      ranked.map((r) => r.c),
      want,
    );
    let shown = out.filter((c) => c.held === undefined).length;

    // A lab query's finds by kind score 0: after every text hit, highest item number first.
    for (let i = r.v.search.labs - 1; labs && shown < want && i >= 0; i--) {
      const rows = await r.json<LabRow[]>(paths.labs(p.id, i));
      for (let j = rows.length - 1; j >= 0 && shown < want; j--) {
        const [ord, date, kind, id, title, snippet] = rows[j]!;
        if (isHit(ord) || !holds(range, date)) continue;
        const c: Candidate = { kind, id, date: date ?? undefined, title, score: 0, snippet: async () => snippet };
        c.held = skip?.(c);
        if (c.held === undefined) shown++;
        out.push(c);
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
  /** The records among the items whose ids are among `ids`. */
  find(ids: ReadonlySet<string>): number[];
}

/**
 * What the records of a person's views came through: the label medrec 0.9.6
 * and later write with each. Without it, what the household's sources say
 * with no patient known, as the views hold no import runs.
 */
function viewSources(h: Household, p: Person): (r: SlimRecord) => string | undefined {
  const from = sourcesOf(h, p.id);
  return (r) => {
    const label = r.provenance?.[0]?.source.label;
    if (typeof label === 'string') return label;
    return label === null ? undefined : from(signedIn(h, p, r));
  };
}

/**
 * A record of the views with its sign-in's organization. Views written by
 * medrec 0.9.3 and earlier leave `organization_id` out of a record's source.
 * The person's only sign-in with its CLI and FHIR base then says it; of
 * several, the record may be any one's, so only its CLI is known.
 */
function signedIn(h: Household, p: Person, r: SlimRecord): SlimRecord {
  const s = r.provenance?.[0]?.source;
  if (!s || s.organization_id !== undefined || s.cli === undefined || s.cli === null) return r;
  const at = new Set((h.sources ?? []).filter((x) => x.person === p.id && x.cli === s.cli && typeof x.organization === 'string' && atBase(s.fhir_base, x.fhir_base)).map((x) => x.organization!));
  if (at.size === 0) return r;
  return { ...r, provenance: [{ source: at.size === 1 ? { ...s, organization_id: [...at][0]! } : { cli: s.cli } }] };
}

/** A result's place in tests.json: its series and its entry there. */
const entryKey = (series: number, entry: number) => `${series}:${entry}`;

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
