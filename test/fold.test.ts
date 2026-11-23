// fold() and rawOffset() against a plain transcription of medrec's `fold`
// and `Squashed` (one character at a time), over random text heavy in the
// characters where a faster version could go wrong.

import { describe, expect, it } from 'vitest';
import { foldCharForTests as foldChar, fold, rawOffset, utf8Length } from '../src/records/text';

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const isAlnum = (c: string) => (c < '\u0080' ? /^[A-Za-z0-9]$/.test(c) : ALNUM.test(c));

function reference(raw: string): { folded: string; map: number[] } {
  let f = ' ';
  const map = [0];
  let byte = 0;
  for (const c of raw) {
    for (const g of foldChar(c)) {
      if (isAlnum(g)) {
        f += g;
        for (let k = 0; k < g.length; k++) map.push(byte);
      } else if (!f.endsWith(' ')) {
        f += ' ';
        map.push(byte);
      }
    }
    byte += utf8Length(c);
  }
  if (!f.endsWith(' ')) {
    f += ' ';
    map.push(byte);
  }
  return { folded: f, map };
}

const ALPHABET = [...'aZ09 -_.,;:\'"\t\n\r\f/\\()[]{}', 'é', 'É', 'ß', 'Æ', 'ø', 'Ł', 'İ', 'ı', 'Σ', 'σ', 'ς', 'ﬁ', 'Ⅻ', '½', '²', 'µ', 'ǅ', ' ', ' ', '́', '​', '🩺', '𝐀', '血', '検', '’', '“', '…', '—', 'Ω', 'ǈ', 'ﬀ'];

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const text = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');

describe('fold', () => {
  it('equals the character-at-a-time fold on 2,000 random texts', () => {
    for (let i = 0; i < 2000; i++) {
      const s = text(1 + Math.floor(rand() * 40));
      const r = reference(s).folded;
      const want = r === ' ' ? '' : r.slice(1, -1);
      expect(fold(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('maps every folded index back to the byte Squashed maps it to', () => {
    for (let i = 0; i < 500; i++) {
      const s = text(1 + Math.floor(rand() * 30));
      const { folded, map } = reference(s);
      for (let k = 1; k < folded.length; k++) expect(rawOffset(s, k), `${JSON.stringify(s)} @${k}`).toBe(map[k]);
    }
  });
});
