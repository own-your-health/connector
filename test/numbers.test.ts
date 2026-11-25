// Numbers as their files write them: medrec keeps a lab's 4.10, so a list, a
// search and `detailed` fields show 4.10 here too.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Folder, ParsedCache } from '../src/records/folder';
import type { Json } from '../src/records/model';
import { isExact, parseExact } from '../src/records/numbers';
import { RawStore } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { valueText } from '../src/records/views';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { DEMO, LocalSource, addDerived, folderAt } from './support';

const KEPT = ['4.0', '4.10', '0.90', '-1.0', '100.00', '0.0', '-0', '-0.0', '1e5', '1E-2', '1.50e+3', '12345678901234567890', '0.12345678901234567890', '-0.10'];
const PLAIN = ['0', '4', '-4', '10', '100', '4.1', '0.9', '5.37', '-2.5', '1000000', '9007199254740991'];

describe('numbers as their file writes them', () => {
  it('keeps one JSON.parse would change, and leaves the rest numbers', () => {
    for (const n of KEPT) {
      const v = (parseExact(`{"value":${n},"b":1}`) as { value: unknown }).value;
      expect(isExact(v) && v.rawJSON, n).toBe(n);
      expect(valueText(v as Json), n).toBe(n);
      expect(JSON.stringify({ v }), n).toBe(`{"v":${n}}`);
    }
    for (const n of PLAIN) expect((parseExact(`{"value":${n}}`) as { value: unknown }).value, n).toBe(Number(n));
    // Printed with spaces or on lines of their own, as index.json is.
    expect(JSON.stringify(parseExact('{\n  "value" : 4.0 ,\n  "unit": "x",\n  "n": 1.20\n}'))).toBe('{"value":4.0,"unit":"x","n":1.20}');
    expect(JSON.stringify(parseExact('{"a":{"b":[{"c":4.0},{"c":[{"d":5.50}]}]}}'))).toBe('{"a":{"b":[{"c":4.0},{"c":[{"d":5.50}]}]}}');
  });

  it('changes no string', () => {
    for (const s of ['4.0', 'a":4.0,', '":4.0,', 'k":4.0}', '"k":4.0,"', '\\":4.0,', '\\\\":4.0}', ': 4.0,', '"', '\\', '\n"x":1.0,', 'x\\"y":2.0,']) {
      for (const text of [JSON.stringify({ s }), JSON.stringify({ [s]: 1, z: s }), JSON.stringify([s, { s: [s] }]), JSON.stringify({ a: s, b: 2 }, null, 2)]) {
        expect(JSON.stringify(parseExact(text)), text).toBe(JSON.stringify(JSON.parse(text)));
      }
      // A key that ends as a string before a number is still a key, and its number is kept or plain, never a string.
      const keyed = `{${JSON.stringify(s)}:4.0,"t":${JSON.stringify(s)}}`;
      const v = parseExact(keyed) as Record<string, unknown>;
      expect(Number(isExact(v[s]) ? v[s].rawJSON : v[s]), keyed).toBe(4);
      if (s !== 't') expect(v.t, keyed).toBe(s);
    }
  });

  it('gives back any file it reads', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const strings = ['', 'a', 'a":4.0,', '\\', '"', '{"x":1.0}', 'é', '\u0001', ' : 2.50 ', 'mg/dL', '":'];
    const numbers = [...KEPT, ...PLAIN];
    const make = (depth: number): string => {
      const k = rnd(depth > 3 ? 3 : 5);
      if (k === 0) return JSON.stringify(strings[rnd(strings.length)]);
      if (k === 1) return numbers[rnd(numbers.length)]!;
      if (k === 2) return ['true', 'false', 'null'][rnd(3)]!;
      const n = rnd(4);
      // A number straight in an array is not a member's: only the plain ones come back as they were.
      if (k === 3) return `[${Array.from({ length: n }, () => (rnd(2) ? PLAIN[rnd(PLAIN.length)]! : `{"m":${make(depth + 1)}}`)).join(',')}]`;
      return `{${Array.from({ length: n }, (_, i) => `"k${i}":${make(depth + 1)}`).join(',')}}`;
    };
    for (let i = 0; i < 2000; i++) {
      const text = `{"top":${make(0)}}`;
      expect(JSON.stringify(parseExact(text))).toBe(text);
    }
  });

  it('refuses what is not JSON, as JSON.parse does', () => {
    for (const text of ['', '{', '{"a":4.0', '{"a":04.0,}', '{"a":4.}']) expect(() => parseExact(text), text).toThrow();
  });
});

describe('answers over them', () => {
  const POTASSIUM = 'r_potassiumolderaaaaaa';
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'oyh-numbers-'));
    cpSync(DEMO, root, { recursive: true });
    const at = join(root, 'Robin Example/index.json');
    // A fill's amounts, and a value with no unit, also as a source writes them.
    const index = JSON.parse(readFileSync(at, 'utf8')) as { records: { id: string; kind: string; fields: Record<string, unknown> }[] };
    const fill = index.records.find((r) => r.kind === 'medication')!;
    Object.assign(fill.fields, { source: 'dispense', quantity: 'QUANTITY', days_supply: 'DAYS' });
    const result = index.records.find((r) => r.kind === 'result' && r.id !== POTASSIUM)!;
    result.fields.value = 'VALUE';
    index.records.find((r) => r.id === POTASSIUM)!.fields.value = { value: 'POTASSIUM', unit: 'mmol/L' };
    const raw = (s: string) => s.replace('"QUANTITY"', '30.0').replace('"DAYS"', '90.50').replace('"VALUE"', '7.10').replace('"POTASSIUM"', '4.0');
    writeFileSync(at, raw(JSON.stringify(index, null, 2)));
    ids = { fill: fill.id, result: result.id };
    writeViewsAt(root);
    addDerived(root, 'records');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let ids: { fill: string; result: string };

  const stores = [
    ['files', () => new RawStore(folderAt(root, new ParsedCache()))],
    ['views', () => new ViewsStore(new Folder(new LocalSource(root), new ParsedCache(), root))],
  ] as const;
  it.each(stores)('from the %s are as the file writes the numbers', async (_over, store) => {
    const ask = async (args: Record<string, unknown>) => (await callTool('medrec_records', { person: 'Robin', limit: 200, ...args }, { store: store(), today: '2026-11-23' }))!;
    type Row = { id: string; value?: string; detail?: string };
    const row = (r: Awaited<ReturnType<typeof ask>>, id: string) => (r.structuredContent as { items: Row[] }).items.find((x) => x.id === id)!;
    const list = await ask({ kind: 'results' });
    expect(row(list, POTASSIUM).value).toBe('4.0');
    expect(row(list, ids.result).value).toBe('7.10');
    const detailed = await ask({ kind: 'results', response_format: 'detailed' });
    expect(row(detailed, POTASSIUM).value).toBe('4.0');
    expect(detailed.content[0]!.text).toContain('"value":{"value":4.0,"unit":"mmol/L"}');
    expect(JSON.stringify(detailed.structuredContent)).toBe(detailed.content[0]!.text);
    expect(detailed.content[0]!.text).toContain('"value":7.10');
    expect(row(await ask({ kind: 'medications' }), ids.fill).detail).toBe('dispensed 30.0, 90.50 days');
    expect(row(await ask({ kind: 'timeline' }), POTASSIUM).detail).toBe('4.0 mmol/L');
    const found = (await callTool('medrec_search', { query: '7.10', person: 'Robin' }, { store: store(), today: '2026-11-23' }))!;
    expect((found.structuredContent as { items: Row[] }).items.map((x) => x.id)).toContain(ids.result);
  });
});
