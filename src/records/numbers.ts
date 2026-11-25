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

const QUOTE = 34;
const BACKSLASH = 92;
/** Whether a character can be part of a number. */
const numeric = (c: number) => (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43 || c === 101 || c === 69;

/** Where `text` has a number JSON.parse would change, as [first character, after the last]. */
function changed(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      // To the end of the string: the next quote an even number of backslashes come before.
      let end = i;
      for (let escaped = true; escaped; ) {
        end = text.indexOf('"', end + 1);
        if (end === -1) return out;
        let k = end;
        while (text.charCodeAt(k - 1) === BACKSLASH) k--;
        escaped = (end - k) % 2 === 1;
      }
      i = end + 1;
    } else if ((c >= 48 && c <= 57) || c === 45) {
      let end = i + 1;
      while (end < text.length && numeric(text.charCodeAt(end))) end++;
      const n = text.slice(i, end);
      if (String(Number(n)) !== n) out.push([i, end]);
      i = end;
    } else i++;
  }
  return out;
}

/** Starts the string that stands for a number while the text is parsed. No string of it starts so: see parseExact. */
const MARK = '\u0000#';
const restored = (v: unknown): unknown => {
  if (typeof v === 'string') return v.startsWith(MARK) ? rawJSON(v.slice(MARK.length)) : v;
  if (typeof v === 'object' && v !== null) restore(v as Record<string | number, unknown>);
  return v;
};
function restore(o: Record<string | number, unknown>): void {
  if (Array.isArray(o)) for (let i = 0; i < o.length; i++) o[i] = restored(o[i]);
  else {
    for (const k in o) {
      const x = o[k];
      const y = restored(x);
      if (y !== x) o[k] = y;
    }
  }
}

/** `text` parsed, with each number JSON.parse would change kept exact (isExact). */
export function parseExact(text: string): unknown {
  const at = changed(text);
  if (at.length === 0) return JSON.parse(text);
  // A string that starts with a NUL is written with this escape. Where the
  // text has it, the engine's own account of each number is used: it needs no
  // mark, and takes several times as long.
  if (text.includes('\\u0000')) return parse(text, (_, v, { source }) => (typeof v === 'number' && source !== undefined && String(v) !== source ? rawJSON(source) : v));
  let marked = '';
  let from = 0;
  for (const [a, b] of at) {
    // A number is followed by one of these, or by the end; where it is not, this is not JSON, and must not become it.
    let next = b;
    while (text.charCodeAt(next) <= 32) next++;
    if (next < text.length && !',]}'.includes(text[next]!)) return JSON.parse(text);
    marked += `${text.slice(from, a)}"\\u0000#${text.slice(a, b)}"`;
    from = b;
  }
  return restored(JSON.parse(marked + text.slice(from)));
}
