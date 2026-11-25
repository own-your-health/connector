// Which of a person's sources a record came from, ported from medrec 0.9.6
// (src/sources.rs; its data contract's "Which source"), so each label matches
// `medrec mcp`'s.
//
// One CLI, organization and FHIR base can serve several practices and several
// people, as a records connection does, so those three alone name no
// practice. A source is told apart by its person and by the patient its
// records were imported as, which the import run that filed a record says.
// Where differently named sources are left, none of them is the one.

import type { Household, ImportRun, RecordEntry, SignIn } from './model';
import { trim } from './text';

/** What a record came through: its source's name, else its CLI. */
export type SourceOf = (r: RecordEntry) => string | undefined;

const baseOf = (b: string | null | undefined) => (b ?? '').replace(/\/+$/, '');

/** Whether a source is at the FHIR base a record gives, trailing slashes aside; any is, when the record gives none. */
export const atBase = (record: string | null | undefined, source: string | null | undefined) => record === null || record === undefined || baseOf(source) === baseOf(record);

/** The name all of these have; none where they differ, or one has none. */
function named(sources: SignIn[]): string | undefined {
  const name = (s: SignIn | undefined) => trim(s?.organization_name ?? '');
  const first = name(sources[0]);
  return first !== '' && sources.every((s) => name(s) === first) ? first : undefined;
}

/** The patients of the import runs at one moment, by CLI, organization and moment. */
function patientsAt(runs: ImportRun[], at: (r: ImportRun) => string | undefined): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  for (const r of runs) {
    const t = at(r);
    if (t === undefined || r.cli === undefined || r.organization === undefined || r.patient_id === undefined) continue;
    const key = `${r.cli}\0${r.organization}\0${t}`;
    (by.get(key) ?? by.set(key, new Set()).get(key)!).add(r.patient_id);
  }
  return by;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The labels of a person's records. `imports` are their index's import runs;
 * without them, as from a view, no record's patient is known.
 */
export function sourcesOf(h: Household, pid: string, imports: ImportRun[] = []): SourceOf {
  const own = (h.sources ?? []).filter((s) => s.person === pid);
  const filed = patientsAt(imports, (r) => r.imported_at);
  const read = patientsAt(imports, (r) => r.pulled_at);
  return (r) => {
    const pv = r.provenance?.[0];
    const cli = pv?.source.cli ?? undefined;
    const organization = pv?.source.organization_id ?? undefined;
    if (!pv || cli === undefined || organization === undefined) return cli;
    const at = (by: Map<string, Set<string>>, t: string | null | undefined) => by.get(`${cli}\0${organization}\0${t ?? ''}`) ?? NONE;
    // The run that filed it says; of several, the one that also read it; of none, the one that read it.
    const [f, d] = [at(filed, pv.filed_at), at(read, pv.fetched_at)];
    const patients = f.size === 0 ? [...d] : f.size === 1 ? [...f] : [...f].filter((x) => d.has(x));
    const patient = patients.length === 1 ? patients[0] : undefined;
    const from = own.filter(
      (s) => s.cli === cli && s.organization === organization && atBase(pv.source.fhir_base, s.fhir_base) && (patient === undefined || s.patient_id === patient),
    );
    return named(from) ?? cli;
  };
}
