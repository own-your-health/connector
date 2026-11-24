// This connector answers every call in test/golden/calls.json as `medrec mcp`
// 0.9.0 did (scripts/golden.mjs recorded it): the same structured result, the
// same text to the character, the same errors. Events come only from the
// views (medrec groups them; test/fixtures/events holds what it wrote), so
// read from the files they are refused instead.

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { ParsedCache } from '../src/records/folder';
import { TOOLS, callTool, instructions, unknownTool } from '../src/records/tools';
import { DEMO, RawWithDerived, addDerived, folderAt } from './support';
import { RawStore, type Store } from '../src/records/store';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';

interface Golden {
  medrec_version: string;
  as_of: string;
  instructions: string;
  tools: unknown[];
  results: { folder: 'demo' | 'large'; name: string; arguments?: Record<string, unknown>; answer: { result?: Record<string, unknown>; error?: { code: number; message: string } } }[];
}

const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'golden/medrec-0.9.3.json'), 'utf8')) as Golden;
const roots: Record<string, string> = { demo: DEMO };
/** The same folders with views written beside their files, as medrec writes them. */
const viewRoots: Record<string, string> = {};
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'oyh-test-'));
  roots.large = synth(join(scratch, 'large'));
  for (const name of ['demo', 'large']) {
    viewRoots[name] = join(scratch, `${name}-views`);
    cpSync(roots[name]!, viewRoots[name]!, { recursive: true });
    // Another writer's views, held to the same answers (docs/views.md).
    const writer = process.env.VIEWS_WRITER;
    if (writer) execSync(writer.replaceAll('{folder}', JSON.stringify(viewRoots[name]!)), { stdio: 'inherit' });
    else {
      writeViewsAt(viewRoots[name]!);
      addDerived(viewRoots[name]!, name === 'demo' ? 'records' : 'large');
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

  const stores: [string, (folder: 'demo' | 'large') => Store][] = [
    ['files', (f) => new RawWithDerived(folderAt(roots[f]!, rawCache), f === 'demo' ? 'records' : 'large')],
    ['views', (f) => new ViewsStore(folderAt(viewRoots[f]!, viewsCache))],
  ];
  const rawCache = new ParsedCache();
  const viewsCache = new ParsedCache();
  for (const [over, store] of stores) {
    describe(`from the ${over}`, () => {
      golden.results.forEach((g, i) => {
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
          const want = g.answer.result!;
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
