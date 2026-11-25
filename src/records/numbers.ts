// medrec keeps every number as its file writes it (serde_json's
// arbitrary_precision), so a lab's 4.10 stays 4.10. JSON.parse makes it 4.1.
// Here a number that would come out differently is kept as JSON.rawJSON holds
// it: its own text, which JSON.stringify writes back unchanged.

import type { ExactNumber, Json, JsonObject } from './model';

interface RawJson {
  rawJSON(text: string): ExactNumber;
  isRawJSON(v: unknown): v is ExactNumber;
  parse(text: string, reviver: (key: string, v: unknown, context: { source?: string }) => unknown): unknown;
}
// TypeScript's library does not have these yet; Node 21 and Workers do.
const { rawJSON, isRawJSON, parse } = JSON as unknown as RawJson;

/** Whether `v` is a number kept as its own text, `v.rawJSON`. */
export const isExact = isRawJSON;

export const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v) && !isExact(v);

/** A number JSON.parse may change, where a value could be, and then what may follow a value. */
const MAYBE = /(?:^|[:,[])\s*(-0|-?(?:\d+\.\d*0|0\.0{6}\d+|\d[\d.]{15,}|\d[\d.]*[eE][-+]?\d+))(?=\s*(?:[,}\]]|$))/g;

/** Whether the quote at `q` is one of a string's two, not one escaped in it. */
function bare(text: string, q: number): boolean {
  let k = q;
  while (text[k - 1] === '\\') k--;
  return (q - k) % 2 === 0;
}

/** Where `text` has a number JSON.parse would change, as [first character, after the last]. */
function changed(text: string): [number, number][] {
  const out: [number, number][] = [];
  // Not in a string, and neither is anything before it that is still to be told.
  let known = 0;
  for (const m of text.matchAll(MAYBE)) {
    const n = m[1]!;
    const at = m.index;
    if (String(Number(n)) === n) continue;
    let told = false;
    if (text[at] === ':') {
      // Outside a string a ':' follows a string's end.
      let q = at - 1;
      while (text.charCodeAt(q) <= 32) q--;
      if (text[q] !== '"' || !bare(text, q)) continue;
      // A string's start follows one of these, or a space; after anything else, the quote is an end.
      told = !'{[,:'.includes(text[q - 1]!) && text.charCodeAt(q - 1) > 32;
    }
    if (!told) {
      for (let open = text.indexOf('"', known); open !== -1 && open < at; open = text.indexOf('"', known)) {
        let end = text.indexOf('"', open + 1);
        while (end !== -1 && !bare(text, end)) end = text.indexOf('"', end + 1);
        if (end === -1) return out;
        known = end + 1;
      }
      if (at < known) continue;
    }
    known = at + m[0].length;
    out.push([known - n.length, known]);
  }
  return out;
}

/** Starts the string that stands for a number while the text is parsed. No string of it starts so: see parseExact. */
const MARK = '\u0000#';
const marked = (v: unknown): v is string => typeof v === 'string' && v.startsWith(MARK);
const restored = (s: string) => rawJSON(s.slice(MARK.length));
/** Puts the numbers back in `o`, an object or array. */
function restore(o: Record<string | number, unknown> | unknown[]): void {
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const x = o[i];
      if (typeof x === 'object' && x !== null) restore(x as Record<string, unknown>);
      else if (marked(x)) o[i] = restored(x);
    }
  } else {
    for (const k in o) {
      const x = o[k];
      if (typeof x === 'object' && x !== null) restore(x as Record<string, unknown>);
      else if (marked(x)) o[k] = restored(x);
    }
  }
}

/** `text` parsed, with each number JSON.parse would change kept exact (isExact). */
export function parseExact(text: string): unknown {
  const at = changed(text);
  if (at.length === 0) return JSON.parse(text);
  // JSON writes a string that starts with a NUL only this way. Where the text
  // has one, the engine's own account of each number is used: it needs no
  // mark, and takes several times as long.
  if (text.includes('"\\u0000')) return parse(text, (_, v, { source }) => (typeof v === 'number' && source !== undefined && String(v) !== source ? rawJSON(source) : v));
  let out = '';
  let from = 0;
  for (const [a, b] of at) {
    out += `${text.slice(from, a)}"\\u0000#${text.slice(a, b)}"`;
    from = b;
  }
  const v: unknown = JSON.parse(out + text.slice(from));
  if (marked(v)) return restored(v);
  if (typeof v === 'object' && v !== null) restore(v as Record<string, unknown>);
  return v;
}
