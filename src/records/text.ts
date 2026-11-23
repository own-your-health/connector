// Text rules shared by every view, ported from medrec (intake/classify.rs,
// summary.rs, views.rs) so the connector answers as `medrec mcp` does:
// folding for search, clipping by characters, first lines, dates as days.

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ASCII_ALNUM = /^[A-Za-z0-9]$/;

/** One character as medrec's `fold_char`: Latin diacritics removed, lowercased. */
function foldChar(c: string): string {
  switch (true) {
    case /[À-Åà-åĀāĂăĄą]/.test(c):
      return 'a';
    case /[ÇçĆćČč]/.test(c):
      return 'c';
    case /[ĎďĐđ]/.test(c):
      return 'd';
    case /[È-Ëè-ëĒēĖėĘęĚě]/.test(c):
      return 'e';
    case /[Ì-Ïì-ïĪīĮįİı]/.test(c):
      return 'i';
    case /[ÑñŃńŇň]/.test(c):
      return 'n';
    case /[Ò-ÖØò-öøŌōŐő]/.test(c):
      return 'o';
    case /[Ù-Üù-üŪūŮůŰű]/.test(c):
      return 'u';
    case /[ÝýÿŸ]/.test(c):
      return 'y';
    case /[ŚśŠšŞş]/.test(c):
      return 's';
    case /[ŹźŻżŽž]/.test(c):
      return 'z';
    case /[Łł]/.test(c):
      return 'l';
    case /[Řř]/.test(c):
      return 'r';
    case /[Ťť]/.test(c):
      return 't';
    case c === 'ß':
      return 'ss';
    case c === 'Æ' || c === 'æ':
      return 'ae';
    default:
      // Per character, as Rust's `char::to_lowercase`: no final-sigma rule.
      return c.toLowerCase();
  }
}

const foldCache = new Map<string, string>();

export { foldChar as foldCharForTests };

/** A code point folded, cached: records repeat the same few non-ASCII letters. */
function folded(c: string): string {
  let f = foldCache.get(c);
  if (f === undefined) {
    f = foldChar(c);
    if (foldCache.size < 4096) foldCache.set(c, f);
  }
  return f;
}

const isAlnum = (c: string) => (c < '\u0080' ? ASCII_ALNUM.test(c) : ALNUM.test(c));

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const NON_ASCII = /[^\x00-\x7f]/gu;
/** After non-ASCII characters are folded, every run of what is not a letter or digit. */
const NON_WORD = /[^a-z0-9\u{80}-\u{10FFFF}]+/gu;

const wordCache = new Map<string, string>();

/** A non-ASCII character as fold() leaves it: its folded letters and digits, anything else a space. */
function foldWord(c: string): string {
  let w = wordCache.get(c);
  if (w === undefined) {
    w = '';
    for (const g of folded(c)) w += isAlnum(g) ? g : ' ';
    if (wordCache.size < 4096) wordCache.set(c, w);
  }
  return w;
}

/**
 * Lowercase, Latin diacritics removed, non-alphanumerics to single spaces,
 * trimmed: medrec's `fold`, character for character. One pass of regular
 * expressions; only non-ASCII characters are looked at one by one.
 */
export function fold(s: string): string {
  const t = ASCII_ONLY.test(s) ? s : s.replace(NON_ASCII, foldWord);
  // Each remaining non-ASCII character is already lowercase, and no Σ is
  // left, so lowercasing the whole string changes only ASCII letters.
  return t.toLowerCase().replace(NON_WORD, ' ').trim();
}

const TOKEN = /[A-Za-z0-9]+|[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+|[^\x00-\x7f]/guy;
const isAsciiAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * The UTF-8 byte offset in `raw` of the character that put index `k` into
 * `" " + fold(raw) + " "` (medrec's `Squashed`, whose index 0 is the leading
 * space): where a match found in the folded text starts in the original.
 */
export function rawOffset(raw: string, k: number): number {
  if (k <= 0) return 0;
  let f = 1;
  let space = true;
  let byte = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(raw); m; m = TOKEN.exec(raw)) {
    const t = m[0];
    const c0 = t.charCodeAt(0);
    if (c0 < 0x80 && isAsciiAlnum(c0)) {
      if (k < f + t.length) return byte + (k - f);
      f += t.length;
      byte += t.length;
      space = false;
    } else if (c0 < 0x80) {
      if (!space) {
        if (k === f) return byte;
        f++;
        space = true;
      }
      byte += t.length;
    } else {
      for (const g of foldWord(t)) {
        if (g !== ' ') {
          if (k < f + g.length) return byte;
          f += g.length;
          space = false;
        } else if (!space) {
          if (k === f) return byte;
          f++;
          space = true;
        }
      }
      byte += utf8Length(t);
    }
  }
  return byte;
}

/**
 * Each word of `fold(raw)`, in order, with the UTF-8 byte offset in `raw`
 * where it starts: `rawOffset` at every word start, in one pass.
 */
export function wordStarts(raw: string): number[] {
  const out: number[] = [];
  let space = true;
  let byte = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(raw); m; m = TOKEN.exec(raw)) {
    const t = m[0];
    const c0 = t.charCodeAt(0);
    if (c0 < 0x80 && isAsciiAlnum(c0)) {
      if (space) out.push(byte);
      byte += t.length;
      space = false;
    } else if (c0 < 0x80) {
      space = true;
      byte += t.length;
    } else {
      for (const g of foldWord(t)) {
        if (g !== ' ') {
          if (space) out.push(byte);
          space = false;
        } else space = true;
      }
      byte += utf8Length(t);
    }
  }
  return out;
}

export function utf8Length(c: string): number {
  const p = c.codePointAt(0) ?? 0;
  return p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4;
}

/** `s` cut to `max` characters, the last being `…` when cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** Rust's `str::lines`: split on `\n`, a trailing `\r` dropped, no empty last line. */
export function lines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The first line with text, trimmed, clipped to `max` characters. */
export function firstLine(s: string, max: number): string {
  const line = trim(lines(s).find((l) => trim(l) !== '') ?? '');
  return clip(line, max);
}

/** Rust's `str::trim`: Unicode White_Space at both ends. */
export function trim(s: string): string {
  return s.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, '');
}

/** Rust's `split_whitespace` joined by one space. */
export function collapse(s: string): string {
  return s.split(/[\p{White_Space}]+/u).filter(Boolean).join(' ');
}

/** The day of an ISO date or date-time: its first ten characters. */
export function day(d: string | null | undefined): string | undefined {
  if (d === null || d === undefined) return undefined;
  return d.length <= 10 ? d : Array.from(d).slice(0, 10).join('');
}

/** Compares as Rust compares `Option<String>`: none before any string. */
export function cmpOpt(a: string | null | undefined, b: string | null | undefined): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? -1 : 1;
  return cmpStr(a, b);
}

/** Byte order of the UTF-8 encodings, as Rust compares strings. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
