// Test helpers: a records folder on disk as the tools' FileSource.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Folder, ParsedCache, type FileSource } from '../src/records/folder';

export const DEMO = join(import.meta.dirname, 'fixtures/records');

export class LocalSource implements FileSource {
  reads = 0;
  constructor(private readonly root: string) {}

  async version(path: string): Promise<string | null> {
    try {
      const s = await stat(join(this.root, path));
      return s.isFile() ? `${s.mtimeMs}:${s.size}` : null;
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<string | null> {
    try {
      this.reads++;
      return await readFile(join(this.root, path), 'utf8');
    } catch {
      return null;
    }
  }
}

export function folderAt(root: string, cache = new ParsedCache()): Folder {
  return new Folder(new LocalSource(root), cache, root);
}
