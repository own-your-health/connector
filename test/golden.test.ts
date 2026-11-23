// This connector answers every call in test/golden/calls.json as `medrec mcp`
// 0.5.0 did (scripts/golden.mjs recorded it): the same structured result, the
// same text to the character, the same errors.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synth } from '../scripts/synth.mjs';
import { ParsedCache } from '../src/records/folder';
import { TOOLS, callTool, instructions, unknownTool } from '../src/records/tools';
import { DEMO, folderAt } from './support';

interface Golden {
  medrec_version: string;
  as_of: string;
  instructions: string;
  tools: unknown[];
  results: { folder: 'demo' | 'large'; name: string; arguments?: Record<string, unknown>; answer: { result?: Record<string, unknown>; error?: { code: number; message: string } } }[];
}

const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'golden/medrec-0.5.0.json'), 'utf8')) as Golden;
const roots: Record<string, string> = { demo: DEMO };
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'oyh-test-'));
  roots.large = synth(join(scratch, 'large'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe(`parity with medrec ${golden.medrec_version}`, () => {
  it('lists the same tools', () => {
    expect(TOOLS).toEqual(golden.tools);
  });

  it("carries medrec's own instructions", () => {
    const tail = golden.instructions.slice(golden.instructions.indexOf('medrec keeps'));
    expect(instructions().endsWith(tail)).toBe(true);
  });

  const cache = new ParsedCache();
  golden.results.forEach((g, i) => {
    const label = `${i} ${g.folder} ${g.name} ${JSON.stringify(g.arguments ?? null)}`.slice(0, 160);
    it(label, async () => {
      const ours = await callTool(g.name, g.arguments, { folder: folderAt(roots[g.folder]!, cache), today: golden.as_of });
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
      expect(ours!.isError).toBe(want.isError ?? false);
      expect(ours!.content).toEqual(want.content);
      expect(ours!.structuredContent).toEqual(want.structuredContent);
    });
  });
});
