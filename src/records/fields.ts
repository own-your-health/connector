// What a paper's text says on the lines it labels (medrec 0.9.12 and later,
// its data contract's "Fields of a paper"): when to come back, and the drugs
// it prescribes. medrec reads them as it files a paper, into index.json's
// `fields`; documents.json has them without those private by what they say,
// each drug with the person's medicine of an equal code. medrec_document gives
// them as `labeled` lines, after a bill's amount due.

import type { Amount, RecordEntry } from './model';
import { recordInError } from './errors';

/** A field's lines in the paper's text: byte offset and length, without the line end, as private.json's parts have them. */
export type Place = [start: number, length: number];

export interface FollowUp {
  words: string;
  date?: string;
  dated?: 'printed' | 'relative' | 'resolved';
  with?: string[];
  lines: Place[];
}

export interface Drug {
  drug: string;
  directions?: string;
  rxnorm?: string;
  ndc?: string;
  lines: Place[];
  /** The id of the person's medicine of an equal code (documents.json; this connector's own reading of index.json). */
  medicine?: string;
}

export interface PaperFields {
  follow_up?: FollowUp[];
  drugs?: Drug[];
}

/** The most labeled lines a document answer gives, before one that says how many more. */
export const LABELED = 20;

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const NDC = 'http://hl7.org/fhir/sid/ndc';

/** An NDC as eleven digits: five of the labeler, four of the product and two of the package. Ten with no hyphens can be one of three, and are as they are. */
export function ndc(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const parts = text.trim().split('-');
  if (!parts.every((p) => /^[0-9]+$/.test(p))) return undefined;
  if (parts.length === 1) return parts[0]!.length === 10 || parts[0]!.length === 11 ? parts[0] : undefined;
  if (parts.length !== 3) return undefined;
  const [l, p, k] = parts as [string, string, string];
  return l.length <= 5 && p.length <= 4 && k.length <= 2 ? l.padStart(5, '0') + p.padStart(4, '0') + k.padStart(2, '0') : undefined;
}

/** The person's medicine a paper's drug is, by an equal RxNorm code or NDC, never by its name; one entered in error is none. */
export function medicineOf(d: Drug, records: readonly RecordEntry[]): RecordEntry | undefined {
  return records.find((r) => {
    if (r.kind !== 'medication' || recordInError(r)) return false;
    const system = r.code?.system ?? undefined;
    const code = r.code?.code?.trim();
    const rx = system === RXNORM && code !== undefined && d.rxnorm === code;
    const pack = r.fields?.ndc;
    const byNdc = d.ndc !== undefined && ((system === NDC && ndc(code) === d.ndc) || (typeof pack === 'string' && ndc(pack) === d.ndc));
    return rx || byNdc;
  });
}

/** A paper's fields as the views give them: each drug with the id of the person's medicine of an equal code. */
export function withMedicines(f: PaperFields, records: readonly RecordEntry[]): PaperFields {
  if (!f.drugs) return f;
  return {
    ...f,
    drugs: f.drugs.map((d) => {
      const { medicine: _, ...drug } = d;
      const m = medicineOf(drug, records);
      return m ? { ...drug, medicine: m.id } : drug;
    }),
  };
}

/** Whether any of a field's lines is among a paper's private places. */
export function leftOut(lines: readonly Place[], places: readonly (readonly number[])[]): boolean {
  return lines.some(([s, n]) => places.some((p) => p[0] === s && p[1] === n));
}

/** A bill's amount due and its due date as a line. */
export function dueLine(amount: Amount | null | undefined, due: string | null | undefined): string | undefined {
  const a = amount ? `${amount.amount} ${amount.currency}` : undefined;
  const d = due ?? undefined;
  if (a !== undefined && d !== undefined) return `Amount due: ${a}, by ${d}`;
  if (a !== undefined) return `Amount due: ${a}`;
  if (d !== undefined) return `Due by ${d}`;
  return undefined;
}

const HOW = { printed: 'as printed', relative: "from the paper's date", resolved: 'printed with no year' } as const;

/** A follow-up as a line: its words, and the day they tell and how. */
export function followUpLine(f: FollowUp): string {
  const how = f.dated === undefined ? undefined : HOW[f.dated];
  return f.date !== undefined && how !== undefined ? `Follow-up: ${f.words} (${f.date}, ${how})` : `Follow-up: ${f.words}`;
}

/** A drug as a line: as printed, its directions, its codes and the person's medicine of an equal code. */
export function drugLine(d: Drug, medicine: string | undefined): string {
  let out = `Drug, from a paper: ${d.drug}`;
  if (d.directions !== undefined) out += `: ${d.directions}`;
  const said = [...(d.rxnorm !== undefined ? [`RxNorm ${d.rxnorm}`] : []), ...(d.ndc !== undefined ? [`NDC ${d.ndc}`] : []), ...(medicine !== undefined ? [`the person's medicine ${medicine}`] : [])];
  if (said.length > 0) out += ` (${said.join('; ')})`;
  return out;
}

/** At most LABELED lines, then one that says how many more there are. */
export function capped(lines: string[]): string[] {
  if (lines.length <= LABELED) return lines;
  return [...lines.slice(0, LABELED), `${lines.length - LABELED} more on labeled lines: the text has them`];
}
