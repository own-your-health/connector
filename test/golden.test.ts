// This connector answers every call in test/golden/calls.json as `medrec mcp`
// did (scripts/golden.mjs recorded it): the same structured result, the same
// text to the character, the same errors. Events come only from the
// views (medrec groups them; test/fixtures/events holds what it wrote), so
// read from the files they are refused instead.

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labelsFolder } from '../scripts/labels-folder.mjs';
import { OWN, filesOf, ownFolder, type Own } from '../scripts/own-folder.mjs';
import { synth } from '../scripts/synth.mjs';
import { ParsedCache } from '../src/records/folder';
import { parseExact } from '../src/records/numbers';
import { usDay } from '../src/records/schedule';
import { TOOLS, callTool, instructions, unknownTool } from '../src/records/tools';
import { DEMO, RawWithDerived, addCodeNames, addDerived, folderAt } from './support';
import { RawStore, type Store } from '../src/records/store';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';

type Name = 'demo' | 'large' | 'labels' | Own;

const CVX = 'http://hl7.org/fhir/sid/cvx';

/**
 * medrec's answer as its views can give it. An answer that names the person
 * leaves nothing out of a claim, and medrec lists every vaccine of its lines
 * there. Its views make the vaccines claims tell of without the lines
 * private.json leaves out of an open claim, and name one whose line has no
 * name by its claim as shown without them (medrec's data contract, "Records"
 * and "Summary"), so an answer from them lists neither.
 */
function asTheViewsSay(g: Golden['results'][number], want: Record<string, unknown>): Record<string, unknown> {
  if (g.name === 'medrec_document') return documentAsTheViewsSay(g, want);
  const of = g.arguments ?? {};
  if (typeof of.person !== 'string' || !(g.name === 'medrec_summary' || of.kind === 'immunizations' || of.kind === 'schedule') || !OWN.includes(g.folder as Own)) return want;
  const { parts, records } = heldParts(g.folder as Own);
  if (of.kind === 'schedule') return scheduleAsTheViewsSay(want, parts, records);
  /** What the views make of an item from a claim with a part: null where they leave it out. */
  const asShown = (item: Record<string, unknown>, name: string): Record<string, unknown> | null => {
    const part = parts[item.id as string];
    const claim = records.find((r) => r.id === item.id);
    if (item.detail !== 'from a claim' || !part || !claim) return item;
    const at = (claim.fields?.items ?? []).findIndex((l) => (l.codes ?? [l.service ?? {}]).some((c) => c.system === CVX) && (l.serviced ?? claim.date)?.slice(0, 10) === item.date);
    if (part.lines?.includes(at)) return null;
    const line = claim.fields!.items![at]!;
    return line.service?.display?.trim() ? item : { ...item, [name]: part.display };
  };
  let changed = false;
  const shown = (items: Record<string, unknown>[], name: string) =>
    items.flatMap((i) => {
      const x = asShown(i, name);
      changed ||= x !== i;
      return x === null ? [] : [x];
    });
  const s = structuredClone(want.structuredContent) as Record<string, any>;
  if (g.name === 'medrec_summary') {
    const sec = s.summary.sections.find((x: { section: string }) => x.section === 'immunizations');
    sec.items = shown(sec.items, 'name');
  } else {
    s.items = shown(s.items, 'title');
    s.returned = s.items.length;
  }
  return changed ? { ...want, content: [{ type: 'text', text: JSON.stringify(s) }], structuredContent: s } : want;
}
interface ClaimRecord {
  id: string;
  date?: string;
  display?: string;
  kind?: string;
  fields?: { items?: { serviced?: string; service?: { system?: string; display?: string }; codes?: { system?: string }[] }[] };
}
type Parts = Record<string, { display?: string; lines?: number[] }>;
/** The parts of claims the folder's views hold back (private.json), and the records of its index. */
function heldParts(folder: Own): { parts: Parts; records: ClaimRecord[] } {
  const dir = join(import.meta.dirname, 'fixtures', folder, 'views');
  const pid = readdirSync(dir).find((f) => f.startsWith('p_'))!;
  const priv = readdirSync(join(dir, pid)).find((f) => f.startsWith('private.'))!;
  return {
    parts: JSON.parse(readFileSync(join(dir, pid, priv), 'utf8')).parts as Parts,
    records: JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', filesOf(folder), 'index.json'), 'utf8')).records as ClaimRecord[],
  };
}
/**
 * medrec's schedule answer as its views can give it. medrec writes the views'
 * schedule.json with what private.json holds back (its data contract,
 * "Schedule"): no vaccine of a claim line it holds back, and a claim's name
 * without its held lines. `medrec mcp` naming the person reads the whole index.
 * Each dose on file is one of an item's lines, joined by "; ".
 */
function scheduleAsTheViewsSay(want: Record<string, unknown>, parts: Parts, records: ClaimRecord[]): Record<string, unknown> {
  const s = structuredClone(want.structuredContent) as { items?: { title: string; detail: string }[]; returned?: number } | undefined;
  if (!s?.items) return want;
  /** Each claim line with a CVX code: the words a dose on file of it begins with, and what the views make of them (null where they leave it out). */
  const lines = records.flatMap((r) => {
    const part = parts[r.id];
    if (r.kind !== 'claim' || !part) return [];
    return (r.fields?.items ?? []).flatMap((l, i) => {
      if (!(l.codes ?? [l.service ?? {}]).some((c) => c.system === CVX)) return [];
      const day = usDay((l.serviced ?? r.date ?? '').slice(0, 10));
      const own = l.service?.display?.trim();
      const said = `${day}, ${own || r.display} (CVX `;
      return [{ said, shown: part.lines?.includes(i) ? null : `${day}, ${own || part.display} (CVX ` }];
    });
  });
  let changed = false;
  const items = s.items.flatMap((item) => {
    const kept = item.detail.split('; ').flatMap((x) => {
      const at = x.startsWith('On file: ') ? 'On file: '.length : item.title === 'On file, in no group' ? 0 : -1;
      const line = at < 0 || !x.includes('), from a claim') ? undefined : lines.find((l) => x.startsWith(l.said, at));
      if (!line) return [x];
      changed = true;
      return line.shown === null ? [] : [x.slice(0, at) + line.shown + x.slice(at + line.said.length)];
    });
    return kept.length === 0 ? [] : [{ ...item, detail: kept.join('; ') }];
  });
  if (!changed) return want;
  const shown = { ...s, items, ...(s.returned === undefined ? {} : { returned: items.length }) };
  return { ...want, content: [{ type: 'text', text: JSON.stringify(shown) }], structuredContent: shown };
}
/**
 * medrec's document answer as its views can give it. An answer that names the
 * person gives every field of the paper, from its index. Its views have none
 * private by what it says (documents.json, medrec's data contract "Fields of a
 * paper"), so an answer from them lacks those lines.
 */
function documentAsTheViewsSay(g: Golden['results'][number], want: Record<string, unknown>): Record<string, unknown> {
  const s = structuredClone(want.structuredContent) as { id?: string; labeled?: string[] } | undefined;
  if (typeof g.arguments?.person !== 'string' || !OWN.includes(g.folder as Own) || !s?.labeled) return want;
  type Fields = { follow_up?: { lines: unknown }[]; drugs?: { lines: unknown }[] };
  const filed = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', filesOf(g.folder as Own), 'index.json'), 'utf8')).documents as { id: string; fields?: Fields }[]).find((d) => d.id === s.id)?.fields;
  const dir = join(import.meta.dirname, 'fixtures', g.folder, 'views');
  const pid = readdirSync(dir).find((f) => f.startsWith('p_'))!;
  const docs = readdirSync(join(dir, pid)).find((f) => f.startsWith('documents.'))!;
  const viewed = (JSON.parse(readFileSync(join(dir, pid, docs), 'utf8')) as { id: string; fields?: Fields }[]).find((d) => d.id === s.id)?.fields;
  const has = (list: { lines: unknown }[] | undefined, x: { lines: unknown }) => (list ?? []).some((y) => JSON.stringify(y.lines) === JSON.stringify(x.lines));
  // The lines come in order: the amount due, then each follow-up, then each drug.
  const at = /^(Amount due|Due by) /.test(s.labeled[0]!) ? 1 : 0;
  const follow = filed?.follow_up ?? [];
  const gone = new Set([...follow.flatMap((x, i) => (has(viewed?.follow_up, x) ? [] : [at + i])), ...(filed?.drugs ?? []).flatMap((x, i) => (has(viewed?.drugs, x) ? [] : [at + follow.length + i]))]);
  if (gone.size === 0) return want;
  const labeled = s.labeled.filter((_, i) => !gone.has(i));
  const shown = { ...s, labeled: labeled.length > 0 ? labeled : undefined };
  if (!shown.labeled) delete shown.labeled;
  return { ...want, content: [{ type: 'text', text: JSON.stringify(shown) }], structuredContent: shown };
}
/** The folder's name among the fixtures. */
const fixtures = (f: Exclude<Name, Own>) => (f === 'demo' ? 'records' : f);

interface Golden {
  medrec_version: string;
  as_of: string;
  instructions: string;
  tools: unknown[];
  results: { folder: Name; name: string; arguments?: Record<string, unknown>; answer: { result?: Record<string, unknown>; error?: { code: number; message: string } } }[];
}

// Numbers as medrec printed them, as the tools hold them (src/records/numbers.ts).
const golden = parseExact(readFileSync(join(import.meta.dirname, 'golden/medrec.json'), 'utf8')) as Golden;
const roots: Record<string, string> = { demo: DEMO };
/** The same folders with views written beside their files, as medrec writes them. */
const viewRoots: Record<string, string> = {};
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'oyh-test-'));
  roots.large = synth(join(scratch, 'large'));
  roots.labels = labelsFolder(join(scratch, 'labels'));
  // Only medrec's own views leave out what is entered in error; these are all of them.
  for (const name of OWN) viewRoots[name] = ownFolder(name, join(scratch, name), { views: true });
  for (const name of ['demo', 'large', 'labels'] as const) {
    viewRoots[name] = join(scratch, `${name}-views`);
    cpSync(roots[name]!, viewRoots[name]!, { recursive: true });
    // Another writer's views, held to the same answers (docs/views.md).
    const writer = process.env.VIEWS_WRITER;
    if (writer) {
      execSync(writer.replaceAll('{folder}', JSON.stringify(viewRoots[name]!)), { stdio: 'inherit' });
      // The writer has no published code table, so its own views hold no plain names.
      if (name !== 'labels') addCodeNames(viewRoots[name]!, name === 'demo' ? 'records' : name);
    } else {
      writeViewsAt(viewRoots[name]!);
      addDerived(viewRoots[name]!, fixtures(name));
    }
  }
}, 120_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe(`parity with medrec ${golden.medrec_version}`, () => {
  it('lists the same tools', () => {
    expect(TOOLS).toEqual(golden.tools);
  });

  it("carries medrec's own instructions", () => {
    const tail = golden.instructions.slice(golden.instructions.indexOf('medrec keeps'));
    expect(instructions().endsWith(tail)).toBe(true);
  });

  const stores: [string, (folder: Name) => Store][] = [
    ['files', (f) => new RawWithDerived(folderAt(roots[f]!, rawCache), fixtures(f as Exclude<Name, Own>))],
    ['views', (f) => new ViewsStore(folderAt(viewRoots[f]!, viewsCache))],
  ];
  const rawCache = new ParsedCache();
  const viewsCache = new ParsedCache();
  for (const [over, store] of stores) {
    describe(`from the ${over}`, () => {
      golden.results.forEach((g, i) => {
        if (over === 'files' && OWN.includes(g.folder as Own)) return;
        const label = `${i} ${g.folder} ${g.name} ${JSON.stringify(g.arguments ?? null)}`.slice(0, 160);
        it(label, async () => {
          const ours = await callTool(g.name, g.arguments, { store: store(g.folder), today: golden.as_of });
          if (g.answer.error?.code === -32601) {
            // medrec's stdio transport refuses `arguments` that are not an object
            // before any tool sees them; over HTTP the MCP SDK does the same. The
            // tool layer, called anyway, refuses them as pk-cli-mcp's does.
            expect(ours?.content[0]?.text).toMatch(/^usage: arguments must be a JSON object, not /);
            return;
          }
          if (g.answer.error) {
            expect(ours).toBeNull();
            expect(g.answer.error).toEqual({ code: -32602, message: unknownTool(g.name) });
            return;
          }
          const want = over === 'views' ? asTheViewsSay(g, g.answer.result!) : g.answer.result!;
          expect(ours).not.toBeNull();
          if (over === 'files' && g.name === 'medrec_records' && g.arguments?.kind === 'events' && JSON.stringify(ours!.content) !== JSON.stringify(want.content)) {
            expect(ours!.isError).toBe(true);
            expect(ours!.content[0]!.text).toMatch(/has not prepared .+'s events for assistants/);
            return;
          }
          expect(ours!.isError).toBe(want.isError ?? false);
          expect(ours!.content).toEqual(want.content);
          expect(ours!.structuredContent).toEqual(want.structuredContent);
        });
      });
    });
  }
});
