// Plain names of diagnosis codes (medrec 0.9.4 and later): the ICD-10-CM
// titles of the codes a person's conditions use, from their code-names.json.
// They only label conditions an answer already shows, beside the source's own
// words. Filters, search, sorting, cursors and the check of whether a question
// names a private item use the source's words alone. medrec-cli
// docs/data-contract.md, "Code names"; medrec's src/code_names.rs.

import type { RecordEntry } from './model';

const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The key of a code of ICD-10-CM: `icd10cm|J30.9` for `J309`, `j30.9` and `J30.9`. */
export function nameKey(system: string | null | undefined, code: string | null | undefined): string | undefined {
  if (typeof system !== 'string' || typeof code !== 'string' || asciiLower(system.trim()) !== ICD10) return undefined;
  const bare = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (bare.length < 3 || bare.length > 7 || !/^[A-Z]/.test(bare)) return undefined;
  return `icd10cm|${bare.slice(0, 3)}${bare.length > 3 ? `.${bare.slice(3)}` : ''}`;
}

/** The key of a condition's plain name; no other kind has one. */
export function conditionKey(r: RecordEntry): string | undefined {
  return r.kind === 'condition' ? nameKey(r.code?.system, r.code?.code) : undefined;
}

/** A person's plain names by key. `codes` has those an item that is not private uses, `privateCodes` those only private items use. */
export interface CodeNames {
  codes: ReadonlyMap<string, string>;
  privateCodes: ReadonlyMap<string, string>;
}

export const NO_NAMES: CodeNames = { codes: new Map(), privateCodes: new Map() };

/** code-names.json as a reader needs it (medrec-code-names/v1). */
export type CodeNamesView = { person?: unknown; codes?: unknown; private_codes?: unknown };

export function codeNamesOf(view: CodeNamesView, person: string): CodeNames {
  if (view.person !== person) return NO_NAMES;
  const map = (v: unknown) =>
    new Map(
      Object.entries((typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, { name?: unknown } | null>).flatMap(([k, x]) =>
        typeof x?.name === 'string' ? [[k, x.name] as const] : [],
      ),
    );
  return { codes: map(view.codes), privateCodes: map(view.private_codes) };
}

/**
 * An item's plain name. An answer about the whole household (`whole`) uses
 * `codes` only and gives a private item none. One about a person uses both.
 */
export function plainName(n: CodeNames, key: string, whole: boolean, isPrivate: boolean): string | undefined {
  if (whole) return isPrivate ? undefined : n.codes.get(key);
  return n.codes.get(key) ?? n.privateCodes.get(key);
}
