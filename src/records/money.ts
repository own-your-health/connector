// Money, as medrec's claims.rs adds it: a claim's amounts and the member's
// share of them.

import type { Json, JsonObject } from './model';
import { isExact, isObject } from './numbers';
import { trim } from './text';

const I128_MAX = (1n << 127n) - 1n;

/** A decimal amount in ten-thousandths, so two of them add exactly. */
export function units(raw: string): bigint | undefined {
  let s = trim(raw);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const dot = s.indexOf('.');
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? '' : s.slice(dot + 1);
  const digits = (x: string) => /^[0-9]*$/.test(x);
  if ((int === '' && frac === '') || !digits(int) || !digits(frac) || frac.length > 4) return undefined;
  const v = BigInt(`${int === '' ? '0' : int}${frac.padEnd(4, '0')}`);
  if (v > I128_MAX) return undefined;
  return neg ? -v : v;
}

/** Ten-thousandths as a decimal with two places, or four when it has them. */
function decimal(u: bigint): string {
  const sign = u < 0n ? '-' : '';
  const abs = u < 0n ? -u : u;
  const int = abs / 10_000n;
  const frac = abs % 10_000n;
  return frac % 100n === 0n ? `${sign}${int}.${String(frac / 100n).padStart(2, '0')}` : `${sign}${int}.${String(frac).padStart(4, '0')}`;
}

/** serde_json's `Value` equality: objects whatever their key order. */
function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (isExact(a)) return isExact(b) && a.rawJSON === b.rawJSON;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return false;
}

/** `a + b` for two `{amount, currency}` values of one currency; undefined when the currencies differ or an amount is not a plain decimal. */
function addMoney(a: Json, b: Json): Json | undefined {
  const cur = (m: Json) => (isObject(m) && Object.hasOwn(m, 'currency') ? m.currency : undefined);
  if (!sameJson(cur(a), cur(b))) return undefined;
  const amt = (m: Json) => {
    const v = isObject(m) ? m.amount : undefined;
    return typeof v === 'string' ? units(v) : undefined;
  };
  const x = amt(a);
  const y = amt(b);
  if (x === undefined || y === undefined) return undefined;
  return { amount: decimal(x + y), currency: cur(a) ?? null };
}

/**
 * The member's share of a claim's `amounts`: the payer's `you_owe`, else
 * `deductible` + `copay` + `coinsurance` + `not_covered` of those given
 * (never `discount`), and whether it is that sum.
 */
export function memberShare(a: JsonObject): { value: Json; summed: boolean } | undefined {
  if (Object.hasOwn(a, 'you_owe')) return { value: a.you_owe!, summed: false };
  const parts = ['deductible', 'copay', 'coinsurance', 'not_covered'].filter((k) => Object.hasOwn(a, k)).map((k) => a[k]!);
  if (parts.length === 0) return undefined;
  let sum: Json | undefined = parts[0]!;
  for (const v of parts.slice(1)) {
    sum = addMoney(sum, v);
    if (sum === undefined) return undefined;
  }
  return { value: sum, summed: true };
}

/** Exposed for the unit tests of medrec's arithmetic. */
export const moneyForTests = { units, decimal, addMoney };
