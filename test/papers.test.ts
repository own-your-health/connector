// What a paper's text says on the lines it labels (medrec 0.9.12, its data
// contract's "Fields of a paper"; src/records/fields.ts), as medrec_document's
// `labeled` lines. test/golden.test.ts holds every answer over medrec's own
// views of test/fixtures/papers to medrec's. These are the same papers read
// from their files and from this connector's own views script, and the pieces.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { capped, drugLine, dueLine, followUpLine, leftOut, medicineOf, ndc } from '../src/records/fields';
import { ParsedCache } from '../src/records/folder';
import type { RecordEntry } from '../src/records/model';
import { parseExact } from '../src/records/numbers';
import { RawStore, type Store } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

interface Result {
  folder: string;
  name: string;
  arguments?: Record<string, unknown>;
  answer: { result: { structuredContent: Record<string, unknown> } };
}
const golden = parseExact(readFileSync(join(import.meta.dirname, 'golden/medrec.json'), 'utf8')) as { as_of: string; results: Result[] };
const documents = golden.results.filter((g) => g.folder === 'papers' && g.name === 'medrec_document');
/** A drug's line without the id of the person's medicine. */
const withoutMedicine = (l: string) => l.replace(/; the person's medicine r_[a-z2-7]{20}\)$/, ')').replace(/ \(the person's medicine r_[a-z2-7]{20}\)$/, '');

describe("a paper's labeled lines", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-papers-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const files = ownFolder('papers', join(scratch, 'files'));
  const own = ownFolder('papers', join(scratch, 'own'));
  writeViewsAt(own);
  const stores: [string, () => Store][] = [
    ['the files', () => new RawStore(folderAt(files, new ParsedCache()))],
    ["this connector's own views", () => new ViewsStore(folderAt(own, new ParsedCache()))],
  ];
  const labeled = async (store: Store, args: Record<string, unknown>) => ((await callTool('medrec_document', args, { store, today: golden.as_of }))!.structuredContent as { labeled?: string[] }).labeled;

  for (const [over, store] of stores) {
    it(`are medrec's, read from ${over} in an answer that names the person`, async () => {
      const named = documents.filter((g) => g.arguments?.person !== undefined);
      expect(named.length).toBeGreaterThan(3);
      for (const g of named) expect(await labeled(store(), g.arguments!), JSON.stringify(g.arguments)).toEqual(g.answer.result.structuredContent.labeled);
    });

    it(`are all of them read from ${over} without person, which say nothing private, but no medicine's id`, async () => {
      // Neither says what is private: no line is held back, and every medicine is, as each of the person's items is left out of an answer about the whole household until medrec marks them.
      for (const g of documents.filter((g) => g.arguments?.person !== undefined)) {
        const whole = g.answer.result.structuredContent.labeled as string[] | undefined;
        const { person: _, ...args } = g.arguments!;
        expect(await labeled(store(), args), JSON.stringify(args)).toEqual(whole?.map(withoutMedicine));
      }
    });
  }

  it("of a bill are its amount due and its due date, as medrec's tools answer them", () => {
    expect(dueLine({ amount: '90.00', currency: 'USD' }, '2024-10-29')).toBe('Amount due: 90.00 USD, by 2024-10-29');
    expect(dueLine({ amount: '90.00', currency: 'USD' }, null)).toBe('Amount due: 90.00 USD');
    expect(dueLine(null, '2024-10-29')).toBe('Due by 2024-10-29');
    expect(dueLine(undefined, undefined)).toBeUndefined();
  });

  it("say how each follow-up's day was told, and each drug's codes and the person's medicine", () => {
    const lines: [number, number][] = [[0, 1]];
    expect(followUpLine({ words: 'in 2 weeks.', date: '2025-03-24', dated: 'relative', lines })).toBe("Follow-up: in 2 weeks. (2025-03-24, from the paper's date)");
    expect(followUpLine({ words: 'on 1/5/2027.', date: '2027-01-05', dated: 'printed', lines })).toBe('Follow-up: on 1/5/2027. (2027-01-05, as printed)');
    expect(followUpLine({ words: 'on Apr 20.', date: '2025-04-20', dated: 'resolved', lines })).toBe('Follow-up: on Apr 20. (2025-04-20, printed with no year)');
    expect(followUpLine({ words: 'as needed.', lines })).toBe('Follow-up: as needed.');
    expect(drugLine({ drug: 'Sample 5 mg tablet', lines }, undefined)).toBe('Drug, from a paper: Sample 5 mg tablet');
    expect(drugLine({ drug: 'Sample 5 mg tablet', directions: '1 daily', rxnorm: '000001', ndc: '00000000101', lines }, 'r_aaaaaaaaaaaaaaaaaaaa')).toBe(
      "Drug, from a paper: Sample 5 mg tablet: 1 daily (RxNorm 000001; NDC 00000000101; the person's medicine r_aaaaaaaaaaaaaaaaaaaa)",
    );
  });

  it('are at most 20, and then one that says how many more the text has', () => {
    const of = (n: number) => Array.from({ length: n }, (_, i) => `Follow-up: ${i + 1}`);
    expect(capped(of(20))).toEqual(of(20));
    const more = capped(of(23));
    expect(more).toHaveLength(21);
    expect(more[19]).toBe('Follow-up: 20');
    expect(more[20]).toBe('3 more on labeled lines: the text has them');
  });

  it('leave out a field any of whose lines is a private place', () => {
    expect(leftOut([[14, 53]], [[14, 53], [99, 2]])).toBe(true);
    expect(leftOut([[77, 31], [109, 34]], [[109, 34]])).toBe(true);
    expect(leftOut([[14, 53]], [[14, 52]])).toBe(false);
    expect(leftOut([[14, 53]], [])).toBe(false);
  });
});

describe("a drug's medicine", () => {
  const med = (id: string, code: { system: string; code: string } | undefined, fields: Record<string, unknown> = {}, more: Partial<RecordEntry> = {}) =>
    ({ id, kind: 'medication', display: 'Sample', code, fields, provenance: [], ...more }) as unknown as RecordEntry;
  const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
  const NDC = 'http://hl7.org/fhir/sid/ndc';
  const drug = (d: { rxnorm?: string; ndc?: string }) => ({ drug: 'Sample', lines: [], ...d });

  it('is an NDC as eleven digits where its hyphens tell them, and ten without hyphens as they are', () => {
    expect(ndc('00000-0001-01')).toBe('00000000101');
    expect(ndc('0-1-1')).toBe('00000000101');
    expect(ndc(' 12345-678-9 ')).toBe('12345067809');
    expect(ndc('0000000101')).toBe('0000000101');
    expect(ndc('00000000101')).toBe('00000000101');
    for (const no of ['123456-1-1', '1-12345-1', '1-1-123', '1-1', '000000001', '000000001011', '0000a000101', '', '1--1', undefined]) expect(ndc(no)).toBeUndefined();
  });

  it("is the person's medicine of an equal RxNorm code or NDC, by its package's NDC too, never by name, and none entered in error", () => {
    const records = [
      med('r_byname', undefined),
      med('r_rx', { system: RX, code: ' 000001 ' }),
      med('r_ndc', { system: NDC, code: '00000-0001-01' }),
      med('r_pack', { system: RX, code: '000009' }, { ndc: '0-2-2' }),
      med('r_gone', { system: RX, code: '000003' }, {}, { status: 'entered-in-error' }),
      med('r_result', { system: RX, code: '000004' }, {}, { kind: 'result' }),
    ];
    expect(medicineOf(drug({ rxnorm: '000001' }), records)?.id).toBe('r_rx');
    expect(medicineOf(drug({ ndc: '00000000101' }), records)?.id).toBe('r_ndc');
    expect(medicineOf(drug({ ndc: '00000000202' }), records)?.id).toBe('r_pack');
    expect(medicineOf(drug({ rxnorm: '000003' }), records)).toBeUndefined();
    expect(medicineOf(drug({ rxnorm: '000004' }), records)).toBeUndefined();
    expect(medicineOf(drug({}), records)).toBeUndefined();
    expect(medicineOf(drug({ ndc: '0000000101' }), records)).toBeUndefined();
  });
});
