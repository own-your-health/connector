// The vaccines a person's claims tell of (medrec 0.9.11 and later; its data
// contract's "Records"). A claim line that names a vaccine by its CVX code is
// listed among the person's immunizations as from a claim. It stays its
// claim: it is no record, and has the claim's id, so what is private of the
// claim is private of it.
//
// medrec also names one by a line's CPT code, through CDC's tables on the
// machine that writes the views. This connector has no tables, so from a
// folder's own files it names one by a line's own CVX code alone, as medrec
// does on a machine without them; the views give medrec's.

import { recordInError } from './errors';
import type { Json, JsonObject, RecordEntry } from './model';
import { memberShare, units } from './money';
import { isObject } from './numbers';
import { day, fold, trim } from './text';

export const CVX = 'http://hl7.org/fhir/sid/cvx';

/** CVX codes that are no vaccine given ("no vaccine administered", "unknown"). */
const NO_VACCINE = new Set([998, 999]);

/** A claim's statuses that say nothing was given (a reversal is cancelled). */
const SKIPPED = new Set(['planned', 'cancelled']);

/** A CVX code's number: `03` and `3` are one code. */
function number(code: string): number | undefined {
  const c = trim(code);
  return /^[0-9]{1,4}$/.test(c) ? Number(c) : undefined;
}

const text = (v: Json | undefined) => (typeof v === 'string' ? v : undefined);

/** The codes of a claim line's service: each of its `codes` (0.9.11 and later), else its `service`'s. */
function serviceCodes(line: JsonObject): [string, string][] {
  const pair = (c: Json): [string, string][] => {
    const [system, code] = isObject(c) ? [text(c.system), text(c.code)] : [];
    return system !== undefined && code !== undefined ? [[system, code]] : [];
  };
  return Array.isArray(line.codes) ? line.codes.flatMap(pair) : pair(line.service ?? null);
}

/** The CVX codes of the vaccines a line names, as written: its own, never 998 or 999. */
function ofLine(line: JsonObject): string[] {
  const own = serviceCodes(line)
    .filter(([system, code]) => system === CVX && trim(code) !== '')
    .map(([, code]) => trim(code))
    .filter((c) => {
      const n = number(c);
      return n !== undefined && !NO_VACCINE.has(n);
    });
  const sorted = own.map((c, i) => [c, i] as const).sort(([a, i], [b, j]) => number(a)! - number(b)! || i - j);
  return sorted.filter(([c], i) => i === 0 || number(c) !== number(sorted[i - 1]![0])).map(([c]) => c);
}

/** The lines a claim's totals count, with their places in its `items`. */
function countedLines(r: RecordEntry): [number, JsonObject][] {
  const items = r.fields?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((l, i): [number, JsonObject][] => (isObject(l) && l.counted !== false ? [[i, l]] : []));
}

/** A claim the plan denied: each line its totals count gives a reason it was denied, or a pharmacy's that it was rejected. */
function denied(r: RecordEntry): boolean {
  const says = (l: JsonObject) => {
    const of = Array.isArray(l.adjudication) ? l.adjudication : [];
    return of.some((a) => {
      const c = isObject(a) ? text(a.category) : undefined;
      if (c === undefined) return false;
      const folded = fold(c).replaceAll(' ', '');
      return folded === 'denialreason' || folded === 'rejectreason';
    });
  };
  const lines = countedLines(r).map(([, l]) => l);
  return lines.length > 0 && lines.every(says);
}

/** Whether the household paid any of a claim: the member's share of it, or of a line its totals count, is more than nothing. */
function paidSome(r: RecordEntry): boolean {
  const more = (a: Json | undefined) => {
    const share = isObject(a) ? memberShare(a) : undefined;
    const amount = share && isObject(share.value) ? text(share.value.amount) : undefined;
    const u = amount === undefined ? undefined : units(amount);
    return u !== undefined && u > 0n;
  };
  return more(r.fields?.amounts) || countedLines(r).some(([, l]) => l.amounts !== undefined && more(l.amounts));
}

/** Whether a claim says something was given: not cancelled, planned or entered in error, nor denied with nothing of it paid by the household. */
function gave(r: RecordEntry): boolean {
  const skipped = typeof r.status === 'string' && SKIPPED.has(r.status);
  return !skipped && !recordInError(r) && !(denied(r) && !paidSome(r));
}

/** An immunization's CVX code, where it has one. */
function cvxOf(r: RecordEntry): number | undefined {
  const c = r.code;
  return c?.system === CVX && typeof c.code === 'string' ? number(c.code) : undefined;
}

/** The day a claim line was given: its own, or its claim's. */
function lineDay(line: JsonObject, claim: RecordEntry): string | undefined {
  const s = line.serviced;
  const own = typeof s === 'string' ? s : isObject(s) ? text(s.start) : undefined;
  return day(own) ?? day(claim.date);
}

/** medrec's kinds of vaccine, by their names: a claim's dose of one is filed where an immunization of that kind and day with no CVX code is. */
const FAMILIES: readonly (readonly [string, string])[] = [
  ['flu', String.raw`influenza|\bflu\b|fluzone|fluarix|flucelvax|flulaval|fluad|flumist`],
  ['covid', String.raw`covid|sars-cov|comirnaty|spikevax|novavax`],
  ['hepb', String.raw`hep(atitis)?[ -]?b\b|heplisav|engerix|recombivax`],
  ['hepa', String.raw`hep(atitis)?[ -]?a\b|havrix|vaqta`],
  ['tdap', String.raw`tdap|boostrix|adacel|\btd\b|tetanus|dtap|pediarix|pentacel|infanrix|daptacel`],
  ['zoster', String.raw`zoster|shingrix|shingles`],
  ['pneumo', String.raw`pneumo|prevnar|pneumovax|vaxneuvance|capvaxive`],
  ['hpv', String.raw`\bhpv\b|papilloma|gardasil`],
  ['mmr', String.raw`\bmmr|measles|varicella|varivax|proquad|priorix`],
  ['rsv', String.raw`\brsv\b|respiratory syncytial|arexvy|abrysvo|beyfortus|nirsevimab`],
  ['rota', String.raw`rota(virus|teq|rix)`],
  ['hib', String.raw`\bhib\b|haemophilus|acthib|pedvaxhib`],
  ['polio', String.raw`polio|\bipv\b|ipol`],
  ['mening', String.raw`mening|menactra|menveo|menquadfi|bexsero|trumenba|penbraya`],
];

// A word boundary as Rust's regex has it, between a Unicode word character and another.
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;
const BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const VACCINES = FAMILIES.map(([k, re]) => [k, new RegExp(re.replaceAll(String.raw`\b`, BOUNDARY), 'iu')] as const);

/** The kind of vaccine a name says, by the first of medrec's patterns it matches. */
export function vaccineFamily(name: string): string | undefined {
  return VACCINES.find(([, re]) => re.test(name))?.[0];
}

/**
 * The vaccines the claims of `records` tell of, as immunizations: each with its
 * claim's id and provenance, `fields.from_claim` true and `fields.cvx` its CVX
 * codes, and `code` the one of them where it has one. One is listed for each
 * vaccine and day that no immunization of `records` has, by its CVX code, or by
 * its kind where that immunization has no CVX code, and once for two claims of
 * it; one entered in error or not given (a refusal) is none. `records` is in
 * the order the claims are read in: the first claim of a vaccine and day is the
 * one listed.
 */
export function claimVaccines(records: readonly RecordEntry[]): RecordEntry[] {
  const seen = new Set<string>();
  const kinds = new Set<string>();
  for (const r of records) {
    if (r.kind !== 'immunization' || recordInError(r) || r.status === 'not-done') continue;
    const d = day(r.date);
    if (d === undefined) continue;
    const n = cvxOf(r);
    if (n !== undefined) seen.add(`${d}|${n}`);
    else {
      const k = vaccineFamily(r.display);
      if (k !== undefined) kinds.add(`${d}|${k}`);
    }
  }
  const out: RecordEntry[] = [];
  for (const r of records) {
    if (r.kind !== 'claim' || !gave(r)) continue;
    for (const [, line] of countedLines(r)) {
      const cvx = ofLine(line);
      const d = cvx.length > 0 ? lineDay(line, r) : undefined;
      if (d === undefined) continue;
      const numbers = cvx.map((c) => number(c)!);
      const service = line.service;
      const own = isObject(service) ? text(service.display) : undefined;
      const name = own !== undefined && trim(own) !== '' ? trim(own) : r.display;
      const k = vaccineFamily(name);
      if (numbers.some((n) => seen.has(`${d}|${n}`)) || (k !== undefined && kinds.has(`${d}|${k}`))) continue;
      for (const n of numbers) seen.add(`${d}|${n}`);
      const { code: _, providers: __, ...claim } = r;
      out.push({
        ...claim,
        kind: 'immunization',
        ...(r.key !== undefined ? { key: `${r.key}|${JSON.stringify(line.sequence ?? null)}` } : {}),
        date: d,
        ...(cvx.length === 1 ? { code: { system: CVX, code: cvx[0]! } } : {}),
        display: name,
        status: 'completed',
        fields: { from_claim: true, cvx },
      });
    }
  }
  return out;
}

/** Whether an immunization is one a claim tells of. */
export const fromClaim = (r: RecordEntry): boolean => r.kind === 'immunization' && r.fields?.from_claim === true;
