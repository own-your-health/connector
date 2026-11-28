// The records folder's files as medrec writes them (medrec-cli
// docs/data-contract.md): household.json, and per person index.json,
// text.json and notes.md. Only the fields the tools read are typed; the rest
// pass through untouched.

import type { PaperFields } from './fields';

declare const exact: unique symbol;
/** A number kept as its file writes it, as JSON.rawJSON holds it (numbers.ts). */
export interface ExactNumber {
  readonly [exact]: true;
  readonly rawJSON: string;
}

export type Json = null | boolean | number | string | ExactNumber | Json[] | { [key: string]: Json };
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

/** A sign-in the household's records come through: one person's, at one organization, by one CLI. */
export interface SignIn {
  person?: string;
  cli?: string | null;
  /** The organization's id as the CLI names it: a record's `organization_id`. */
  organization?: string | null;
  organization_name?: string | null;
  fhir_base?: string | null;
  patient_id?: string | null;
}

export interface Household {
  schema: string;
  format: number;
  people: Person[];
  organizations?: Organization[];
  sources?: SignIn[];
}

export interface Coding {
  system?: string | null;
  code?: string | null;
  display?: string | null;
}

export interface Provenance {
  source: { kind?: string; cli?: string | null; organization_id?: string | null; fhir_base?: string | null };
  source_resource?: { type: string; id: string } | null;
  fetched_at?: string | null;
  filed_at?: string;
  raw_path?: string | null;
}

/** What one source says of an item. */
export interface SourceWord {
  raw_path: string;
  status?: string | null;
  verification?: string | null;
}

export interface Given {
  raw_path?: string | null;
  display?: string;
  code?: Coding;
  fields?: JsonObject;
  /** What a panel or a report listed before, as a record's. */
  lists?: Record<string, string[]>;
}

export interface GivenPaper {
  title?: string;
}

export interface RecordEntry {
  id: string;
  kind: string;
  /** medrec's merge key: one fact from two sources is one record. A vaccine a claim tells of has its claim's, and the line's `sequence`. */
  key?: string;
  date?: string | null;
  code?: Coding | null;
  display: string;
  status?: string | null;
  fields?: JsonObject;
  /** What a source says of the providers `fields` print, beyond their names (medrec). A vaccine a claim tells of has none. */
  providers?: Json;
  documents?: string[];
  provenance?: Provenance[];
  /** What a source gave and no item shows (medrec 0.9.9 and later). It is in no view or answer. */
  given?: Given[];
  /** The raw file its values are of, when several have it (medrec 0.9.9 and later). */
  fields_from?: string | null;
  /** What each source says of it (medrec 0.9.9 and later). */
  words?: SourceWord[];
  /** What each source says of one that a source says is entered in error (the views, medrec 0.9.9 and later). */
  says?: Json;
  /** The raw files of the results a panel or a report lists, under their source, by the raw file that lists them (medrec 0.9.10 and later). */
  lists?: Record<string, string[]>;
  /** The questionnaires that list a result, then or now (medrec 0.9.10 and later). */
  listed_by?: { display: string; code?: Coding | null }[];
  /** It is a result that is a heading (the views, medrec 0.9.10 and later). */
  heading?: boolean;
}

/** A record as a list shows it. */
export interface ListedRecord extends RecordEntry {
  /** What it came through (sources.ts), as `medrec mcp` labels it. */
  source: string | undefined;
  /** How much of it an answer that names no person leaves out (parts.ts). */
  not_shown?: string;
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
  provenance?: Provenance;
  also_from?: Provenance[];
  /** As a record's. */
  words?: SourceWord[];
  given?: GivenPaper[];
  says?: Json;
  /** What its text says on the lines it labels (medrec 0.9.12 and later; fields.ts). */
  fields?: PaperFields | null;
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
  pulled_at?: string;
  cli?: string;
  /** The organization's id as the CLI names it: a record's `organization_id`. */
  organization?: string;
  patient_id?: string;
}

export interface PersonIndex {
  schema: string;
  documents?: DocumentEntry[];
  records?: RecordEntry[];
  studies?: Study[];
  imports?: ImportRun[];
  /** The ids of what is about somebody else, and left out of it here (about.ts). */
  about_another?: string[];
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
