// Test helpers: a records folder on disk as the tools' FileSource.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Folder, ParsedCache, type FileSource } from '../src/records/folder';
import { VIEWS_INDEX, personDir, storedName, type ViewsIndex } from '../src/views/format';

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

/**
 * Gives views this connector wrote what medrec 0.9.0 adds for events: each
 * person's events.json from `eventsDir` (medrec-built, `<person id>.json`),
 * stored under its content-addressed name and listed in `files`, and the
 * `overrides` and `linked` MD5s it was made from. `linked` follows medrec's
 * own rule: a person with a birth date and their guardians, both ways.
 */
export function addEvents(root: string, eventsDir: string): void {
  const md5 = (path: string) => (existsSync(path) ? createHash('md5').update(readFileSync(path)).digest('hex') : null);
  const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; folder: string; birth_date?: string | null; guardians?: string[] }[] };
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  for (const p of h.people) {
    const v = index.people[p.id];
    const file = join(eventsDir, `${p.id}.json`);
    if (!v || !existsSync(file)) continue;
    const body = readFileSync(file);
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(p.id) + storedName('events.json', sum)), body);
    v.files['events.json'] = sum;
    v.overrides = md5(join(root, p.folder, 'overrides.json'));
    const linked = h.people.filter((q) => q.id !== p.id && ((p.birth_date && p.guardians?.includes(q.id)) || (q.birth_date && q.guardians?.includes(p.id))));
    v.linked = Object.fromEntries(linked.map((q) => [q.id, { index: md5(join(root, q.folder, 'index.json')), text: md5(join(root, q.folder, 'text.json')) }]));
  }
  writeFileSync(at, JSON.stringify(index));
}
