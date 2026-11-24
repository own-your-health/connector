// Read views over a person's index, text and notes, ported from medrec
// (src/views.rs, src/summary.rs, src/people.rs) so each answer matches
// `medrec mcp`'s for the same folder. Nothing here changes what it reads:
// parsed files are shared with later calls through the isolate's cache.

import { ToolError } from '../mcp/errors';
import type { DocumentEntry, Household, Json, JsonObject, Note, Person, PersonIndex, RecordEntry } from './model';
import { conditionKey } from './code-names';
import { clip, cmpOpt, cmpStr, collapse, day, firstLine, fold, lines, rawOffset, trim } from './text';

/** Longest name or detail a summary line carries, in characters. */
export const CLIP = 200;

/** Lines in each of medrec_summary's sections. */
export const SUMMARY_LINES = 25;

export const DOC_TYPES: [code: string, label: string][] = [
  ['visit_summary', 'Visit summary'],
  ['lab_report', 'Lab report'],
  ['imaging_report', 'Imaging report'],
  ['immunization_record', 'Immunization record'],
  ['discharge_summary', 'Discharge summary'],
  ['referral', 'Referral'],
  ['prescription', 'Prescription'],
  ['letter', 'Letter'],
  ['bill', 'Bill'],
  ['receipt', 'Receipt'],
  ['eob', 'Explanation of benefits'],
  ['insurance_card', 'Insurance card'],
  ['other', 'Other'],
];

export const isDocType = (t: string) => DOC_TYPES.some(([c]) => c === t);

export function label(docType: string | null | undefined): string {
  return DOC_TYPES.find(([c]) => c === docType)?.[1] ?? 'Document';
}

// ---- dates ---------------------------------------------------------------------------------------

export interface Range {
  since?: string;
  until?: string;
}

/** `pk_cli_core::dates::parse_iso`: `YYYY-MM-DD`, month 1 to 12, day 1 to 31. */
export function checkIso(s: string): void {
  const bad = () => ToolError.usage(`expected an ISO date (YYYY-MM-DD), got \`${s}\``);
  const parts = s.split('-');
  if (parts.length !== 3) throw bad();
  const [y, m, d] = parts as [string, string, string];
  if (!/^[+-]?\d+$/.test(y) || !/^\+?\d+$/.test(m) || !/^\+?\d+$/.test(d)) throw bad();
  const mm = Number(m);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || y.length !== 4) throw bad();
}

/** An undated item shows only when no range is asked for. */
export function holds(r: Range, date: string | null | undefined): boolean {
  if (date === null || date === undefined) return r.since === undefined && r.until === undefined;
  const d = day(date)!;
  return (r.since === undefined || cmpStr(d, r.since) >= 0) && (r.until === undefined || cmpStr(d, r.until) <= 0);
}

// ---- people --------------------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();
const eqIgnoreAscii = (a: string, b: string) => a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A person by id, folder name, alias, or a unique part of a name (`people::resolve`). */
export function resolvePerson(h: Household, query: string): Person {
  const q = trim(query);
  const byId = h.people.find((p) => p.id === q);
  if (byId) return byId;
  const byAlias = h.people.find((p) => eqIgnoreAscii(p.folder, q) || (p.aliases ?? []).some((a) => eqIgnoreAscii(a, q)));
  if (byAlias) return byAlias;
  if (q === '') throw ToolError.usage('person reference is empty');
  const decide = (hits: Person[]) => {
    if (hits.length === 0) return null;
    if (hits.length === 1) return hits[0]!;
    throw ToolError.notFound(`\`${q}\` matches more than one person: ${hits.map((p) => `${p.name} (${p.id})`).join('; ')}`);
  };
  const ql = lower(q);
  const found =
    decide(h.people.filter((p) => p.name === q)) ??
    decide(h.people.filter((p) => lower(p.id) === ql)) ??
    decide(h.people.filter((p) => lower(p.name) === ql)) ??
    decide(h.people.filter((p) => lower(p.name).includes(ql)));
  if (!found) throw ToolError.notFound(`no person matching \`${q}\``);
  return found;
}

export function selected(h: Household, query: string | undefined): Person[] {
  return query === undefined ? h.people : [resolvePerson(h, query)];
}

// ---- values --------------------------------------------------------------------------------------

/** A JSON number as serde_json prints it. */
function numberText(n: number): string {
  return String(n);
}

export function valueText(v: Json | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(valueText).join('; ');
  // As serde_json's `get(..).or_else(..)`: a key present with null does not fall through.
  const num = valueText('value' in v ? v.value : v.amount);
  const u = 'unit' in v ? v.unit : v.currency;
  const unit = typeof u === 'string' ? u : '';
  return trim(`${num} ${unit}`);
}

/** Every string and number in `v`, each followed by a space, for search. */
function flatText(v: Json | undefined, out: string[]): void {
  if (typeof v === 'string') out.push(v, ' ');
  else if (typeof v === 'number') out.push(numberText(v), ' ');
  else if (Array.isArray(v)) for (const x of v) flatText(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) flatText(x, out);
}

const nonEmpty = (s: string) => (s === '' ? undefined : s);
const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- money, as medrec's claims.rs adds it ----------------------------------------------------------

const I128_MAX = (1n << 127n) - 1n;

/** A decimal amount in ten-thousandths, so two of them add exactly. */
function units(raw: string): bigint | undefined {
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

/**
 * Queries that name a kind of record rather than words in one: "blood
 * tests" finds the lab results, which never say so. Folded, words joined by
 * one space.
 */
export const LAB_QUERIES = ['blood test', 'blood tests', 'bloodwork', 'blood work', 'labs', 'lab work', 'lab test', 'lab tests', 'lab results'];

/** Whether a record is one a lab query names: a result, a report, or a claim with a lab line. */
export function isLab(r: RecordEntry): boolean {
  if (r.kind === 'result' || r.kind === 'report') return true;
  if (r.kind !== 'claim') return false;
  const items = r.fields?.items;
  return Array.isArray(items) && items.some((i) => isObject(i) && i.category === 'lab');
}
const str = (f: JsonObject, k: string) => {
  const v = f[k];
  return typeof v === 'string' ? v : undefined;
};

export const ENDED = new Set(['completed', 'stopped', 'inactive', 'resolved', 'remission', 'entered-in-error', 'cancelled', 'refuted']);
export const isEnded = (status: string | null | undefined) => status !== null && status !== undefined && ENDED.has(status);

/** The short line a record shows beside its name in a list. */
export function recordDetail(r: RecordEntry): string | undefined {
  const f = r.fields ?? {};
  const status = r.status ?? undefined;
  switch (r.kind) {
    case 'result': {
      const v = f.value === undefined ? undefined : nonEmpty(valueText(f.value));
      const flag = str(f, 'interpretation');
      if (v !== undefined && flag !== undefined) return `${v} (${flag})`;
      return v ?? flag;
    }
    case 'medication': {
      if (str(f, 'source') === 'dispense') {
        const filled = [f.quantity === undefined ? undefined : valueText(f.quantity), f.days_supply === undefined ? undefined : `${valueText(f.days_supply)} days`].filter(
          (s): s is string => s !== undefined && s !== '',
        );
        if (filled.length > 0) return `dispensed ${filled.join(', ')}`;
        return str(f, 'dosage') ?? status;
      }
      return str(f, 'dosage') ?? status;
    }
    case 'claim': {
      const a = f.amounts;
      if (isObject(a) && Object.keys(a).length > 0) {
        const parts: string[] = [];
        for (const [k, label] of [['billed', 'billed'], ['plan_paid', 'plan paid']] as const) {
          const v = Object.hasOwn(a, k) ? nonEmpty(valueText(a[k])) : undefined;
          if (v !== undefined) parts.push(`${label} ${v}`);
        }
        const share = memberShare(a);
        const v = share && nonEmpty(valueText(share.value));
        if (share && v !== undefined) parts.push(`${share.summed ? 'your share' : 'you owe'} ${v}`);
        return parts.length > 0 ? parts.join(', ') : status;
      }
      // A claim imported by a medrec before 0.5.0, with no `amounts`.
      const total = f.total;
      const first = Array.isArray(total) ? total[0] : undefined;
      const amount = first && typeof first === 'object' && !Array.isArray(first) ? first.amount : undefined;
      const billed = amount === undefined ? undefined : nonEmpty(valueText(amount));
      const paid = f.payment === undefined ? undefined : nonEmpty(valueText(f.payment));
      if (billed !== undefined && paid !== undefined) return `billed ${billed}, plan paid ${paid}`;
      if (billed !== undefined) return `billed ${billed}`;
      if (paid !== undefined) return `plan paid ${paid}`;
      return status;
    }
    default:
      return status;
  }
}

/** A FHIR base without its trailing slashes. */
export const baseOf = (b: string | null | undefined) => (b === null || b === undefined ? undefined : b.replace(/\/+$/, ''));

/**
 * Where a record came from: the organization of its own sign-in (the household
 * source with its CLI, organization and FHIR base), else the household's
 * organization at its FHIR base, else its CLI. One base can serve many
 * practices (athenahealth's), so the sign-in comes first (medrec 0.9.3 and
 * later, views::source_label).
 */
export function recordSource(h: Household, r: RecordEntry): string | undefined {
  const s = r.provenance?.[0]?.source;
  if (!s) return undefined;
  const base = baseOf(s.fhir_base);
  const cli = s.cli ?? undefined;
  const organization = s.organization_id ?? undefined;
  if (cli !== undefined && organization !== undefined) {
    for (const x of h.sources ?? []) {
      if (x.cli !== cli || x.organization !== organization || (base !== undefined && baseOf(x.fhir_base) !== base)) continue;
      const name = trim(x.organization_name ?? '');
      if (name !== '') return name;
    }
  }
  const org = base === undefined ? undefined : (h.organizations ?? []).find((o) => baseOf(o.fhir_base) === base);
  return org?.name ?? cli;
}

/** `q` is the record's code, or words of its name, case-insensitive. */
export function matchesCode(r: RecordEntry, q: string): boolean {
  const ql = lower(trim(q));
  if (ql === '') return true;
  const code = r.code ?? undefined;
  if (code?.code !== undefined && code.code !== null && lower(code.code) === ql) return true;
  return [r.display, code?.display ?? undefined].some((n) => n !== undefined && lower(n).includes(ql));
}

/** What makes two records the same test, medicine or vaccine. */
export function seriesKey(r: RecordEntry): string {
  const code = r.code?.code;
  if (code !== null && code !== undefined) return `${r.code?.system ?? ''}|${code}`;
  return `~${fold(r.display)}`;
}

const byDateDesc = <T>(date: (x: T) => string | null | undefined, then: (a: T, b: T) => number) => (a: T, b: T) => cmpOpt(date(b), date(a)) || then(a, b);

/** Records newest first, then by name: the order every summary reads them in. */
export function newestFirst(records: readonly RecordEntry[]): RecordEntry[] {
  return [...records].sort(byDateDesc((r) => r.date, (a, b) => cmpStr(a.display, b.display)));
}

// ---- summary -------------------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  birth_date?: string;
  adult: boolean;
  documents: number;
  records: number;
  studies: number;
  notes: number;
  newest?: string;
  last_import?: string;
}

export function personRow(p: Person, idx: PersonIndex, notes: number): PersonRow {
  let newest: string | undefined;
  const dates = [...(idx.documents ?? []).map((d) => d.date), ...(idx.records ?? []).map((r) => r.date), ...(idx.studies ?? []).map((s) => s.date)];
  for (const d of dates) {
    const x = day(d);
    if (x !== undefined && (newest === undefined || cmpStr(x, newest) > 0)) newest = x;
  }
  let lastImport: string | undefined;
  for (const i of idx.imports ?? []) if (lastImport === undefined || cmpStr(i.imported_at, lastImport) > 0) lastImport = i.imported_at;
  return {
    id: p.id,
    name: p.name,
    ...(p.birth_date !== null && p.birth_date !== undefined ? { birth_date: p.birth_date } : {}),
    adult: p.adult ?? false,
    documents: (idx.documents ?? []).length,
    records: (idx.records ?? []).length,
    studies: (idx.studies ?? []).length,
    notes,
    ...(newest !== undefined ? { newest } : {}),
    ...(lastImport !== undefined ? { last_import: lastImport } : {}),
  };
}

export interface SummaryLine {
  name: string;
  date?: string;
  detail?: string;
  status?: string;
  source?: string;
  /** The record's id (medrec 0.9.1 and later), so a reader finds it in private.json. */
  id?: string;
  /** A condition's key in code-names.json (medrec 0.9.4 and later). */
  name_key?: string;
}

export interface Listed<T> {
  items: T[];
  more: number;
}

export const cut = <T>(all: T[], n: number): Listed<T> => ({ items: all.slice(0, n), more: Math.max(0, all.length - n) });

function line(h: Household, r: RecordEntry): SummaryLine {
  const detail = recordDetail(r);
  return {
    name: clip(r.display, CLIP),
    date: day(r.date),
    detail: detail !== undefined && detail !== (r.status ?? undefined) ? clip(detail, CLIP) : undefined,
    status: r.status ?? undefined,
    source: recordSource(h, r),
    id: r.id,
    name_key: conditionKey(r),
  };
}

export interface Vaccine {
  vaccine: string;
  code?: string;
  doses: number;
  last_date?: string;
  source?: string;
  /** The last dose's record id (medrec 0.9.1 and later). */
  id?: string;
}

function vaccines(h: Household, records: RecordEntry[]): Vaccine[] {
  const by = new Map<string, Vaccine>();
  for (const r of records) {
    if (r.kind !== 'immunization' || r.status === 'not-done' || r.status === 'entered-in-error') continue;
    const key = seriesKey(r);
    const v = by.get(key);
    if (v) v.doses += 1;
    else by.set(key, { vaccine: clip(r.display, CLIP), code: r.code?.code ?? undefined, doses: 1, last_date: day(r.date), source: recordSource(h, r), id: r.id });
  }
  return [...by.values()];
}

export interface ResultRow {
  test: string;
  code?: string;
  date?: string;
  value?: string;
  unit?: string;
  range?: string;
  flag?: string;
  source?: string;
  results?: number;
  first_date?: string;
  /** The record's id; of a test's latest result (medrec 0.9.1 and later). */
  id?: string;
  /**
   * Of the ids a reader asked about, those of the series' results this row
   * counts (in its range, matching its name), newest first: a private one
   * among them makes the whole series private (medrec 0.9.3 and later).
   */
  members?: string[];
}

function reading(r: RecordEntry): [string | undefined, string | undefined] {
  const v = r.fields?.value;
  if (v === undefined) return [undefined, undefined];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const unit = v.unit;
    return [v.value === undefined ? undefined : nonEmpty(valueText(v.value)), typeof unit === 'string' ? unit : undefined];
  }
  const t = nonEmpty(valueText(v));
  return [t === undefined ? undefined : clip(t, CLIP), undefined];
}

export function resultRow(h: Household, r: RecordEntry): ResultRow {
  const [value, unit] = reading(r);
  const text = (k: string) => {
    const v = r.fields?.[k];
    if (v === undefined) return undefined;
    const t = nonEmpty(valueText(v));
    return t === undefined ? undefined : clip(t, CLIP);
  };
  return {
    test: clip(r.display, CLIP),
    code: r.code?.code ?? undefined,
    date: r.date ?? undefined,
    value,
    unit,
    range: text('reference_range'),
    flag: text('interpretation'),
    source: recordSource(h, r),
    id: r.id,
  };
}

/** The latest result of each test, with how many are on file and since when; `records` newest first. */
export function latestResults(h: Household, records: RecordEntry[]): ResultRow[] {
  const by = new Map<string, ResultRow>();
  for (const r of records) {
    if (r.kind !== 'result') continue;
    const key = seriesKey(r);
    const row = by.get(key);
    if (row) {
      row.results = (row.results ?? 0) + 1;
      if (r.date !== null && r.date !== undefined) row.first_date = day(r.date);
    } else {
      by.set(key, { ...resultRow(h, r), results: 1, first_date: day(r.date) });
    }
  }
  return [...by.values()];
}

export interface Bill {
  document: string;
  title?: string;
  organization?: string;
  statement_date?: string;
  amount_due: string;
  due_date?: string;
  past_due: boolean;
  statements: number;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `amount_due` is over zero. */
export function owes(amountDue: string): boolean {
  const first = amountDue.split(/[\p{White_Space}]+/u).find(Boolean);
  if (first === undefined) return false;
  const a = first.replace(/,/g, '');
  if (/^[+]?(inf|infinity)$/i.test(a)) return true;
  return DECIMAL.test(a) && Number(a) > 0;
}

/**
 * The newest statement of each account with an amount due over zero, unless
 * bills.json has it `settled` (medrec 0.9.1 and later).
 */
export function bills(documents: DocumentEntry[], today: string, settled: ReadonlySet<string> = new Set()): Bill[] {
  const when = (d: DocumentEntry) => d.statement?.statement_date ?? d.date ?? undefined;
  const docs = documents
    .filter((d) => d.doc_type === 'bill' && (d.same_statement_as === null || d.same_statement_as === undefined) && d.statement)
    .sort((a, b) => cmpOpt(when(b), when(a)));
  const out = new Map<string, Bill>();
  for (const d of docs) {
    const s = d.statement!;
    const account = s.account !== null && s.account !== undefined ? `${d.organization ?? ''}|${s.account}` : `doc|${d.id}`;
    const held = out.get(account);
    if (held) {
      held.statements += 1;
      continue;
    }
    if (!s.amount_due) {
      // A newest statement without an amount keeps its place, then is dropped.
      out.set(account, { document: d.id, amount_due: '', past_due: false, statements: 1 });
      continue;
    }
    out.set(account, {
      document: d.id,
      title: d.title ? clip(d.title, CLIP) : undefined,
      organization: d.organization ?? undefined,
      statement_date: s.statement_date ?? undefined,
      amount_due: `${s.amount_due.amount} ${s.amount_due.currency}`,
      due_date: s.due_date ?? undefined,
      past_due: s.due_date !== null && s.due_date !== undefined && cmpStr(s.due_date, today) < 0,
      statements: 1,
    });
  }
  return [...out.values()].filter((b) => owes(b.amount_due) && !settled.has(b.document));
}

export interface SourceRow {
  source: string;
  records: number;
  newest?: string;
}

export interface Summary {
  person: PersonRow;
  as_of: string;
  counts: Record<string, number>;
  sources: SourceRow[];
  medications: Listed<SummaryLine>;
  conditions: Listed<SummaryLine>;
  allergies: Listed<SummaryLine>;
  immunizations: Listed<Vaccine>;
  latest_results: Listed<ResultRow>;
  recent_visits: Listed<SummaryLine>;
  bills: Listed<Bill>;
}

export function summarize(h: Household, p: Person, idx: PersonIndex, notes: number, today: string, perList: number): Summary {
  const records = newestFirst(idx.records ?? []);
  const counts = new Map<string, number>();
  const sources = new Map<string, SourceRow>();
  for (const r of records) {
    counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    const s = recordSource(h, r);
    if (s !== undefined) {
      let row = sources.get(s);
      if (!row) sources.set(s, (row = { source: s, records: 0 }));
      row.records += 1;
      const d = day(r.date);
      if (cmpOpt(d, row.newest) > 0) row.newest = d;
    }
  }
  const sortedSources = [...sources.values()].sort((a, b) => cmpStr(a.source, b.source)).sort((a, b) => b.records - a.records || cmpStr(a.source, b.source));
  const current = (kind: string) => {
    const seen = new Set<string>();
    const out: SummaryLine[] = [];
    for (const r of records) {
      if (r.kind !== kind || isEnded(r.status)) continue;
      const key = seriesKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line(h, r));
    }
    return out;
  };
  return {
    person: personRow(p, idx, notes),
    as_of: today,
    counts: Object.fromEntries([...counts].sort(([a], [b]) => cmpStr(a, b))),
    sources: sortedSources,
    medications: cut(current('medication'), perList),
    conditions: cut(current('condition'), perList),
    allergies: cut(current('allergy'), perList),
    immunizations: cut(vaccines(h, records), perList),
    latest_results: cut(latestResults(h, records), perList),
    recent_visits: cut(
      records.filter((r) => r.kind === 'encounter').map((r) => line(h, r)),
      perList,
    ),
    bills: cut(bills(idx.documents ?? [], today), perList),
  };
}

// ---- timeline ------------------------------------------------------------------------------------

export interface Event {
  date?: string;
  person: string;
  person_name: string;
  kind: string;
  id: string;
  title: string;
  detail?: string;
  source?: string;
}

/** A person's documents, records, studies and notes in the range, as timeline events, in the order the files hold them. */
export function timelineEvents(h: Household, p: Person, idx: PersonIndex, notes: Note[], range: Range): Event[] {
  const out: Event[] = [];
  {
    for (const d of idx.documents ?? []) {
      if (!holds(range, d.date)) continue;
      out.push({
        date: d.date ?? undefined,
        person: p.id,
        person_name: p.name,
        kind: 'document',
        id: d.id,
        title: d.title ?? label(d.doc_type),
        detail: d.original_name ?? undefined,
        source: d.organization ?? undefined,
      });
    }
    for (const r of idx.records ?? []) {
      if (!holds(range, r.date)) continue;
      out.push({ date: r.date ?? undefined, person: p.id, person_name: p.name, kind: r.kind, id: r.id, title: r.display, detail: recordDetail(r), source: recordSource(h, r) });
    }
    for (const s of idx.studies ?? []) {
      if (!holds(range, s.date)) continue;
      out.push({
        date: s.date ?? undefined,
        person: p.id,
        person_name: p.name,
        kind: 'study',
        id: s.id,
        title: trim(`${(s.modalities ?? []).join('/')} ${s.description ?? s.body_part ?? ''}`),
        detail: `${(s.series ?? []).length} series, ${s.instances ?? 0} images`,
        source: s.facility ?? undefined,
      });
    }
    for (const n of notes) {
      if (!holds(range, n.date)) continue;
      out.push({
        date: n.date,
        person: p.id,
        person_name: p.name,
        kind: 'note',
        id: n.id,
        title: firstLine(n.text, 80),
        detail: n.tags.length > 0 ? n.tags.join(', ') : undefined,
        source: n.author,
      });
    }
  }
  return out;
}

// ---- notes ---------------------------------------------------------------------------------------

export interface NoteRow {
  person_name: string;
  note: Note;
}


// ---- search --------------------------------------------------------------------------------------

export interface Hit {
  person_name: string;
  kind: string;
  id: string;
  date?: string;
  title: string;
  snippet: string;
  score: number;
}

/** One searchable item of a person's: what a hit shows, and its text folded once. */
export interface Searchable {
  kind: string;
  id: string;
  date?: string;
  title: string;
  /** `" " + fold(hay) + " "`, as medrec's `Squashed` holds it. */
  folded: string;
  /** Rebuilds the item's unfolded text, for a hit's snippet. */
  hay: (idx: PersonIndex, texts: Record<string, string>, notes: Note[]) => string;
  /** A lab record's detail line: its snippet when a lab query finds it by kind (`LAB_QUERIES`). */
  lab?: (idx: PersonIndex) => string;
}

export function searchables(idx: PersonIndex, texts: Record<string, string>, notes: Note[]): Searchable[] {
  const out: Searchable[] = [];
  const add = (kind: string, id: string, date: string | null | undefined, title: string, hay: Searchable['hay'], lab?: Searchable['lab']) => {
    out.push({ kind, id, date: date ?? undefined, title, folded: ` ${fold(hay(idx, texts, notes))} `, hay, ...(lab ? { lab } : {}) });
  };
  (idx.documents ?? []).forEach((d, i) => {
    const title = d.title ?? d.original_name ?? label(d.doc_type);
    add('document', d.id, d.date, title, (x, t) => {
      const doc = x.documents![i]!;
      return `${title}\n${doc.organization ?? ''} ${label(doc.doc_type)}\n${t[doc.id] ?? ''}`;
    });
  });
  (idx.records ?? []).forEach((r, i) => {
    add(r.kind, r.id, r.date, r.display, (x) => {
      const rec = x.records![i]!;
      const body: string[] = [];
      flatText(rec.fields ?? {}, body);
      return `${rec.display}\n${body.join('')}`;
    }, isLab(r) ? (x) => recordDetail(x.records![i]!) ?? '' : undefined);
  });
  (idx.studies ?? []).forEach((st, i) => {
    add('study', st.id, st.date, st.description ?? 'Imaging study', (x) => {
      const s = x.studies![i]!;
      const series = (s.series ?? [])
        .map((v) => v.description)
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
      return `${s.description ?? 'Imaging study'}\n${(s.modalities ?? []).join(' ')} ${s.body_part ?? ''} ${s.facility ?? ''} ${series}`;
    });
  });
  notes.forEach((n, i) => {
    add('note', n.id, n.date, firstLine(n.text, 80), (_x, _t, ns) => {
      const note = ns[i]!;
      const rest = lines(trim(note.text)).slice(1).join('\n');
      return `${firstLine(note.text, 80)}\n${note.tags.join(' ')}\n${rest}`;
    });
  });
  return out;
}

/** How often the terms occur as word prefixes, and where the first one starts; null unless all occur. */
export function score(folded: string, terms: string[]): { score: number; first: number } | null {
  let n = 0;
  let first = Number.MAX_SAFE_INTEGER;
  for (const t of terms) {
    const needle = ` ${t}`;
    let i = folded.indexOf(needle);
    if (i === -1) return null;
    first = Math.min(first, i);
    for (; i !== -1; i = folded.indexOf(needle, i + 1)) n++;
  }
  return { score: n, first };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * All terms present, each as a word prefix: the count of their occurrences
 * and a snippet around the first (medrec's `matches` over `Squashed`).
 */
export function matches(hay: string, terms: string[]): { score: number; snippet: string } | null {
  const m = score(` ${fold(hay)} `, terms);
  return m && { score: m.score, snippet: snippetAt(hay, m.first) };
}

/** medrec's snippet: 60 bytes before the match to 100 after, whitespace collapsed, `…` where cut. */
export function snippetAt(hay: string, first: number): string {
  // The folded text maps to the original in order, so the earliest match there is the earliest here.
  const bytes = encoder.encode(hay);
  return snippetIn(bytes, 0, bytes.length, rawOffset(hay, first + 1));
}

/** The bytes of a hay a snippet at `at` reads: a little either side, for the character starts. */
export function snippetWindow(hayBytes: number, at: number): [start: number, end: number] {
  return [Math.max(0, at - 64), Math.min(hayBytes, at + 101)];
}

/**
 * The snippet at byte `at` of a hay of `hayBytes` bytes, from `window`: the
 * hay's bytes from `windowStart` on, covering at least `snippetWindow`.
 */
export function snippetIn(window: Uint8Array, windowStart: number, hayBytes: number, at: number): string {
  const byte = (i: number) => window[i - windowStart]!;
  const floor = (i: number) => {
    let j = Math.min(i, hayBytes);
    // Back to the start of a character: never inside a UTF-8 sequence.
    while (j > 0 && j < hayBytes && (byte(j) & 0xc0) === 0x80) j--;
    return j;
  };
  const start = floor(Math.max(0, at - 60));
  const end = floor(at + 100);
  let snippet = collapse(decoder.decode(window.subarray(start - windowStart, end - windowStart)));
  if (start > 0) snippet = `…${snippet}`;
  if (end < hayBytes) snippet += '…';
  return snippet;
}

// ---- documents -----------------------------------------------------------------------------------

