// Where a call's CPU goes when it reads the records folder's own files whole
// (RawStore), measured on this thread in Node (the V8 workerd runs):
// decoding and parsing each file, and each tool's own work over parsed files.
//
//   npx vitest run --config bench/vitest.config.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { ParsedCache } from '../src/records/folder';
import { callTool } from '../src/records/tools';
import { folderAt } from '../test/support';
import { RawStore } from '../src/records/store';

const N = Number(process.env.N ?? 30);
const cpu = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};
async function each(f: () => unknown): Promise<number> {
  for (let i = 0; i < 3; i++) await f();
  const t0 = cpu();
  for (let i = 0; i < N; i++) await f();
  return (cpu() - t0) / N;
}

it('measures', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-cpu-'));
  const root = synth(join(scratch, 'r'));
  const rows: [string, number][] = [];
  const dec = new TextDecoder();
  for (const f of ['household.json', 'Sam Example/index.json', 'Sam Example/text.json', 'Alex Example/index.json']) {
    const bytes = readFileSync(join(root, f));
    rows.push([`decode ${f} (${(bytes.length / 1e6).toFixed(2)} MB)`, await each(() => dec.decode(bytes))]);
    const s = dec.decode(bytes);
    rows.push([`JSON.parse ${f}`, await each(() => JSON.parse(s))]);
  }
  const cache = new ParsedCache();
  const folder = folderAt(root, cache);
  const today = '2026-11-23';
  const call = (name: string, args: Record<string, unknown>) => () => callTool(name, args, { store: new RawStore(folder), today });
  const calls: [string, string, Record<string, unknown>][] = [
    ['summary, everyone', 'medrec_summary', {}],
    ['summary Sam', 'medrec_summary', { person: 'Sam' }],
    ['search "cholesterol"', 'medrec_search', { query: 'cholesterol' }],
    ['search "labs"', 'medrec_search', { query: 'labs' }],
    ['records results 200', 'medrec_records', { kind: 'results', limit: 200 }],
    ['records results Sam 25', 'medrec_records', { kind: 'results', person: 'Sam' }],
    ['records timeline Robin', 'medrec_records', { kind: 'timeline', person: 'Robin' }],
    ['records medications Sam', 'medrec_records', { kind: 'medications', person: 'Sam' }],
  ];
  for (const [label, name, args] of calls) rows.push([`warm ${label}`, await each(call(name, args))]);
  const docs = ((await call('medrec_records', { kind: 'documents', person: 'Sam', limit: 5 })()) as unknown as { structuredContent: { items: { id: string }[] } }).structuredContent.items;
  rows.push(['warm document 16,000 characters', await each(call('medrec_document', { id: docs[0]!.id }))]);
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(process.env.OUT ?? '/tmp/oyh-parts.md', `CPU ms on this thread, mean of ${N}:\n| Part | ms |\n|---|---:|\n${rows.map(([l, v]) => `| ${l} | ${v.toFixed(2)} |`).join('\n')}\n`);
});
