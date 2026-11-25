// medrec keeps every number as its file writes it (serde_json's
// arbitrary_precision), so a lab's 4.10 stays 4.10. JSON.parse makes it 4.1.
// Here a number that would come out differently is kept as JSON.rawJSON holds
// it: its own text, which JSON.stringify writes back unchanged.

interface RawJson {
  rawJSON(text: string): { readonly rawJSON: string };
  isRawJSON(v: unknown): v is { readonly rawJSON: string };
}
// TypeScript's library does not have these yet; Node 21 and Workers do.
const { rawJSON, isRawJSON } = JSON as unknown as RawJson;

/** Whether `v` is a number kept as its own text, `v.rawJSON`. */
export const isExact = isRawJSON;

// A member's number that String(Number()) may not give back: one that ends in
// a zero after its point, has an exponent, is -0, or is too long for a double.
// The quote before the colon ends the member's name, and is never inside a
// string: it follows a letter, so it is not escaped, and an opening quote
// follows only punctuation.
const MAYBE = /(\w"\s*:\s*)(-?\d+\.\d*0|-?\d+(?:\.\d+)?[eE][+-]?\d+|-?\d[\d.]{15,}|-0)(?=\s*[,}])/g;
/** Starts the string that stands for a number until the text is parsed: no file holds it. */
const MARK = '\u0000#';

function restore(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith(MARK) ? rawJSON(v.slice(MARK.length)) : v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x: unknown = v[i];
      if (typeof x === 'object' && x !== null) restore(x);
    }
  } else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    for (const k in o) {
      const x = o[k];
      if (typeof x === 'string' ? x.startsWith(MARK) : typeof x === 'object' && x !== null) o[k] = restore(x);
    }
  }
  return v;
}

/** `text` parsed, with each member's number that JSON.parse would change kept exact (isExact). */
export function parseExact(text: string): unknown {
  let kept = false;
  const marked = text.replace(MAYBE, (whole, before: string, n: string) => {
    if (String(Number(n)) === n) return whole;
    kept = true;
    return `${before}"\\u0000#${n}"`;
  });
  const v: unknown = JSON.parse(marked);
  return kept ? restore(v) : v;
}
