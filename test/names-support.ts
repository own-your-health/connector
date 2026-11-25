// A records folder on disk, its views, and what the tools answer from either.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RawStore } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName, type SlimSource, type ViewsIndex } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
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

/** Writes the folder's views, as src/views/write.ts makes them. */
export const writeViews = (root: string): void => void writeViewsAt(root);

/** Changes the source of every record the record views hold, as another writer's would differ; returns how many. */
export function editSources(root: string, edit: (s: SlimSource) => void): number {
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  let n = 0;
  for (const [pid, v] of Object.entries(index.people)) {
    for (const [view, sum] of Object.entries(v.files)) {
      if (!view.startsWith('records-')) continue;
      const records = JSON.parse(readFileSync(join(root, personDir(pid) + storedName(view, sum)), 'utf8')) as { provenance?: { source: SlimSource }[] }[];
      for (const r of records) {
        if (!r.provenance?.[0]) continue;
        edit(r.provenance[0].source);
        n++;
      }
      const text = JSON.stringify(records);
      const next = createHash('md5').update(text).digest('hex');
      writeFileSync(join(root, personDir(pid) + storedName(view, next)), text);
      v.files[view] = next;
    }
  }
  writeFileSync(at, JSON.stringify(index));
  return n;
}

/** What a tool answers about one person from the folder's own files, or from its views. */
export async function ask(root: string, from: 'files' | 'views', tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const folder = folderAt(root);
  const r = (await callTool(tool, args, { store: from === 'files' ? new RawStore(folder) : new ViewsStore(folder), today: '2026-11-24' }))!;
  if (r.isError) throw new Error(r.content[0]!.text);
  return r.structuredContent!;
}
