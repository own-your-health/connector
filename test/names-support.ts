// A records folder on disk, its views, and what the tools answer from either.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RawStore } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

/** Writes household.json, and each person's index.json and text.json by their folder's name. */
export function writeFolder(root: string, household: object, people: Record<string, { index: object; text?: object }>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'household.json'), JSON.stringify(household));
  for (const [folder, p] of Object.entries(people)) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'index.json'), JSON.stringify(p.index));
    if (p.text) writeFileSync(join(root, folder, 'text.json'), JSON.stringify(p.text));
  }
}

/** What a tool answers about one person from the folder's own files, or from its views. */
export async function ask(root: string, from: 'files' | 'views', tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const folder = folderAt(root);
  const r = (await callTool(tool, args, { store: from === 'files' ? new RawStore(folder) : new ViewsStore(folder), today: '2026-11-24' }))!;
  if (r.isError) throw new Error(r.content[0]!.text);
  return r.structuredContent!;
}
