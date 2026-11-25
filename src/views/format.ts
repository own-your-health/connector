// The views medrec writes beside a records folder's own files, for readers
// that cannot parse megabytes per request (this connector, on the Workers
// Free plan's 10 ms of CPU). Every view is derived from household.json and a
// person's index.json and text.json; notes.md is not, as it is small and
// read as it is. docs/views.md describes each file.
//
// These are the views' names. Each is stored under its name with its MD5's
// first 12 hex digits before the extension (storedName), so a stored file
// never changes; views.json keeps its own name.
//
//   views/views.json                       which views exist, and what they were made from
//   views/<person id>/summary.json         medrec_summary's summary, but for today
//   views/<person id>/records-<kind>-<n>.json   records of one kind, in the records tool's order
//   views/<person id>/names-<kind>.json    each name a kind's records carry, and their shards
//   views/<person id>/tests.json           the results of each test, newest first
//   views/<person id>/timeline-<n>.json    documents, records and studies as timeline events
//   views/<person id>/documents.json       the documents, with where their text is
//   views/<person id>/text-<n>.bin         the documents' text, UTF-8
//   views/<person id>/search-<hex>.json    the words starting with one two-character prefix, and where
//   views/<person id>/search-1-<hex>.json  the words starting with one character, for one-character terms
//   views/<person id>/search-items.bin     each searchable item: where its text is, and its date, kind, id and title
//   views/<person id>/search-hay-<n>.bin   each searchable item's text, UTF-8, for snippets, 512 items a pack
//   views/<person id>/search-labs-<n>.json what a lab query finds by kind
//   views/<person id>/events.json          medrec 0.9.0 on: what happened, one per visit, stay or fill
//   views/<person id>/bills.json           medrec 0.9.1 on: what is paid and left on each bill
//   views/<person id>/private.json         medrec 0.9.1 on: the private records, documents, events and studies
//
// Search items are numbered in the reverse of medrec's order for hits of
// equal score (date, newest first, undated last, then as the files hold
// them). So hits rank by score, then number, highest first; a date range is
// a run of numbers; and new items, nearly always the newest, take new numbers.

import type { Bill, Listed, ResultRow, SourceRow, SummaryLine, Vaccine } from '../records/views';
import type { Coding, DocumentEntry, Json, JsonObject } from '../records/model';

export const VIEWS_DIR = 'views';
/**
 * The layout. v1 (connector #1 only, never written by medrec) stored views
 * under their plain names with one search-hay.bin; v2 stores them under
 * content-addressed names with hay in packs.
 */
export const VIEWS_SCHEMA = 'medrec-views/v2';
/** events.json's own layout (medrec 0.9.0 on). */
export const EVENTS_SCHEMA = 'medrec-events/v1';
/** bills.json's own layout (medrec 0.9.1 on). */
export const BILLS_SCHEMA = 'medrec-bills/v1';
/** private.json's own layout (medrec 0.9.1 on). */
export const PRIVATE_SCHEMA = 'medrec-private/v1';
/** code-names.json's own layout (medrec 0.9.4 on). */
export const CODE_NAMES_SCHEMA = 'medrec-code-names/v1';
export const VIEWS_INDEX = `${VIEWS_DIR}/views.json`;

/** A person's views directory, with the trailing slash. */
export const personDir = (pid: string) => `${VIEWS_DIR}/${pid}/`;

/**
 * The name a view is stored under: its name with the first 12 hex digits of
 * its MD5 before the extension (`summary.json` as `summary.0a1b2c3d4e5f.json`).
 * A stored file's content never changes, so a reader holding one views.json
 * reads only that pass's files, or finds them gone.
 */
export function storedName(name: string, md5: string): string {
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)}.${md5.slice(0, 12)}${name.slice(dot)}`;
}

/** The name a path has in its person's `files`, or undefined when it is not one of their views. */
export function viewName(pid: string, path: string): string | undefined {
  const dir = personDir(pid);
  return path.startsWith(dir) && !path.slice(dir.length).includes('/') ? path.slice(dir.length) : undefined;
}

/** Shards and packs are cut near these sizes; a day's records, or one item's text, are never split. */
export const SHARD_BYTES = 48_000;
export const PACK_BYTES = 1_000_000;
export const LAB_CHUNK = 256;
/**
 * Search items to a `search-hay-<n>.bin`: pack n holds items n × 512 to
 * n × 512 + 511. A count, not a size, so a changed item rewrites only its
 * own pack, and a new newest item only the last.
 */
export const HAY_ITEMS = 512;

/** A shard's span: its newest and oldest day, and how many it holds. */
export type Span = [newest: string, oldest: string, count: number];

/** A list's dated shards by number (0 the oldest), and how many undated items its undated file holds. */
export interface Run {
  shards: Span[];
  undated: number;
}

/** The shard number that names the undated file (`records-<kind>-undated.json`, `timeline-undated.json`). */
export const UNDATED = -1;

export interface ViewsIndex {
  schema: string;
  medrec: string;
  /** MD5 (hex) of household.json as the views were made from it. */
  household: string;
  people: Record<string, PersonViews>;
}

export interface PersonViews {
  /** MD5 (hex) of index.json and text.json as the views were made from them; null when absent. */
  index: string | null;
  text: string | null;
  /** The person's counts for medrec_summary's people list (notes are counted live). */
  row: { documents: number; records: number; studies: number; newest?: string; last_import?: string };
  /** Each record kind's shards. */
  records: Record<string, Run>;
  timeline: Run;
  /** How many search items, and how many search-labs-<n>.json. */
  search: { items: number; labs: number };
  /**
   * Every file in the person's views directory, by name, with its MD5 (hex).
   * A reader checks each file it reads against this: a view whose MD5
   * differs belongs to another pass, which is still arriving.
   */
  files: Record<string, string>;
  /**
   * medrec 0.9.0 on, for events.json, and from 0.9.1 bills.json and
   * private.json: the MD5 of the person's overrides.json (null when absent),
   * and of the index.json and text.json of each person whose records the
   * newborn rules read. Other views ignore them.
   */
  overrides?: string | null;
  linked?: Record<string, { index: string | null; text: string | null }>;
  /**
   * medrec 0.9.1 on, for bills.json and private.json (with `overrides`
   * and `linked`): the MD5 of the person's marks.json, the household's
   * payments and private marks; null when there is none.
   */
  marks?: string | null;
  /**
   * medrec 0.9.7 on, for private.json and code-names.json: the MD5 of the
   * person's provider-state.json, what a provider directory gave; absent when
   * there is none. The file is medrec's own, and is never read here.
   */
  provider_state?: string | null;
  /** medrec 0.9.9 on: the ids of the person's records entered in error, by kind, as standing.json has them; absent when there are none. */
  in_error?: Json;
  /** medrec 0.9.9 on: the ids of what is in the person's chart and about somebody else, which no view has; absent when there is none. */
  about_another?: string[];
}

/** medrec_summary's summary without what depends on the day it is asked or on notes.md. */
export interface SummaryView {
  counts: Record<string, number>;
  sources: SourceRow[];
  medications: Listed<SummaryLine>;
  conditions: Listed<SummaryLine>;
  allergies: Listed<SummaryLine>;
  immunizations: Listed<Vaccine>;
  latest_results: Listed<ResultRow>;
  recent_visits: Listed<SummaryLine>;
  /** Bills as `summarize` gives them; `past_due` is recomputed against the day asked. */
  bills: Listed<Bill>;
  /** medrec 0.9.9 on: every record that standing.json has as current or on hold, in its order, to make the three lists of. */
  standing?: Record<'medications' | 'conditions' | 'allergies', SummaryLine[]>;
}

/** Where a record came from, as a view keeps it. */
export interface SlimSource {
  fhir_base?: string | null;
  cli?: string | null;
  /** Null when it has none; absent in views medrec 0.9.3 and earlier wrote. */
  organization_id?: string | null;
  /** What it came through, as `medrec mcp` shows it; null when nothing names it. Absent in views medrec 0.9.5 and earlier wrote. */
  label?: string | null;
}

/** A record as the tools need it: index.json's entry with only its first source's `source`. */
export interface SlimRecord {
  id: string;
  kind: string;
  date?: string | null;
  code?: Coding | null;
  display: string;
  status?: string | null;
  fields?: JsonObject;
  provenance?: { source: SlimSource }[];
}

/** A name records of one kind carry (code, display, code display) and the shards holding them (UNDATED for the undated file). */
export type NameRow = [code: string | null, display: string, codeDisplay: string | null, shards: number[]];

export interface TestSeries {
  /** Each name the series' results carry. */
  names: [code: string | null, display: string, codeDisplay: string | null][];
  /** Each result, newest first: its date, name, shard (UNDATED for the undated file) and place in it, and rank among all the person's results newest first. */
  entries: [date: string | null, name: number, shard: number, pos: number, rank: number][];
}

export interface DocumentView extends DocumentEntry {
  /** Where the text is: pack, byte offset, byte length, characters. */
  text_at?: [pack: number, start: number, bytes: number, chars: number];
  /** The names of the first 20 records filed from it. */
  linked?: string[];
  /** Their ids (medrec 0.9.9 and later). */
  linked_ids?: string[];
}

/**
 * A search shard: each word, and the items it occurs in as (item number,
 * occurrences, byte offset of the first in the item's text), repeated, by
 * item number.
 */
export type SearchShard = Record<string, number[]>;

/**
 * search-items.bin, little-endian unsigned 32-bit integers then UTF-8:
 *
 *   n                        the number of items
 *   text[0..n]               n + 1 byte offsets over the hay packs in order: item i's text is text[i] to text[i + 1]
 *   meta[0..n]               n + 1 byte offsets into the details below: item i's are meta[i] to meta[i + 1]
 *   details                  each item's JSON array [date or null, kind, id, title], one after another
 */
export const ITEMS_HEADER = (n: number) => 4 * (1 + 2 * (n + 1));
export type ItemMeta = [date: string | null, kind: string, id: string, title: string];

/** A lab query's finds by kind, by item number (oldest first): item number, date, kind, id, title, snippet. */
export type LabRow = [ord: number, date: string | null, kind: string, id: string, title: string, snippet: string];

/** The word's first `n` characters (code points). */
export function prefixOf(word: string, n = 2): string {
  let out = '';
  let i = 0;
  for (const c of word) {
    if (i++ === n) break;
    out += c;
  }
  return out;
}

const hexEncoder = new TextEncoder();
export function hex(s: string): string {
  let out = '';
  for (const b of hexEncoder.encode(s)) out += b.toString(16).padStart(2, '0');
  return out;
}

export const paths = {
  summary: (pid: string) => `${VIEWS_DIR}/${pid}/summary.json`,
  records: (pid: string, kind: string, n: number) => `${VIEWS_DIR}/${pid}/records-${kind}-${n === UNDATED ? 'undated' : n}.json`,
  names: (pid: string, kind: string) => `${VIEWS_DIR}/${pid}/names-${kind}.json`,
  tests: (pid: string) => `${VIEWS_DIR}/${pid}/tests.json`,
  timeline: (pid: string, n: number) => `${VIEWS_DIR}/${pid}/timeline-${n === UNDATED ? 'undated' : n}.json`,
  documents: (pid: string) => `${VIEWS_DIR}/${pid}/documents.json`,
  text: (pid: string, n: number) => `${VIEWS_DIR}/${pid}/text-${n}.bin`,
  search: (pid: string, prefixHex: string) => `${VIEWS_DIR}/${pid}/search-${prefixHex}.json`,
  first: (pid: string, charHex: string) => `${VIEWS_DIR}/${pid}/search-1-${charHex}.json`,
  labs: (pid: string, n: number) => `${VIEWS_DIR}/${pid}/search-labs-${n}.json`,
  items: (pid: string) => `${VIEWS_DIR}/${pid}/search-items.bin`,
  hay: (pid: string, n: number) => `${VIEWS_DIR}/${pid}/search-hay-${n}.bin`,
  /** medrec 0.9.0 on: what happened, one event per visit, stay or fill (medrec-events/v1); this connector does not write it. */
  events: (pid: string) => `${VIEWS_DIR}/${pid}/events.json`,
  bills: (pid: string) => `${VIEWS_DIR}/${pid}/bills.json`,
  private: (pid: string) => `${VIEWS_DIR}/${pid}/private.json`,
};

export type { Json };
