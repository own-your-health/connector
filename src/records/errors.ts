// What is entered in error (medrec-cli docs/data-contract.md, "Entered in
// error"): a record or a paper, while every source of it says so. medrec's
// views name its ids; here it is told from an index read whole.

import type { DocumentEntry, PersonIndex, Provenance, RecordEntry, SourceWord } from './model';
import { saysInError } from './standing';

/** A person's records and papers entered in error, by kind (`document` for a paper), as views.json has them. */
export type Errors = ReadonlyMap<string, ReadonlySet<string>>;

export const NO_ERRORS: Errors = new Map();

export function enteredInError(idx: PersonIndex): Errors {
  const out = new Map<string, Set<string>>();
  const add = (kind: string, id: string) => void (out.get(kind) ?? out.set(kind, new Set()).get(kind)!).add(id);
  for (const r of idx.records ?? []) if (recordIs(r)) add(r.kind, r.id);
  for (const d of idx.documents ?? []) if (paperIs(d)) add('document', d.id);
  return out;
}

const wordOf = (words: readonly SourceWord[] | null | undefined, v: Provenance) => (v.raw_path == null ? undefined : words?.find((w) => w.raw_path === v.raw_path));

function recordIs(r: RecordEntry): boolean {
  const from = r.provenance ?? [];
  const verification = r.fields?.verification_status;
  const own = () => saysInError({ status: r.status, verification: typeof verification === 'string' ? verification : undefined });
  if (from.length === 0) return own();
  const named = r.fields_from;
  const writer = named != null && from.some((v) => v.raw_path === named && canWrite(r, v)) ? named : undefined;
  // Its own status is the word of its only source, and of the one its values are of.
  const wrote = (v: Provenance) => from.length === 1 || (writer !== undefined && v.raw_path === writer);
  return from.every((v) => {
    const word = wordOf(r.words, v);
    return word ? saysInError(word) : wrote(v) && own();
  });
}

function paperIs(d: DocumentEntry): boolean {
  const from = [...(d.provenance ? [d.provenance] : []), ...(d.also_from ?? [])];
  return from.length > 0 && from.every((v) => {
    const word = wordOf(d.words, v);
    return word !== undefined && saysInError(word);
  });
}

/** Import lets the first resource of a source on the record write its fields, and of those with no id the first of its type; one that says it is entered in error after the others. */
export function canWrite(r: RecordEntry, v: Provenance): boolean {
  const isError = (q: Provenance) => {
    const word = wordOf(r.words, q);
    return word !== undefined && saysInError(word);
  };
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? undefined) === (b ?? undefined);
  const source = (q: Provenance) => same(q.source.fhir_base, v.source.fhir_base) && same(q.source.cli, v.source.cli) && same(q.source.organization_id, v.source.organization_id);
  const idless = (q: Provenance) => !q.source_resource?.id;
  const like = (r.provenance ?? []).filter((q) => source(q) && (!idless(v) || (idless(q) && same(q.source_resource?.type, v.source_resource?.type))));
  return (like.find((q) => !isError(q)) ?? like[0]) === v;
}

/** The ids of every kind. */
export const allOf = (errors: Errors): ReadonlySet<string> => new Set([...errors.values()].flatMap((ids) => [...ids]));
