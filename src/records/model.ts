// The records folder's files as medrec writes them (medrec-cli
// docs/data-contract.md): household.json, and per person index.json,
// text.json and notes.md. Only the fields the tools read are typed; the rest
// pass through untouched.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Person {
  id: string;
  name: string;
  /** The person's folder in the records folder; it never changes. */
  folder: string;
  birth_date?: string | null;
  adult: boolean;
  aliases?: string[];
}

export interface Organization {
  id: string;
  name: string;
  fhir_base?: string | null;
}

export interface Household {
  schema: string;
  format: number;
  people: Person[];
  organizations?: Organization[];
}

export interface Coding {
  system?: string | null;
  code?: string | null;
  display?: string | null;
}

export interface Provenance {
  source: { kind?: string; cli?: string | null; fhir_base?: string | null };
}

export interface RecordEntry {
  id: string;
  kind: string;
  date?: string | null;
  code?: Coding | null;
  display: string;
  status?: string | null;
  fields?: JsonObject;
  documents?: string[];
  provenance?: Provenance[];
}

export interface Amount {
  amount: string;
  currency: string;
}

export interface Statement {
  statement_date?: string | null;
  amount_due?: Amount | null;
  due_date?: string | null;
  account?: string | null;
}

export interface DocumentEntry {
  id: string;
  path: string;
  title?: string | null;
  original_name?: string | null;
  doc_type?: string | null;
  date?: string | null;
  organization?: string | null;
  text?: { chars?: number } | null;
  statement?: Statement | null;
  same_statement_as?: string | null;
}

export interface Series {
  description?: string | null;
}

export interface Study {
  id: string;
  date?: string | null;
  modalities?: string[];
  body_part?: string | null;
  description?: string | null;
  facility?: string | null;
  series?: Series[];
  instances?: number;
}

export interface ImportRun {
  imported_at: string;
}

export interface PersonIndex {
  schema: string;
  documents?: DocumentEntry[];
  records?: RecordEntry[];
  studies?: Study[];
  imports?: ImportRun[];
}

export interface PersonText {
  schema: string;
  texts?: Record<string, string>;
}

export interface Note {
  id: string;
  date: string;
  author?: string;
  text: string;
  tags: string[];
  about: string[];
}

/** The newest `household.json` format these tools read (data contract, rule 4). */
export const FORMAT = 1;
