// What a person's chart holds that is about somebody else: a screening a
// parent answers of themselves, and a result its source says is of another
// (medrec-cli docs/data-contract.md, "About another person"). medrec's views
// leave it out and name its ids; here it is left out of an index read whole.

import { canWrite } from './errors';
import type { DocumentEntry, Given, GivenPaper, Json, JsonObject, Person, PersonIndex, Provenance, RecordEntry } from './model';
import { isObject, removed } from './numbers';
import { grownAnswers } from './questionnaires';
import { withoutPapers } from './papers';
import { cmpStr } from './text';

/** The age from which a person answers a screening of themselves. */
const ANSWERS_FROM = 11;

/** The index without what is about somebody else, whose ids it has: what is so by medrec's rule, and `also`. */
export function shownIndex(p: Person, idx: PersonIndex, also: readonly string[] = []): PersonIndex {
  const gone = aboutAnother(p, idx, also);
  return gone.size === 0 ? idx : without(idx, gone);
}

function aboutAnother(p: Person, idx: PersonIndex, also: readonly string[]): ReadonlySet<string> {
  const records = idx.records ?? [];
  const known = new Set(also);
  const seen: Seen = new Map();
  const out = new Set<string>();
  for (const r of records) if (known.has(r.id) || recordIs(p, r, seen)) out.add(r.id);
  // A paper that only such records list goes with them.
  const only = new Map<string, boolean>();
  for (const r of records) for (const d of r.documents ?? []) only.set(d, (only.get(d) ?? true) && out.has(r.id));
  for (const d of idx.documents ?? []) {
    if (known.has(d.id) || paperIs(p, d, seen) || (only.get(d.id) === true && !papers(d).some((v) => v.source.cli == null))) out.add(d.id);
  }
  return out;
}

/** What the names of the person's items were found to be. */
type Seen = Map<string, boolean | undefined>;

const text = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const list = <T>(v: readonly T[] | null | undefined): readonly T[] => (Array.isArray(v) ? v : []);

/** A record as it is, then as each source gave it. */
function* asGiven(r: RecordEntry): Iterable<RecordEntry> {
  yield r;
  for (const g of list<Given>(r.given)) yield { ...r, display: g.display ?? r.display, code: g.code ?? r.code, fields: { ...r.fields, ...g.fields } };
}

function recordIs(p: Person, r: RecordEntry, seen: Seen): boolean {
  if (r.kind !== 'result' && r.kind !== 'report') return false;
  if (saidAbout(r)) return true;
  for (const x of asGiven(r)) {
    const read = list<Provenance>(x.provenance).flatMap((v) => v.fetched_at ?? []);
    const day = x.date ?? read.sort(cmpStr)[0];
    // A laboratory's alcohol or drug test is none. Names are read last: most of them are old enough.
    if (tooYoung(p, day) && !text(x.fields?.category)?.toLowerCase().startsWith('lab') && grownAnswers(x.display, x.code, seen)) return true;
  }
  return false;
}

/** Whether the resource a record's values are of says, or said, that it is about somebody else; what no resource is known of is every one's. */
function saidAbout(r: RecordEntry): boolean {
  if (text(r.fields?.about) !== undefined) return true;
  const said = list<Given>(r.given).filter((g) => text(g.fields?.about) !== undefined);
  if (said.length === 0) return false;
  const path = wrote(r);
  return said.some((g) => g.raw_path == null || g.raw_path === path);
}

/** The raw file a record's values are of, as far as that is known: the only one, the one it names, else that of the first resource import lets write. */
function wrote(r: RecordEntry): string | undefined {
  const from = list<Provenance>(r.provenance);
  if (from.length === 1) return from[0]!.raw_path ?? undefined;
  const may = from.filter((v) => canWrite(r, v));
  const named = r.fields_from != null && may.some((v) => v.raw_path === r.fields_from) ? r.fields_from : may[0]?.raw_path;
  return named ?? undefined;
}

const papers = (d: DocumentEntry): readonly Provenance[] => [...(d.provenance ? [d.provenance] : []), ...list<Provenance>(d.also_from)];

/** One the household filed is whose they say it is. */
function paperIs(p: Person, d: DocumentEntry, seen: Seen): boolean {
  const from = papers(d);
  if (!tooYoung(p, d.date ?? d.provenance?.fetched_at) || from.some((v) => v.source.cli == null)) return false;
  return [d.title, ...list<GivenPaper>(d.given).map((g) => g.title ?? d.title)].some((t) => typeof t === 'string' && grownAnswers(t, undefined, seen));
}

/** Whether the person had not reached ANSWERS_FROM on a day; not where that cannot be told. */
function tooYoung(p: Person, day: string | null | undefined): boolean {
  const [born, on] = [dayOf(p.birth_date), dayOf(day)];
  if (born === undefined || on === undefined) return false;
  return cmpStr(on, `${String(Number(born.slice(0, 4)) + ANSWERS_FROM).padStart(4, '0')}${born.slice(4)}`) < 0;
}

/** The day a date says, when it says one. */
function dayOf(v: string | null | undefined): string | undefined {
  const at = typeof v === 'string' ? /^\d{4}-(\d{2})-(\d{2})/.exec(v) : null;
  if (!at) return undefined;
  const [m, d] = [Number(at[1]), Number(at[2])];
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? at[0] : undefined;
}

/** The index without these, and without what it says of them. */
function without(idx: PersonIndex, gone: ReadonlySet<string>): PersonIndex {
  const keep = (ids: readonly string[]) => ids.filter((id) => !gone.has(id));
  return {
    ...idx,
    about_another: [...gone].sort(cmpStr),
    records: idx.records
      ?.filter((r) => !gone.has(r.id))
      .map((r) => {
        const out = r.documents ? { ...r, documents: keep(r.documents) } : r;
        return r.kind === 'claim' && r.fields ? { ...out, fields: claimFields(r.fields, gone) } : out;
      }),
    documents: idx.documents && withoutPapers(idx.documents, gone),
  };
}

/** A claim names the results of its days, and so do its lines. */
function claimFields(fields: JsonObject, gone: ReadonlySet<string>): JsonObject {
  const less = (of: JsonObject, key: string): JsonObject => {
    const ids = of[key];
    if (!Array.isArray(ids)) return of;
    const left = ids.filter((id) => typeof id !== 'string' || !gone.has(id));
    return left.length > 0 ? { ...of, [key]: left } : removed(of, key);
  };
  const out = less(fields, 'results');
  const lines = out.items;
  return Array.isArray(lines) ? { ...out, items: lines.map((l) => (isObject(l) ? less(l, 'records') : l)) } : out;
}
