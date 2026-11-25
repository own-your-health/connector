// What a source gave and no item shows (`given` in index.json, medrec 0.9.9 and
// later): medrec decides by it what is private, and it is in no view or answer.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { RawStore, type Store } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

const scratch = mkdtempSync(join(tmpdir(), 'oyh-given-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const WHO = 'Robin Example';

/** Every answer about the folder's one person and everyone. */
async function answers(store: Store): Promise<string> {
  const { documents } = JSON.parse(readFileSync(join(root, WHO, 'index.json'), 'utf8')) as { documents: { id: string }[] };
  const calls: [string, object][] = documents.map((d) => ['medrec_document', { id: d.id }]);
  for (const person of [{}, { person: 'Robin' }]) {
    for (const kind of ['claims', 'bills', 'documents', 'timeline']) calls.push(['medrec_records', { kind, response_format: 'detailed', ...person }]);
    for (const query of ['counseling', 'sample', 'visit']) calls.push(['medrec_search', { query, ...person }]);
    calls.push(['medrec_summary', person]);
  }
  const out = [];
  for (const [name, args] of calls) out.push((await callTool(name, args as Record<string, unknown>, { store, today: '2026-11-25' }))!.content[0]!.text);
  return out.join('\n');
}

const root = ownFolder('given', join(scratch, 'given'));
const at = join(root, WHO, 'index.json');
const index = JSON.parse(readFileSync(at, 'utf8')) as { records: { given?: { fields: { provider: string } }[] }[]; documents: object[] };
const gave = index.records.flatMap((r) => r.given ?? []).map((g) => g.fields.provider);

describe('what a source gave and no item shows', () => {
  // A paper's is what it was called.
  index.documents = index.documents.map((d) => ({ ...d, given: [{ organization: gave[0], title: gave[0] }] }));
  writeFileSync(at, JSON.stringify(index));
  writeViewsAt(root);

  it('is in no view', () => {
    expect(gave).toEqual(['Sample Counseling Room']);
    const views = readdirSync(join(root, 'views'), { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    expect(views.length).toBeGreaterThan(5);
    for (const f of views) expect(readFileSync(join(f.parentPath, f.name), 'latin1').toLowerCase(), f.name).not.toContain('counseling');
  });

  it('is in no answer, from the files or the views', async () => {
    for (const store of [new RawStore(folderAt(root)), new ViewsStore(folderAt(root))]) {
      const said = await answers(store);
      expect(said).toContain('Example Hearing Room');
      expect(said).not.toContain(gave[0]);
      expect(said).not.toContain('"given"');
    }
  });
});
