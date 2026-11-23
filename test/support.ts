// Test helpers: a records folder on disk as the tools' FileSource.

import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Folder, ParsedCache, type FileSource } from '../src/records/folder';

export const DEMO = join(import.meta.dirname, 'fixtures/records');

export class LocalSource implements FileSource {
  reads = 0;
  /** Each path read, whole or in part, in order. */
  readPaths: string[] = [];
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
      const body = await readFile(join(this.root, path), 'utf8');
      this.readPaths.push(path);
      return body;
    } catch {
      return null;
    }
  }
  async bytes(path: string, start: number, end: number): Promise<Uint8Array | null> {
    let h;
    try {
      h = await open(join(this.root, path));
    } catch {
      return null;
    }
    try {
      this.reads++;
      this.readPaths.push(path);
      const b = new Uint8Array(Math.max(0, end - start));
      const { bytesRead } = await h.read(b, 0, b.length, start);
      return b.subarray(0, bytesRead);
    } finally {
      await h.close();
    }
  }
  async md5(paths: string[]): Promise<(string | null)[]> {
    return Promise.all(
      paths.map(async (p) => {
        try {
          return createHash('md5').update(await readFile(join(this.root, p))).digest('hex');
        } catch {
          return null;
        }
      }),
    );
  }
  async size(path: string): Promise<number | null> {
    try {
      const s = await stat(join(this.root, path));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }
}

export function folderAt(root: string, cache = new ParsedCache()): Folder {
  return new Folder(new LocalSource(root), cache, root);
}

/** KV in memory, with the slice of KVNamespace the OAuth provider uses. */
export class MemoryKV {
  data = new Map<string, { value: string; metadata?: unknown }>();
  async get(key: string, opts?: unknown) {
    const e = this.data.get(key);
    if (!e) return null;
    const type = typeof opts === 'string' ? opts : (opts as { type?: string } | undefined)?.type;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    this.data.set(key, { value, metadata: opts?.metadata });
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const done = start + limit >= keys.length;
    return { keys: page.map((name) => ({ name, metadata: this.data.get(name)?.metadata })), list_complete: done, ...(done ? {} : { cursor: String(start + limit) }) };
  }
}

/** D1 in memory: the audit's inserts, kept as rows. */
export class MemoryD1 {
  rows: unknown[][] = [];
  statements: string[] = [];
  prepare(sql: string) {
    this.statements.push(sql);
    const run = async (args: unknown[]) => {
      if (sql.startsWith('INSERT INTO audit')) this.rows.push(args);
      return { success: true };
    };
    return { bind: (...args: unknown[]) => ({ run: () => run(args) }), run: () => run([]) };
  }
  async exec(sql: string) {
    this.statements.push(sql);
    return { count: 1 };
  }
}
