// Writes the views into a records folder on disk: what medrec does on each
// refresh, for a folder medrec has not prepared (scripts/views.mjs) and for
// the tests. Node only; the Worker never writes.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Household, PersonIndex, PersonText } from '../records/model';
import { VIEWS_DIR } from './format';
import { writeViews, type PersonFiles } from './write';

const readOr = (p: string): Buffer | null => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

/** Replaces the folder's views with ones made from its files now; returns how many files and bytes. */
export function writeViewsAt(root: string, medrec = 'connector'): { files: number; bytes: number } {
  const householdBytes = readFileSync(join(root, 'household.json'));
  const h = JSON.parse(householdBytes.toString('utf8')) as Household;
  const people: PersonFiles[] = h.people.map((person) => {
    const indexBytes = readOr(join(root, person.folder, 'index.json'));
    const textBytes = readOr(join(root, person.folder, 'text.json'));
    const index = indexBytes ? (JSON.parse(indexBytes.toString('utf8')) as PersonIndex) : { schema: 'medrec-index/v1' };
    const text = textBytes ? (JSON.parse(textBytes.toString('utf8')) as PersonText) : { schema: 'medrec-text/v1' };
    return { person, index, texts: text.texts ?? {}, indexBytes, textBytes };
  });
  const out = writeViews(h, householdBytes, people, medrec);
  rmSync(join(root, VIEWS_DIR), { recursive: true, force: true });
  let bytes = 0;
  for (const [path, body] of out) {
    const at = join(root, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
    bytes += typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  }
  return { files: out.size, bytes };
}
