// What of an item that is open is private: a service of a claim, the lines of
// a bill that print it, and what an event says of it. An answer that names no
// person shows the item without it, and says how much it leaves out. medrec
// writes which parts those are (private.json's `parts`, search-parts.json, 0.9.9
// and later; medrec-cli docs/data-contract.md, "Private"). Nothing here judges
// one.

import type { Json, JsonObject, RecordEntry } from './model';
import { isObject, removed } from './numbers';

/** The parts of a person's items, by the item's id. */
export type Parts = ReadonlyMap<string, JsonObject>;

const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: Json | undefined): readonly Json[] => (Array.isArray(v) ? v : []);

/** How an item says what is left out of it. */
export const notShown = (part: JsonObject | undefined): string | undefined => str(part?.says);

/** The name an item is shown by. */
export const nameOf = (part: JsonObject | undefined, name: string): string => str(part?.display) ?? name;

/** A claim's lists, by what its part calls the places of those left out of them. */
const LISTS = { lines: 'items', diagnoses: 'diagnoses', payer_notes: 'payer_notes' } as const;

/** A claim without its private lines, and without a list whose places are not the part's. Its totals stay. */
export function shownClaim<T extends RecordEntry>(r: T, part: JsonObject | undefined): T & { not_shown?: string } {
  if (part === undefined || r.kind !== 'claim') return r;
  let fields: JsonObject = r.fields ?? {};
  for (const [k, of] of Object.entries(LISTS)) {
    const gone = new Set(list(part[k]));
    const all = fields[of];
    if (gone.size === 0 || !Array.isArray(all)) continue;
    const its = [...gone].every((i) => typeof i === 'number' && i in all);
    const left = all.filter((_, i) => its && !gone.has(i));
    fields = left.length > 0 ? { ...fields, [of]: left } : removed(fields, of);
  }
  // Of the services that are left: none when none of them has one.
  if (part.category === null) fields = removed(fields, 'category');
  else if (part.category !== undefined) fields = { ...fields, category: part.category };
  return { ...r, display: nameOf(part, r.display), fields, not_shown: notShown(part) };
}

/** An event by what its other items say, its claims by the names they are shown by: `claim` gives a member's part. */
export function shownEvent(e: JsonObject, part: JsonObject | undefined, claim: (record: string) => JsonObject | undefined): JsonObject {
  const of = (m: Json) => (isObject(m) && typeof m.record === 'string' ? claim(m.record)?.display : undefined);
  const members = list(e.members);
  if (part === undefined && !members.some((m) => of(m) !== undefined)) return e;
  const out = Object.fromEntries(Object.entries({ ...e, ...part }).filter(([k, v]) => k !== 'says' && (v !== null || part?.[k] === undefined)));
  const says = notShown(part);
  if (says !== undefined) out.not_shown = says;
  out.members = members.map((m) => {
    const title = of(m);
    return title !== undefined && isObject(m) ? { ...m, title } : m;
  });
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LINE_FEED = 0x0a;

/** Spans of a text's bytes, in order. */
type Spans = readonly (readonly [start: number, length: number])[];

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** The spans a part gives of a text of so many bytes, or undefined where they are not its own. */
function spansOf(v: Json | undefined, size: number): Spans | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: [number, number][] = [];
  let at = 0;
  for (const s of v) {
    if (!Array.isArray(s) || !whole(s[0]) || !whole(s[1]) || s[0] < at || s[0] + s[1] > size) return undefined;
    out.push([s[0], s[1]]);
    at = s[0] + s[1];
  }
  return out;
}

/** Whether a letter starts at a byte of a text, or the text ends there. */
const atLetter = (bytes: Uint8Array, at: number): boolean => ((bytes[at] ?? 0) & 0xc0) !== 0x80;

/** A paper's text without its private lines: those that follow one another are one line that says how many. Nothing of a text they are not of. */
export function shownText(text: string, part: JsonObject | undefined): string {
  if (part === undefined) return text;
  const bytes = encoder.encode(text);
  const lines = spansOf(part.text, bytes.length);
  if (!lines?.every(([start, length]) => atLetter(bytes, start) && atLetter(bytes, start + length))) return '';
  let out = '';
  let at = 0;
  let run = 0;
  for (const [i, [start, length]] of lines.entries()) {
    if (run === 0) out += decoder.decode(bytes.subarray(at, start));
    run++;
    at = start + length;
    if (lines[i + 1]?.[0] === at + 1 && bytes[at] === LINE_FEED) continue;
    out += `(${run} line${run === 1 ? '' : 's'} not shown)`;
    run = 0;
  }
  return out + decoder.decode(bytes.subarray(at));
}

/** search-parts.json as a reader needs it. */
export type SearchParts = Record<string, { cuts?: Json; words?: Record<string, number[]>; lab?: boolean }>;

/** A search item with a part: where its open text is in its own, and where its words are in it. */
export class OpenText {
  /** The name before the rest of its text, where its own is cut. */
  private readonly head: Uint8Array;

  private constructor(
    private readonly part: SearchParts[string],
    private readonly cuts: Spans,
    display: string,
    private readonly size: number,
  ) {
    this.head = encoder.encode(this.cuts[0]?.[0] === 0 ? `${display}\n` : '');
  }

  /** Of a part, the name its item is shown by, and its text's bytes; undefined where the part is of another text. */
  static of(part: SearchParts[string], display: string, size: number): OpenText | undefined {
    const cuts = spansOf(part.cuts, size);
    return cuts && new OpenText(part, cuts, display, size);
  }

  get lab(): boolean {
    return this.part.lab !== false;
  }

  /** How often a word is in the open text, and where first; undefined when it is there as in its own, moved. */
  word(w: string): { n: number; first: number } | undefined {
    const at = this.part.words?.[w];
    return at === undefined ? undefined : { n: at[0] ?? 0, first: at[1] ?? Infinity };
  }

  /** The words its part says, that start so. */
  words(prefix: string): string[] {
    return Object.keys(this.part.words ?? {}).filter((w) => w.startsWith(prefix));
  }

  /** Where a byte of its text, in no cut, is in its open text. */
  moved(at: number): number {
    let gone = 0;
    for (const [start, length] of this.cuts) if (start + length <= at) gone += length;
    return this.head.length + at - gone;
  }

  get bytes(): number {
    return this.head.length + this.size - this.cuts.reduce((n, [, length]) => n + length, 0);
  }

  /** The span of its text to read for these bytes of the open one. */
  source(from: number, to: number): [number, number] {
    return [this.original(from), this.original(Math.max(from, to - 1)) + (to > from ? 1 : 0)];
  }

  private original(open: number): number {
    let at = Math.max(0, open - this.head.length);
    for (const [start, length] of this.cuts) if (start <= at) at += length;
    return Math.min(at, this.size);
  }

  /** Those bytes of the open text, by its own from `at` on. */
  read(own: Uint8Array, at: number, from: number, to: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = i < this.head.length ? this.head[i]! : own[this.original(i) - at]!;
    return out;
  }
}

