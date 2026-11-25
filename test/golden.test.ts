// This connector answers every call in test/golden/calls.json as `medrec mcp`
// did (scripts/golden.mjs recorded it): the same structured result, the same
// text to the character, the same errors. Events come only from the
// views (medrec groups them; test/fixtures/events holds what it wrote), so
// read from the files they are refused instead.

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labelsFolder } from '../scripts/labels-folder.mjs';
import { OWN, ownFolder, type Own } from '../scripts/own-folder.mjs';
import { synth } from '../scripts/synth.mjs';
import { ParsedCache } from '../src/records/folder';
import { parseExact } from '../src/records/numbers';
import { TOOLS, callTool, instructions, unknownTool } from '../src/records/tools';
import { DEMO, RawWithDerived, addCodeNames, addDerived, folderAt } from './support';
import { RawStore, type Store } from '../src/records/store';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';

type Name = 'demo' | 'large' | 'labels' | Own;
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
const golden = parseExact(readFileSync(join(import.meta.dirname, 'golden/medrec-0.9.9.json'), 'utf8')) as Golden;
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

/**
 * A recorded answer as this connector gives it: medrec 0.9.8 lists an open
 * event's private members in an answer that names no person, and medrec 0.9.9
 * counts them, as this connector does.
 */
function counted({ folder, arguments: a, answer }: (typeof golden.results)[number]): Record<string, unknown> {
  const want = answer.result!;
  if (golden.medrec_version !== '0.9.8' || folder !== 'labels' || a?.kind !== 'events' || a.response_format !== 'detailed' || a.person !== undefined) return want;
  const listed = (want.content as { text: string }[])[0]!.text;
  const text = listed.replace(/,\{"document":"d_counselingaaaaaaaaaa"[^}]*\}\]/, '],"private_members":1');
  expect(text).not.toBe(listed);
  return { ...want, content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}

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
          const want = counted(g);
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
