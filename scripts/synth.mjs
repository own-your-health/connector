#!/usr/bin/env node
// A large synthetic records folder, the same bytes on every run: the demo
// folder (test/fixtures/records) grown to a size chosen to be on the heavy
// side for a family (years of portal imports and scanned documents), for
// the CPU bench and for the goldens that need long texts and long lists.
// Every name, value, size and text is invented.
//
//   node scripts/synth.mjs <out-dir>
//
// Sizes, as compact JSON: 2.5 MB of index and 3 MB of text for each adult,
// 0.5 MB of each for the child.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = join(ROOT, 'test/fixtures/records');

export const TARGETS = {
  'Robin Example': { index: 2_500_000, text: 3_000_000 },
  'Sam Example': { index: 2_500_000, text: 3_000_000 },
  'Alex Example': { index: 500_000, text: 500_000 },
};

// mulberry32: small, seeded, and the same in every Node.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// An id that ends in "key" reads as an API key to a secret scanner: another is drawn.
const id = (r, prefix) => {
  for (;;) {
    const x = Array.from({ length: 20 }, () => B32[Math.floor(r() * 32)]).join('');
    if (!x.endsWith('key')) return prefix + x;
  }
};
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

function day(r, from = 2015, to = 2026) {
  const y = from + Math.floor(r() * (to - from + 1));
  const m = 1 + Math.floor(r() * (y === 2026 ? 11 : 12));
  const d = 1 + Math.floor(r() * 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const WORDS = (
  'patient seen today for follow up of blood pressure and cholesterol results reviewed with the patient ' +
  'plan continue current medication recheck labs in three months diet and exercise discussed questions answered ' +
  'vital signs within normal limits heart regular rate and rhythm lungs clear abdomen soft non tender ' +
  'hemoglobin a1c glucose fasting cholesterol tests ldl hdl triglycerides creatinine potassium sodium thyroid ' +
  'impression assessment history of present illness review of systems negative except as noted medications reconciled ' +
  'café naïve résumé São Paulo Zürich größe 🩺 💊 血压 検査 — “quoted” ‘text’ … ½ µg/mL ±'
).split(' ');

function text(r, chars) {
  const parts = [];
  let n = 0;
  let line = 0;
  while (n < chars) {
    const w = pick(r, WORDS);
    parts.push(w);
    n += w.length + 1;
    line += w.length + 1;
    if (line > 70 + Math.floor(r() * 20)) {
      // Page breaks as pdftotext writes them, about every 3,000 characters.
      parts.push(r() < 0.04 ? '\f' : '\n');
      line = 0;
    } else parts.push(' ');
  }
  // By code points: a cut through an emoji would leave half of it, which no medrec file holds.
  return Array.from(parts.join('')).slice(0, chars).join('');
}

const UNITS = ['mg/dL', 'mmol/L', '%', 'g/dL', 'mIU/L', 'U/L', 'µg/mL'];
const TESTS = [
  ['4548-4', 'Hemoglobin A1c'],
  ['2345-7', 'Glucose'],
  ['13457-7', 'LDL cholesterol'],
  ['2085-9', 'HDL cholesterol'],
  ['2571-8', 'Triglycerides'],
  ['2160-0', 'Creatinine'],
  ['2823-3', 'Potassium'],
  ['2951-2', 'Sodium'],
  ['3016-3', 'TSH'],
  ['718-7', 'Hemoglobin'],
];

function grow(person, idx, txt, target, r) {
  const base = idx.records;
  const docs = idx.documents;
  const json = () => Buffer.byteLength(JSON.stringify(idx));
  // Copies of the demo's records with new ids, dates and values, until the index reaches its size.
  let i = 0;
  while (json() < target.index) {
    for (let k = 0; k < 20; k++, i++) {
      const src = base[i % base.length];
      const rec = structuredClone(src);
      rec.id = id(r, 'r_');
      rec.date = day(r);
      rec.key = `${rec.kind}|synthetic|${rec.id}`;
      if (rec.fields) rec.fields.when = rec.date;
      if (rec.kind === 'result') {
        const [code, name] = pick(r, TESTS);
        rec.code = { system: 'http://loinc.org', code, display: name };
        rec.display = name;
        rec.fields.value = { value: Math.round(r() * 3000) / 10, unit: pick(r, UNITS), system: 'http://unitsofmeasure.org' };
        rec.fields.reference_range = `${Math.round(r() * 50)}-${50 + Math.round(r() * 150)}`;
        if (r() < 0.2) rec.fields.interpretation = pick(r, ['High', 'Low', 'Abnormal']);
        else delete rec.fields.interpretation;
      }
      if (rec.kind === 'medication' || rec.kind === 'condition') rec.status = pick(r, ['active', 'active', 'completed', 'stopped', 'resolved']);
      idx.records.push(rec);
    }
  }
  // Documents with long texts, until the text file reaches its size.
  const bytes = (t) => Buffer.byteLength(JSON.stringify(t));
  let total = bytes(txt);
  let d = 0;
  while (total < target.text) {
    const src = docs[d++ % docs.length];
    const doc = structuredClone(src);
    doc.id = id(r, 'd_');
    doc.date = day(r);
    doc.path = `${person}/Synthetic/${doc.date}_${doc.id}.pdf`;
    delete doc.same_statement_as;
    const n = Math.max(200, Math.min(Math.floor((target.text - total) * 0.9), 2_000 + Math.floor(r() * 60_000)));
    const t = text(r, n);
    doc.text = { chars: [...t].length, engines: ['synthetic'] };
    txt.texts[doc.id] = t;
    idx.documents.push(doc);
    total = bytes(txt);
  }
}

// Claims in medrec 0.5.0's shape (docs/data-contract.md, "claim"), dated in
// 2014 where nothing else is, one for each way a claim's detail line and the
// member's share can come out. With them a report and a result, for the
// lab queries ("labs", "blood tests") that find records by kind.
const usd = (amount) => ({ amount, currency: 'USD' });
const SHAPED = [
  ['Office visit and labs', { billed: usd('240.00'), allowed: usd('150.00'), plan_paid: usd('120.00'), you_owe: usd('30.00') }, ['visit', 'lab']],
  ['Annual physical', { billed: usd('310.00'), deductible: usd('50.00'), copay: usd('25.00') }, ['visit']],
  ['Cholesterol tests', { copay: usd('15.00') }, ['lab']],
  ['Travel clinic', { billed: usd('90.00'), deductible: usd('20.00'), coinsurance: { amount: '5.00', currency: 'EUR' } }, ['visit']],
  ['Blood draw', { plan_paid: usd('12.00'), deductible: usd('abc'), copay: usd('3.00') }, ['lab']],
  ['Hemoglobin A1c', { billed: usd('44.00'), coinsurance: { amount: 12.5, currency: 'USD' }, copay: usd('2.00') }, ['lab']],
  ['Thyroid panel', { deductible: usd('12.3456'), copay: usd('0.0044') }, ['lab']],
  ['Chemistry tests', { deductible: usd('1.0001'), not_covered: usd('2') }, ['lab']],
  ['Courtesy discount', { discount: usd('10.00') }, ['other']],
  ['Older claim shape', {}, ['visit']],
  ['Owes nothing listed', { billed: usd('60.00'), you_owe: null }, ['visit']],
  ['Plain words', { billed: 'see statement', plan_paid: usd('0.00') }, ['visit']],
  ['Refund', { deductible: usd('-5.00'), copay: usd('2.5') }, ['visit']],
  ['No currency', { copay: { amount: '1' }, deductible: { amount: '2' } }, ['facility']],
  ['One currency missing', { copay: { amount: '1' }, deductible: usd('2.00') }, ['facility']],
  ['Five decimals', { deductible: usd('1.23456'), copay: usd('1.00') }, ['visit']],
  ['Bare points', { deductible: usd('.5'), copay: usd('1.') }, ['pharmacy']],
];

function shapedClaims(template, r) {
  return SHAPED.map(([name, amounts, categories], i) => {
    const rec = structuredClone(template);
    rec.id = id(r, 'r_');
    rec.date = `2014-01-${String(i + 1).padStart(2, '0')}`;
    rec.key = `claim|synthetic|${rec.id}`;
    rec.display = `${name} · Example Health`;
    rec.fields.when = rec.date;
    rec.fields.category = categories.length > 1 ? 'mixed' : categories[0];
    rec.fields.amounts = amounts;
    rec.fields.items = categories.map((category, n) => ({ sequence: n + 1, category, serviced: rec.date }));
    return rec;
  });
}

function labRecords(result, r) {
  const report = structuredClone(result);
  report.id = id(r, 'r_');
  report.kind = 'report';
  report.date = '2014-01-20';
  report.key = `report|synthetic|${report.id}`;
  report.display = 'Chemistry tests';
  report.status = 'final';
  report.fields = { when: report.date };
  const res = structuredClone(result);
  res.id = id(r, 'r_');
  res.date = '2014-01-21';
  res.key = `result|synthetic|${res.id}`;
  res.fields = { ...res.fields, when: res.date };
  return [report, res];
}

export function synth(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(DEMO, out, { recursive: true });
  const r = rng(20261123);
  for (const [person, target] of Object.entries(TARGETS)) {
    const ip = join(out, person, 'index.json');
    const tp = join(out, person, 'text.json');
    const idx = JSON.parse(readFileSync(ip, 'utf8'));
    const txt = JSON.parse(readFileSync(tp, 'utf8'));
    // Alex's demo index is empty: lend it Robin's records to copy.
    if (idx.records.length === 0 || idx.documents.length === 0) {
      const robin = JSON.parse(readFileSync(join(DEMO, 'Robin Example', 'index.json'), 'utf8'));
      if (idx.records.length === 0) idx.records = robin.records.map((x) => ({ ...structuredClone(x), id: id(r, 'r_') }));
      if (idx.documents.length === 0) idx.documents = robin.documents.slice(0, 3).map((x) => ({ ...structuredClone(x), id: id(r, 'd_'), path: x.path.replace('Robin Example', person) }));
    }
    grow(person, idx, txt, target, r);
    if (person !== 'Alex Example') {
      const robin = JSON.parse(readFileSync(join(DEMO, 'Robin Example', 'index.json'), 'utf8'));
      idx.records.push(...shapedClaims(robin.records.find((x) => x.kind === 'claim'), r), ...labRecords(robin.records.find((x) => x.kind === 'result'), r));
    }
    writeFileSync(ip, JSON.stringify(idx));
    writeFileSync(tp, JSON.stringify(txt));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/synth.mjs <out-dir>');
    process.exit(2);
  }
  synth(out);
  for (const person of Object.keys(TARGETS)) {
    const size = (f) => readFileSync(join(out, person, f)).length;
    console.log(`${person}: index ${(size('index.json') / 1e6).toFixed(2)} MB, text ${(size('text.json') / 1e6).toFixed(2)} MB`);
  }
}
