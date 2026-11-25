// Writes the folder of test/fixtures/labels (medrec's own fixture for provider
// labels) as medrec reads it: household.json, and one person's files.

import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FROM = join(import.meta.dirname, '../test/fixtures/labels');

export function labelsFolder(out) {
  mkdirSync(out, { recursive: true });
  cpSync(join(FROM, 'household.json'), join(out, 'household.json'));
  for (const p of JSON.parse(readFileSync(join(FROM, 'household.json'), 'utf8')).people) {
    mkdirSync(join(out, p.folder));
    for (const f of ['index.json', 'text.json', 'marks.json', 'provider-state.json']) cpSync(join(FROM, f), join(out, p.folder, f));
  }
  return out;
}
