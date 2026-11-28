// The views, written from a records folder's own files: the reference for
// what medrec writes (docs/views.md). The tests write them over synthetic
// folders and hold every answer from them to `medrec mcp`'s.
//
// Pure: it takes the parsed files and returns each view's path and bytes.

import { createHash } from 'node:crypto';
import { shownIndex } from '../records/about';
import { allOf, enteredInError } from '../records/errors';
import { withMedicines } from '../records/fields';
import type { Household, Person, PersonIndex, RecordEntry } from '../records/model';
import { heads } from '../records/panels';
import { sourcesOf, type SourceOf } from '../records/sources';
import { recordOrder, eventOrder } from '../records/store';
import { claimVaccines } from '../records/vaccines';
import { VIEWS_READER } from '../version';
import { cmpOpt, day, fold, wordStarts } from '../records/text';
import { SUMMARY_LINES, isLab, newestFirst, personRow, recordDetail, searchables, seriesKey, summarize, timelineEvents, type Event } from '../records/views';
import {
  LAB_CHUNK,
  PACK_BYTES,
  SHARD_BYTES,
  VIEWS_INDEX,
  VIEWS_SCHEMA,
  HAY_ITEMS,
  hex,
  paths,
  personDir,
  storedName,
  viewName,
  prefixOf,
  type DocumentView,
  type LabRow,
  type NameRow,
  type PersonViews,
  ITEMS_HEADER,
  type ItemMeta,
  type SearchShard,
  type SlimRecord,
  type SlimSource,
  type Run,
  type Span,
  UNDATED,
  type SummaryView,
  type TestSeries,
  type ViewsIndex,
} from './format';

export interface PersonFiles {
  person: Person;
  index: PersonIndex;
  texts: Record<string, string>;
  /** The bytes of index.json and text.json as read, for the MD5s the views record; null when absent. */
  indexBytes: Uint8Array | null;
  textBytes: Uint8Array | null;
}

export const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const encoder = new TextEncoder();
const json = (v: unknown) => JSON.stringify(v);

/** Every view of the folder, by the path it is stored at (storedName), and views.json. */
export function writeViews(h: Household, householdBytes: Uint8Array, people: PersonFiles[], medrec: string): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>();
  const index: ViewsIndex = { schema: VIEWS_SCHEMA, medrec, reader: VIEWS_READER, household: md5(householdBytes), people: {} };
  for (const f of people) {
    const pid = f.person.id;
    const views = new Map<string, string | Uint8Array>();
    const v = writePerson(h, f, views);
    for (const [path, body] of views) {
      const name = viewName(pid, path)!;
      const sum = md5(typeof body === 'string' ? encoder.encode(body) : body);
      v.files[name] = sum;
      out.set(personDir(pid) + storedName(name, sum), body);
    }
    index.people[pid] = v;
  }
  out.set(VIEWS_INDEX, json(index));
  return out;
}

/**
 * Consecutive runs of `items`, each closed once it reaches `target` bytes,
 * never between two items of one group: a day's records stay in one shard.
 */
function cut<T>(items: T[], size: (x: T) => number, target: number, group: (x: T) => string | undefined = () => undefined): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  let bytes = 0;
  for (let i = 0; i < items.length; i++) {
    const x = items[i]!;
    run.push(x);
    bytes += size(x);
    const next = items[i + 1];
    if (bytes >= target && (next === undefined || group(next) === undefined || group(next) !== group(x))) {
      out.push(run);
      run = [];
      bytes = 0;
    }
  }
  if (run.length > 0) out.push(run);
  return out;
}

const span = <T>(xs: T[], date: (x: T) => string | null | undefined): Span => [day(date(xs[0]!))!, day(date(xs[xs.length - 1]!))!, xs.length];

/**
 * A list in newest-first order cut into shards from its oldest end: shard 0
 * is the oldest, and only the newest shard grows as newer items come. A
 * shard closes once it holds SHARD_BYTES, never inside a day, and keeps its
 * items newest first. Undated items, last in the list, go apart.
 */
function cutFromOldest<T>(list: T[], dayOf: (x: T) => string | undefined, size: (x: T) => number): { shards: T[][]; undated: T[] } {
  const firstUndated = list.findIndex((x) => dayOf(x) === undefined);
  const dated = firstUndated === -1 ? list : list.slice(0, firstUndated);
  const undated = firstUndated === -1 ? [] : list.slice(firstUndated);
  // Days, oldest first, each one's items in the list's order.
  const days: T[][] = [];
  for (const x of dated) {
    const last = days[days.length - 1];
    if (last && dayOf(last[0]!) === dayOf(x)) last.push(x);
    else days.push([x]);
  }
  days.reverse();
  const shards: T[][] = [];
  let run: T[][] = [];
  let bytes = 0;
  for (const d of days) {
    run.push(d);
    bytes += d.reduce((t, x) => t + size(x), 0);
    if (bytes >= SHARD_BYTES) {
      shards.push(run.reverse().flat());
      run = [];
      bytes = 0;
    }
  }
  if (run.length > 0) shards.push(run.reverse().flat());
  return { shards, undated };
}

function slim(r: RecordEntry, from: SourceOf): SlimRecord {
  const s: SlimRecord = { id: r.id, kind: r.kind, display: r.display };
  if (r.date !== undefined) s.date = r.date;
  if (r.code !== undefined) s.code = r.code;
  if (r.status !== undefined) s.status = r.status;
  if (r.fields !== undefined) s.fields = r.fields;
  if (heads(r)) s.heading = true;
  const src = r.provenance?.[0]?.source;
  if (src) {
    const keep: SlimSource = {};
    if (typeof src.fhir_base === 'string') keep.fhir_base = src.fhir_base;
    if (typeof src.cli === 'string') keep.cli = src.cli;
    keep.organization_id = typeof src.organization_id === 'string' ? src.organization_id : null;
    keep.label = from(r) ?? null;
    s.provenance = [{ source: keep }];
  }
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const b = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) {
    b.set(p, o);
    o += p.length;
  }
  return b;
}

/** Byte packs of items' texts, each item whole in one pack: where each one went. */
function pack(texts: string[], pid: string, name: (pid: string, n: number) => string, out: Map<string, string | Uint8Array>): [pack: number, start: number, bytes: number][] {
  const at: [number, number, number][] = [];
  let parts: Uint8Array[] = [];
  let size = 0;
  let n = 0;
  const flush = () => {
    const b = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      b.set(p, o);
      o += p.length;
    }
    out.set(name(pid, n++), b);
    parts = [];
    size = 0;
  };
  for (const t of texts) {
    const b = encoder.encode(t);
    if (size > 0 && size + b.length > PACK_BYTES) flush();
    at.push([n, size, b.length]);
    parts.push(b);
    size += b.length;
  }
  if (size > 0) flush();
  return at;
}

function writePerson(h: Household, f: PersonFiles, out: Map<string, string | Uint8Array>): PersonViews {
  const { person: p, texts } = f;
  const idx = shownIndex(p, f.index);
  const pid = p.id;
  const records = idx.records ?? [];
  const errors = enteredInError(idx);
  const gone = allOf(errors);
  const from = sourcesOf(h, pid, idx.imports);
  const row = personRow(p, idx, 0);

  // ---- summary ----
  const s = summarize(h, p, idx, 0, '0000-00-00', SUMMARY_LINES, gone);
  const sv: SummaryView = {
    counts: s.counts,
    sources: s.sources,
    medications: s.medications,
    conditions: s.conditions,
    allergies: s.allergies,
    immunizations: s.immunizations,
    latest_results: s.latest_results,
    recent_visits: s.recent_visits,
    bills: s.bills,
  };
  out.set(paths.summary(pid), json(sv));

  // ---- records of each kind ----
  // The vaccines claims tell of are immunizations too, by their claim's id.
  const withClaims = [...records, ...claimVaccines(records)];
  const kinds = [...new Set(withClaims.map((r) => r.kind))].sort();
  const spans: Record<string, Run> = {};
  const where = new Map<RecordEntry, [shard: number, pos: number]>();
  for (const kind of kinds) {
    const list = withClaims.filter((r) => r.kind === kind).sort(recordOrder(false));
    const { shards, undated } = cutFromOldest(list, (r) => day(r.date), (r) => json(slim(r, from)).length);
    spans[kind] = { shards: shards.map((sh) => span(sh, (r) => r.date)), undated: undated.length };
    const names = new Map<string, NameRow>();
    const place = (sh: RecordEntry[], i: number) =>
      sh.forEach((r, pos) => {
        where.set(r, [i, pos]);
        const n: NameRow = [r.code?.code ?? null, r.display, r.code?.display ?? null, []];
        const key = json(n.slice(0, 3));
        const held = names.get(key) ?? (names.set(key, n), n);
        if (!held[3].includes(i)) held[3].push(i);
      });
    shards.forEach((sh, i) => {
      out.set(paths.records(pid, kind, i), json(sh.map((r) => slim(r, from))));
      place(sh, i);
    });
    if (undated.length > 0) {
      out.set(paths.records(pid, kind, UNDATED), json(undated.map((r) => slim(r, from))));
      place(undated, UNDATED);
    }
    out.set(paths.names(pid, kind), json([...names.values()]));
  }

  // ---- tests: each result series, newest first ----
  const results = newestFirst(records.filter((r) => r.kind === 'result' && !gone.has(r.id) && !heads(r)));
  const series = new Map<string, TestSeries>();
  results.forEach((r, rank) => {
    const key = seriesKey(r);
    const t = series.get(key) ?? (series.set(key, { names: [], entries: [] }), series.get(key)!);
    const name: [string | null, string, string | null] = [r.code?.code ?? null, r.display, r.code?.display ?? null];
    let ni = t.names.findIndex((x) => json(x) === json(name));
    if (ni === -1) ni = t.names.push(name) - 1;
    const [shard, pos] = where.get(r)!;
    t.entries.push([r.date ?? null, ni, shard, pos, rank]);
  });
  out.set(paths.tests(pid), json([...series.values()]));

  // ---- timeline: documents, records and studies (notes are read live) ----
  const events = timelineEvents(h, p, idx, [], {}).sort(eventOrder);
  const strip = ({ person: _p, person_name: _n, ...e }: Event) => e;
  const timeline = cutFromOldest(events, (e) => day(e.date), (e) => json(strip(e)).length);
  timeline.shards.forEach((sh, i) => out.set(paths.timeline(pid, i), json(sh.map(strip))));
  if (timeline.undated.length > 0) out.set(paths.timeline(pid, UNDATED), json(timeline.undated.map(strip)));

  // ---- documents and their text ----
  const docs = idx.documents ?? [];
  const withText = docs.filter((d) => (texts[d.id] ?? '') !== '');
  const textAt = pack(
    withText.map((d) => texts[d.id]!),
    pid,
    paths.text,
    out,
  );
  const located = new Map(withText.map((d, i) => [d.id, textAt[i]!]));
  const dv: DocumentView[] = docs.map((d) => {
    // What a source gave and no item shows decides what is private, and is in no view.
    const { given: _given, fields, ...rest }: DocumentView = d;
    const v: DocumentView = rest;
    // Each drug with the person's medicine of an equal code. This script marks nothing private, so it has no field private by what it says to leave out.
    if (fields && ((fields.follow_up?.length ?? 0) > 0 || (fields.drugs?.length ?? 0) > 0)) v.fields = withMedicines(fields, records);
    const at = located.get(d.id);
    if (at) v.text_at = [...at, Array.from(texts[d.id]!).length];
    const linked = records.filter((r) => (r.documents ?? []).includes(d.id) && !gone.has(r.id)).slice(0, 20);
    if (linked.length > 0) {
      v.linked = linked.map((r) => r.display);
      v.linked_ids = linked.map((r) => r.id);
    }
    return v;
  });
  out.set(paths.documents(pid), json(dv));

  // ---- search ----
  const listed = searchables(idx, texts, []);
  // Numbered in the reverse of medrec's order for hits of equal score (date, newest first, then as the
  // files hold them): the newest item has the highest number, so new items take new numbers.
  const order = listed
    .map((_, i) => i)
    .sort((a, b) => cmpOpt(listed[b]!.date, listed[a]!.date) || a - b)
    .reverse();
  const items = order.map((i) => listed[i]!);
  const hays = items.map((it) => it.hay(idx, texts, []));
  const hayBytes = hays.map((h) => encoder.encode(h));
  const metaBytes = items.map((it) => encoder.encode(json([it.date ?? null, it.kind, it.id, it.title] satisfies ItemMeta)));
  const n = items.length;
  for (let k = 0; k * HAY_ITEMS < n; k++) out.set(paths.hay(pid, k), concat(hayBytes.slice(k * HAY_ITEMS, (k + 1) * HAY_ITEMS)));
  const head = new DataView(new ArrayBuffer(ITEMS_HEADER(n)));
  head.setUint32(0, n, true);
  let at = 0;
  let mt = 0;
  for (let i = 0; i <= n; i++) {
    head.setUint32(4 * (1 + i), at, true);
    head.setUint32(4 * (2 + n + i), mt, true);
    if (i < n) {
      at += hayBytes[i]!.length;
      mt += metaBytes[i]!.length;
    }
  }
  out.set(paths.items(pid), concat([new Uint8Array(head.buffer), ...metaBytes]));
  const shards = new Map<string, SearchShard>();
  const firsts = new Map<string, SearchShard>();
  const post = (into: Map<string, SearchShard>, key: string, w: string, ord: number, count: number, first: number) => {
    const sh = into.get(key) ?? (into.set(key, {}), into.get(key)!);
    (sh[w] ??= []).push(ord, count, first);
  };
  hays.forEach((hay, ord) => {
    const folded = fold(hay);
    if (folded === '') return;
    const words = folded.split(' ');
    const starts = wordStarts(hay);
    const seen = new Map<string, [count: number, first: number]>();
    words.forEach((w, i) => {
      const held = seen.get(w);
      if (held) held[0]++;
      else seen.set(w, [1, starts[i]!]);
    });
    for (const [w, [count, first]] of seen) {
      post(shards, hex(prefixOf(w)), w, ord, count, first);
      post(firsts, hex(prefixOf(w, 1)), w, ord, count, first);
    }
  });
  const prefixes = [...shards.keys()].sort();
  for (const key of prefixes) out.set(paths.search(pid, key), json(shards.get(key)));
  const firstKeys = [...firsts.keys()].sort();
  for (const key of firstKeys) out.set(paths.first(pid, key), json(firsts.get(key)));
  const labs: LabRow[] = [];
  items.forEach((it, ord) => {
    if (it.lab) labs.push([ord, it.date ?? null, it.kind, it.id, it.title, it.lab(idx)]);
  });
  const labChunks = cut(labs, () => 1, LAB_CHUNK);
  labChunks.forEach((c, i) => out.set(paths.labs(pid, i), json(c)));

  return {
    index: f.indexBytes ? md5(f.indexBytes) : null,
    text: f.textBytes ? md5(f.textBytes) : null,
    ...(idx.about_another ? { about_another: idx.about_another } : {}),
    ...(errors.size > 0 ? { in_error: Object.fromEntries([...errors].map(([kind, ids]) => [kind, [...ids]])) } : {}),
    row: {
      documents: row.documents,
      records: row.records,
      studies: row.studies,
      ...(row.newest !== undefined ? { newest: row.newest } : {}),
      ...(row.last_import !== undefined ? { last_import: row.last_import } : {}),
    },
    records: spans,
    timeline: { shards: timeline.shards.map((sh) => span(sh, (e) => e.date)), undated: timeline.undated.length },
    search: { items: n, labs: labChunks.length },
    files: {},
  };
}

export { isLab, recordDetail };
