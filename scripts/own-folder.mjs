// Writes the folder of test/fixtures/words or test/fixtures/errors (medrec's own
// fixtures for what each source says of a condition, an allergy or a medicine,
// and for what is entered in error) as medrec reads it, with the views medrec
// wrote for it when `views`. Both are of the household in test/fixtures/words.

import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const HOUSEHOLD = join(FIXTURES, 'words/household.json');

export const OWN = ['words', 'errors'];

export function ownFolder(name, out, { views = false } = {}) {
  const from = join(FIXTURES, name);
  mkdirSync(out, { recursive: true });
  cpSync(HOUSEHOLD, join(out, 'household.json'));
  for (const p of JSON.parse(readFileSync(HOUSEHOLD, 'utf8')).people) {
    mkdirSync(join(out, p.folder));
    for (const f of ['index.json', 'marks.json', 'overrides.json']) if (existsSync(join(from, f))) cpSync(join(from, f), join(out, p.folder, f));
  }
  if (views) cpSync(join(from, 'views'), join(out, 'views'), { recursive: true });
  return out;
}
