// The vaccines claims tell of (medrec 0.9.11, src/records/vaccines.ts), of
// medrec's own fixture: read from the files and from this connector's own views
// script, an answer that names the person lists them as `medrec mcp` does.
// From medrec's views, test/golden.test.ts holds every answer to medrec's.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { ParsedCache } from '../src/records/folder';
import { parseExact } from '../src/records/numbers';
import { RawStore, type Store } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { vaccineFamily } from '../src/records/vaccines';
import { VIEWS_INDEX } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { VIEWS_READER } from '../src/version';
import { folderAt } from './support';

interface Result {
  folder: string;
  name: string;
  arguments?: Record<string, unknown>;
  answer: { result: { structuredContent: Record<string, unknown> } };
}
const golden = parseExact(readFileSync(join(import.meta.dirname, 'golden/medrec.json'), 'utf8')) as { as_of: string; results: Result[] };

/** An answer's items, or a summary's immunizations, without whether one is private: medrec's views say that, and the files do not. */
function items(s: Record<string, any>): unknown[] {
  const all = s.items ?? s.summary.sections.find((x: { section: string }) => x.section === 'immunizations').items;
  return all.map(({ private: _, ...i }: Record<string, unknown>) => i);
}

describe('the vaccines claims tell of', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-vaccines-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const files = ownFolder('vaccines', join(scratch, 'files'));
  const own = ownFolder('vaccines', join(scratch, 'own'));
  writeViewsAt(own);
  const named = golden.results.filter((g) => g.folder === 'vaccines' && typeof g.arguments?.person === 'string' && (g.name === 'medrec_summary' || g.arguments.kind === 'immunizations'));

  it('are asked of', () => {
    expect(named.length).toBeGreaterThan(3);
    const all = JSON.stringify(named.map((g) => g.answer.result.structuredContent));
    expect(all.split('"from a claim"').length - 1).toBeGreaterThan(10);
  });

  const stores: [string, () => Store][] = [
    ['the files', () => new RawStore(folderAt(files, new ParsedCache()))],
    ["this connector's own views", () => new ViewsStore(folderAt(own, new ParsedCache()))],
  ];
  for (const [over, store] of stores) {
    it(`are listed from ${over} in an answer that names the person, as medrec lists every one of a claim's lines`, async () => {
      for (const g of named) {
        const ours = await callTool(g.name, g.arguments, { store: store(), today: golden.as_of });
        expect(items(ours!.structuredContent as Record<string, unknown>), JSON.stringify(g.arguments)).toEqual(items(g.answer.result.structuredContent));
      }
    });
  }

  it('are in the views that script writes, which say the contract a reader must follow', () => {
    expect(JSON.parse(readFileSync(join(own, VIEWS_INDEX), 'utf8')).reader).toBe(VIEWS_READER);
  });
});

describe('a kind of vaccine by its name', () => {
  it("is the first of medrec's patterns it matches", () => {
    expect(vaccineFamily('Sample flu vaccine')).toBe('flu');
    expect(vaccineFamily('INFLUENZA, seasonal')).toBe('flu');
    expect(vaccineFamily('Hepatitis B')).toBe('hepb');
    expect(vaccineFamily('Hep-A')).toBe('hepa');
    expect(vaccineFamily('Td booster')).toBe('tdap');
    expect(vaccineFamily('Sample vaccine')).toBeUndefined();
  });

  it('starts and ends a word where a letter of any alphabet does not go on, as Rust reads \\b', () => {
    expect(vaccineFamily('flu-like')).toBe('flu');
    expect(vaccineFamily('aflu')).toBeUndefined();
    expect(vaccineFamily('Éflu')).toBeUndefined();
    expect(vaccineFamily('fluß')).toBeUndefined();
    expect(vaccineFamily('émmr')).toBeUndefined();
    expect(vaccineFamily('(MMR)')).toBe('mmr');
  });
});
