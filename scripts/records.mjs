#!/usr/bin/env node
// Writes the sample records folder (test/fixtures/records) from own-your-health/app's
// sample and what this connector's tests need beyond it (records/more.mjs).
// medrec 0.9.7, its own release, writes every record, paper, index and mark: no
// field of them is set here, but for the one marks.json that does not read, on purpose.
//
//   MEDREC=<medrec 0.9.7> node scripts/records.mjs <own-your-health/app at d897428> <a new folder>
//
// It writes to a folder that does not exist yet and deletes nothing. The app's
// scripts/medrec.mjs is the machine medrec runs on: a scratch home, nothing in
// its Keychain service, and the clock stopped, so the same sources give the
// same bytes.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { more } from './records/more.mjs';

const APP = process.argv[2] && resolve(process.argv[2]);
const OUT = process.argv[3] && resolve(process.argv[3]);
if (!APP || !OUT || existsSync(OUT)) {
  console.error('usage: MEDREC=<medrec 0.9.7> node scripts/records.mjs <own-your-health/app at d897428> <a new folder>');
  process.exit(2);
}
const from = (path) => import(pathToFileURL(join(APP, 'scripts', path)).href);
const { machineWith, put } = await from('providers.mjs');
const lib = { ...(await from('sample/fhir.mjs')), ...(await from('sample/papers.mjs')), ...(await from('sample/dicom.mjs')) };
const { PEOPLE, SOURCES } = await from('sample/household.mjs');
const robin = await from('sample/robin.mjs');
const sam = await from('sample/sam.mjs');

const extra = more({ lib, sample: { PEOPLE, SOURCES } });
const people = { ...PEOPLE, ...extra.people };
const sources = { ...SOURCES, ...extra.sources };
const { home, root, at, imports, serves } = machineWith(people, sources);

// ---- The app's sample, as it ships ----

cpSync(join(APP, 'public/demo'), root, { recursive: true, filter: (f) => !['views', 'manifest.json'].includes(relative(join(APP, 'public/demo'), f).split(sep)[0]) });
let before = 115;
/** Each step a second after the last, all after the sample's own. */
const next = () => before--;
at(next(), 'profiles', 'add', 'demo');
at(next(), 'init', root);

// ---- What the tests need beyond it ----

for (const p of Object.values(extra.people)) at(next(), 'people', 'add', p.name, '--birth-date', p.born, ...p.args);

const noClaims = [{ resource_type: 'ExplanationOfBenefit', reason: 'the server does not give this app claims', code: 'forbidden' }];
imports(sources.samPlan, next(), [...sam.PLAN[1], ...extra.stay]);
imports(sources.jamiePlan, next(), extra.newborn);
imports(sources.jamiePeds, next(), extra.peds);
imports(sources.robinPlan, next(), [...robin.PLAN[2], ...extra.robinClaims]);
imports(sources.robinChart, next(), [...robin.CHART[2], ...extra.robinChart], noClaims);
imports(sources.robinNotes, next(), extra.robinNotes);
imports(sources.robinShared, next(), extra.robinShared);
for (const p of extra.papers) {
  const path = join(home, 'papers', 'more', p.file);
  put(path, p.bytes);
  at(next(), 'intake', '--person', people.robin.name, '--type', p.type, '--date', p.date, '--org', p.org, path);
}
for (const [name, files] of Object.entries(extra.images)) {
  for (const image of files) put(join(home, 'papers', name, image.file), image.bytes);
  at(next(), 'images', 'intake', '--person', people.robin.name, join(home, 'papers', name));
}

// Two patients of one sign-in, each with a load of its own, then both at one
// moment, so that nothing tells whose the last two visits are.
imports(sources.caseyFirst, next(), extra.caseyFirst);
imports(sources.caseySecond, next(), extra.caseySecond);
const both = next();
imports(sources.caseyFirst, both, extra.caseyFirstLater);
imports(sources.caseySecond, both, extra.caseySecondLater);
imports(sources.caseyNoName, next(), extra.caseyNoName);

// ---- What the household marked ----

const index = (who) => JSON.parse(readFileSync(join(root, people[who].name, 'index.json'), 'utf8'));
const one = (who, what, test) => {
  const found = [...index(who).records, ...index(who).documents].filter(test);
  if (found.length !== 1) throw new Error(`${found.length} of ${who}'s are ${what}`);
  return found[0].id;
};
const record = (kind, display, date) => (r) => r.kind === kind && r.display === display && (date === undefined || r.date === date);
const bill = (org, date) => (d) => d.doc_type === 'bill' && d.organization === org && d.date === date;
at(next(), 'private', 'mark', one('robin', 'the latex allergy', record('allergy', 'Latex')));
at(next(), 'private', 'mark', one('robin', 'the middle potassium result', record('result', 'Potassium', '2025-09-15')));
at(next(), 'bills', 'paid', one('sam', "the billing site's bill", bill('Example Billing', '2026-07-09')), '--on', '2026-08-20', '--amount', '120.00');
at(next(), 'bills', 'paid', one('robin', "the lab's bill", bill('Example Lab', '2026-10-28')), '--on', '2026-11-05', '--amount', '10.00');
at(next(), 'bills', 'paid', one('robin', "October's bill", bill('Example Health', '2026-10-01')), '--on', '2026-11-06', '--amount', '20.00');

// ---- Their notes: one of the same day and words for each, and one of Robin's about a document ----

for (const who of ['robin', 'sam', 'alex', 'jamie']) at(next(), 'note', 'add', people[who].name, 'A sample note for the next visit.', '--date', '2026-03-05', '--tag', 'sample');
at(next(), 'note', 'add', people.robin.name, 'A sample note about a paper.', '--date', '2026-11-19', '--tag', 'sample,paper', '--about', one('robin', "November's lab report", (d) => d.doc_type === 'lab_report' && d.date === '2026-11-18'));
at(next(), 'verify');

// One that does not read.
put(join(root, people.casey.name, 'marks.json'), '{"schema": "medrec-marks/v1",\n');

// ---- The folder as the tests read it ----

const list = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
  .filter((f) => f !== 'README.md' && !f.startsWith(`views${sep}`))
  .sort();
for (const f of list) {
  mkdirSync(dirname(join(OUT, f)), { recursive: true });
  copyFileSync(join(root, f), join(OUT, f));
}
console.log(`wrote ${list.length} files under ${OUT}`);
