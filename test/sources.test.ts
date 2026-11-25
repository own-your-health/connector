// Which of a person's sources a record came from (src/records/sources.ts), a
// case of the rule at a time. The cases are in fixtures/which-source.json.

import { describe, expect, test } from 'vitest';
import type { Household, ImportRun, Organization, Provenance, SignIn } from '../src/records/model';
import { atBase, sourcesOf } from '../src/records/sources';
import sample from './fixtures/which-source.json';

interface Case {
  /** Whose record it is, when not the sample's person's. */
  person?: string;
  sources?: SignIn[];
  organizations?: Organization[];
  imports?: ImportRun[];
  provenance?: Provenance[];
}

/** What a reader sees as the source of a case's record. */
function shown(name: keyof typeof sample.cases): string | undefined {
  const { person = sample.person, sources, organizations, imports, provenance }: Case = sample.cases[name];
  const household: Household = { ...sample.household, sources, organizations };
  return sourcesOf(household, person, imports)({ ...sample.record, provenance });
}

describe('the name', () => {
  test('one source gives its name', () => expect(shown('one source')).toBe('Example Hill Clinic'));
  test('several sources of one name give it', () => expect(shown('sources of one name')).toBe('Example Hill Clinic'));
  test('several names give none of them, only the CLI', () => expect(shown("a connection's name beside its practices'")).toBe('portal-a'));
  test('a first source with no name leaves the CLI', () => expect(shown('the first has no name')).toBe('portal-a'));
  test('a last source with no name leaves the CLI', () => expect(shown('the last has no name')).toBe('portal-a'));
  test('a blank name is no name', () => expect(shown('a blank name')).toBe('portal-a'));
  test('a name is shown without the space around it', () => expect(shown('space around a name')).toBe('Example Hill Clinic'));
  test('names that differ in the space around them are one', () => expect(shown('space around some of the names')).toBe('Example Hill Clinic'));
});

describe('whose sources', () => {
  test("other people's do not count", () => expect(shown("other people's sources beside")).toBe('Example Valley Clinic'));
  test("other people's alone name nothing", () => expect(shown("only other people's sources")).toBe('portal-b'));
  test('an entry of organizations names nothing', () => expect(shown('only an entry of organizations')).toBe('portal-a'));
  test('a household with no sources shows the CLI', () => expect(shown('no list of sources')).toBe('portal-a'));
});

describe('which of their sources', () => {
  test("another CLI's does not count", () => expect(shown("another CLI's source beside")).toBe('Example Hill Clinic'));
  test("another organization's does not count", () => expect(shown("another organization's source beside")).toBe('Example Hill Clinic'));
  test('one at another FHIR base does not count', () => expect(shown('a source at another base beside')).toBe('Example Hill Clinic'));
  test('one with no FHIR base does not count for a record with one', () => expect(shown('sources with no base beside')).toBe('Example Hill Clinic'));
  test("a final slash on the record's base is no difference", () => expect(shown("a final slash on the record's base")).toBe('Example Hill Clinic'));
  test("a final slash on the source's base is no difference", () => expect(shown("a final slash on the source's base")).toBe('Example Hill Clinic'));
  test('a record with no base came from one at any base', () => expect(shown('a record with no base')).toBe('Example Hill Clinic'));
  test('a record with a null base came from one at any base', () => expect(shown('a record with a null base')).toBe('Example Hill Clinic'));
  test('a record with no base and several names shows the CLI', () => expect(shown('a record with no base, and a name at each of three')).toBe('portal-a'));
});

describe('the patient', () => {
  test('the run that filed a record gives its patient', () => expect(shown("filed by one patient's run")).toBe('Example Lake Clinic'));
  test('the run that filed it goes before the one that read it', () => expect(shown("filed by one patient's run, read by another's")).toBe('Example Hill Clinic'));
  test('of two patients filed at once, the one read then', () => expect(shown('filed for two patients, read for one')).toBe('Example Lake Clinic'));
  test('a patient read then and not filed is not one of them', () => expect(shown('filed for two patients, read for one of them and a third')).toBe('Example Lake Clinic'));
  test('two filed at once and neither read then is not known', () => expect(shown('filed for two patients, read for neither')).toBe('portal-a'));
  test('two filed and read at once is not known', () => expect(shown('filed and read for two patients')).toBe('portal-a'));
  test('with none that filed it, the run that read it gives its patient', () => expect(shown('filed by no run, read by one')).toBe('Example Lake Clinic'));
  test('with none that filed it, two read at once is not known', () => expect(shown('filed by no run, read for two patients')).toBe('portal-a'));
  test('with none that filed or read it, it is not known', () => expect(shown('filed and read by no run')).toBe('portal-a'));
  test('a record and a run that do not say when they were read do not match', () => expect(shown('a record and a run that do not say when they were read')).toBe('portal-a'));
  test("another CLI's run does not count", () => expect(shown("another CLI's run at the same moment")).toBe('Example Lake Clinic'));
  test("another organization's run does not count", () => expect(shown("another organization's run at the same moment")).toBe('Example Lake Clinic'));
  test('a CLI and organization are never run together', () => expect(shown('a CLI and organization that read alike run together')).toBe('Example Lake Clinic'));
  test('a run with no patient does not count', () => expect(shown('a run with no patient beside')).toBe('Example Lake Clinic'));
  test('two runs of one patient are that patient', () => expect(shown('two runs of one patient')).toBe('Example Lake Clinic'));
  test("a patient only another person's source has leaves the CLI", () => expect(shown("a patient only another person's source has")).toBe('portal-b'));
  test('a source with no patient is not a known one', () => expect(shown('sources with no patient beside')).toBe('Example Hill Clinic'));
});

describe('what the record says', () => {
  test('a record with no CLI shows no source', () => expect(shown('no CLI')).toBeUndefined());
  test('a record with a null CLI shows no source', () => expect(shown('a null CLI')).toBeUndefined());
  test('a record with no organization shows the CLI', () => expect(shown('no organization')).toBe('portal-a'));
  test('a record with a null organization shows the CLI', () => expect(shown('a null organization')).toBe('portal-a'));
  test('a record with no provenance shows no source', () => expect(shown('no provenance')).toBeUndefined());
  test('a record with an empty provenance shows no source', () => expect(shown('an empty provenance')).toBeUndefined());
  test('the first provenance says it', () => expect(shown('two provenances')).toBe('Example Hill Clinic'));
});

describe('a FHIR base', () => {
  const { one, two, 'one with a final slash': slashed } = sample.bases;
  test('is at itself', () => expect(atBase(one, one)).toBe(true));
  test('is not at another', () => expect(atBase(one, two)).toBe(false));
  test("is at itself with a final slash on either one's", () => expect([atBase(slashed, one), atBase(one, slashed)]).toEqual([true, true]));
  test('that a source does not have is not it', () => expect([atBase(one, undefined), atBase(one, null)]).toEqual([false, false]));
  test('that a record does not have is any, and none', () => expect([atBase(undefined, one), atBase(null, two), atBase(undefined, null)]).toEqual([true, true, true]));
});
