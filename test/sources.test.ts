// Which of a person's sources a record came from (medrec 0.9.6's "Which
// source"), over one records connection that serves several practices and
// people.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Household, ImportRun } from '../src/records/model';
import { sourcesOf } from '../src/records/sources';

const { household, imports } = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/shared-source.json'), 'utf8')) as { household: Household; imports: ImportRun[] };
const BASE = 'https://records.example.test/fhir/r4';
const ALL = { cli: 'athena', organization_id: 'all', fhir_base: BASE };
type Times = { filed_at?: string; fetched_at?: string | null };
const day = (d: number) => `2026-02-0${d}T10:00`;

/** The label of a record of `person` from a source at those times. */
const label = (person: string, source: Record<string, string | null>, times: Times = {}, h = household, runs = imports) =>
  sourcesOf(h, person, runs)({ id: 'r_1', kind: 'result', display: 'x', provenance: [{ source, ...times }] });
/** The fixture's household with p_one's second practice called `name`, or not named. */
const second = (name: string | null): Household => ({ ...household, sources: household.sources!.map((s, i) => (i === 1 ? { ...s, organization_name: name } : s)) });
const without = (...i: number[]): Household => ({ ...household, sources: household.sources!.filter((_, k) => !i.includes(k)) });

describe("the practice a record came from (medrec 0.9.6)", () => {
  it('is that of the patient the run that filed it read', () => {
    expect(label('p_one', ALL, { filed_at: `${day(3)}:30Z` })).toBe('Example North Clinic');
    expect(label('p_one', ALL, { filed_at: `${day(4)}:30Z` })).toBe('Example South Clinic');
    // Read again by another run, it is still the first's.
    expect(label('p_one', ALL, { filed_at: `${day(3)}:30Z`, fetched_at: `${day(4)}:01Z` })).toBe('Example North Clinic');
    // Filed by none on record, it is that of the run that read it.
    expect(label('p_one', ALL, { filed_at: `${day(1)}:30Z`, fetched_at: `${day(4)}:01Z` })).toBe('Example South Clinic');
    // Two runs of two patients filed at once: the one that read it, and neither when no run says.
    expect(label('p_one', ALL, { filed_at: `${day(7)}:30Z`, fetched_at: `${day(7)}:09Z` })).toBe('Example South Clinic');
    expect(label('p_one', ALL, { filed_at: `${day(7)}:30Z`, fetched_at: `${day(4)}:01Z` })).toBe('Example South Clinic');
    expect(label('p_one', ALL, { filed_at: `${day(7)}:30Z` })).toBe('athena');
    expect(label('p_one', ALL, { filed_at: `${day(1)}:30Z`, fetched_at: `${day(8)}:01Z` })).toBe('athena');
    // A run of another organization says nothing.
    expect(label('p_one', ALL, { filed_at: `${day(5)}:30Z` })).toBe('athena');
    // A patient none of the person's sources has is no one's.
    expect(label('p_one', ALL, { filed_at: `${day(6)}:30Z` })).toBe('athena');
    expect(label('p_one', ALL, { filed_at: `${day(6)}:30Z` }, without(1))).toBe('athena');
  });

  it('is not known without the patient where the person has two, but one name twice is one', () => {
    for (const times of [{}, { filed_at: `${day(1)}:30Z`, fetched_at: null }]) {
      expect(label('p_one', ALL, times)).toBe('athena');
      // A connection's own name, or none, differs from a practice's.
      expect(label('p_one', ALL, times, second('athenahealth (all practices)'))).toBe('athena');
      expect(label('p_one', ALL, times, second(null))).toBe('athena');
      expect(label('p_one', ALL, times, second(' '))).toBe('athena');
      expect(label('p_one', ALL, times, second(' Example North Clinic '))).toBe('Example North Clinic');
    }
    const last = (name: string | null): Household => ({ ...household, sources: household.sources!.map((s, i) => (i === 0 ? { ...s, organization_name: name } : s)) });
    expect(label('p_one', ALL, {}, last(null))).toBe('athena');
    // As when its views hold no import runs.
    expect(label('p_one', ALL, { filed_at: `${day(3)}:30Z` }, household, [])).toBe('athena');
    expect(label('p_one', ALL, {}, without(1), [])).toBe('Example North Clinic');
  });

  it('is never another person\'s, whatever the order, nor the household\'s organization at the base', () => {
    const turned: Household = { ...household, sources: [...household.sources!].reverse() };
    for (const h of [household, turned]) expect(label('p_two', ALL, {}, h, [])).toBe('Example West Clinic');
    expect(label('p_one', ALL, {}, without(0, 1), [])).toBe('athena');
    expect(label('p_two', ALL, {}, without(4), [])).toBe('athena');
    expect(label('p_three', ALL)).toBe('athena');
    const nobody: Household = { ...household, sources: household.sources!.map(({ person: _, ...s }) => s) };
    expect(label('p_one', ALL, { filed_at: `${day(3)}:30Z` }, nobody)).toBe('athena');
    // Its one source's own name is shown, even a connection's.
    expect(label('p_one', ALL, {}, { ...household, sources: [{ ...household.sources![0]!, organization_name: 'athenahealth (all practices)' }] }, [])).toBe('athenahealth (all practices)');
  });

  it('goes by the CLI, the organization and the base it has', () => {
    const north = { filed_at: `${day(3)}:30Z` };
    expect(label('p_one', { ...ALL, fhir_base: `${BASE}//` }, north)).toBe('Example North Clinic');
    expect(label('p_one', { cli: 'athena', organization_id: 'all' }, north)).toBe('Example North Clinic');
    expect(label('p_one', { ...ALL, fhir_base: 'https://other.example.test' }, north)).toBe('athena');
    expect(label('p_one', { ...ALL, organization_id: 'none' }, north)).toBe('athena');
    expect(label('p_one', { ...ALL, organization_id: null }, north)).toBe('athena');
    expect(label('p_one', { cli: 'uhc', organization_id: 'plan' })).toBe('Example Plan');
    expect(label('p_one', { cli: 'uhc', organization_id: 'plan', fhir_base: '' })).toBe('Example Plan');
    expect(label('p_one', { cli: 'uhc', organization_id: 'plan', fhir_base: BASE })).toBe('uhc');
    expect(label('p_one', { cli: 'labcorp', organization_id: 'lab' })).toBe('labcorp');
    expect(label('p_one', { cli: 'labcorp', organization_id: 'plan' })).toBe('labcorp');
    expect(label('p_one', { organization_id: 'all' })).toBeUndefined();
    expect(label('p_one', {})).toBeUndefined();
    expect(sourcesOf(household, 'p_one', imports)({ id: 'r_1', kind: 'result', display: 'x' })).toBeUndefined();
    expect(sourcesOf({ schema: '', format: 1, people: [] }, 'p_one')({ id: 'r_1', kind: 'result', display: 'x', provenance: [{ source: ALL }] })).toBe('athena');
  });
});
