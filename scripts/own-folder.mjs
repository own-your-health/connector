// Writes the folder of test/fixtures/words, test/fixtures/errors,
// test/fixtures/given, test/fixtures/questionnaires, test/fixtures/parts,
// test/fixtures/vaccines, test/fixtures/fills or test/fixtures/papers (medrec's
// own fixtures for what each source says of a condition, an allergy or a
// medicine, for what is entered in error, for what a source gave and no item
// shows, for what a questionnaire asks, for what of an open item is private, for
// the vaccines and the fills that claims tell of, and for the follow-ups and
// drugs papers label) as medrec reads it, with the views medrec wrote for it
// when `views`. All are of the household in test/fixtures/words. `child` is
// test/fixtures/questionnaires in a child's chart, born as in medrec's own tests,
// and `schedule` test/fixtures/vaccines of a person born as in medrec's own test
// of a schedule. The folders in TABLED are read by a medrec that keeps the
// invented vaccine schedule of medrec's tests (scripts/cdsi.mjs).

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const HOUSEHOLD = join(FIXTURES, 'words/household.json');

export const OWN = ['words', 'errors', 'given', 'questionnaires', 'child', 'parts', 'vaccines', 'fills', 'papers', 'schedule'];
export const TABLED = ['vaccines', 'schedule'];

/** The fixtures a folder's files are, and when its people were born. */
const BORN = { child: ['questionnaires', '2015-02-03'], schedule: ['vaccines', '2020-02-02'] };

/** The fixtures whose files a folder holds. */
export const filesOf = (name) => BORN[name]?.[0] ?? name;

export function ownFolder(name, out, { views = false } = {}) {
  const [files, born] = BORN[name] ?? [name];
  const from = join(FIXTURES, files);
  const h = JSON.parse(readFileSync(HOUSEHOLD, 'utf8'));
  mkdirSync(out, { recursive: true });
  if (born) for (const p of h.people) p.birth_date = born;
  writeFileSync(join(out, 'household.json'), JSON.stringify(h, null, 1));
  for (const p of h.people) {
    mkdirSync(join(out, p.folder));
    for (const f of ['index.json', 'text.json', 'marks.json', 'overrides.json']) if (existsSync(join(from, f))) cpSync(join(from, f), join(out, p.folder, f));
  }
  if (views) cpSync(join(FIXTURES, name, 'views'), join(out, 'views'), { recursive: true });
  return out;
}
