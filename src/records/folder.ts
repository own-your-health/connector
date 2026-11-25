// The records folder as the tools read it: household.json, and each person's
// index.json, text.json and notes.md (medrec-cli docs/data-contract.md).
//
// Every call lists the folder again, so an answer reflects the folder as it
// is now. A file's parsed contents are kept in this isolate's memory only,
// keyed by the file's own version (Drive id, modified time and size), and
// only while that version is still what the folder holds. Nothing is written
// anywhere: no KV, no cache API, no disk.

import { FORMAT, type Household, type Note, type Person, type PersonIndex, type PersonText } from './model';
import { parseNotes } from './notes';
import { parseExact } from './numbers';
import { ToolError } from '../mcp/errors';

/** Where the folder's files come from: Drive in the Worker, a directory in tests. */
export interface FileSource {
  /** The file's version (changes whenever its contents do), or null when it is missing. */
  version(path: string): Promise<string | null>;
  /** The file's text, or null when it is missing. */
  read(path: string): Promise<string | null>;
  /** Bytes `start` to `end` (exclusive) of the file, or null when it is missing. */
  bytes(path: string, start: number, end: number): Promise<Uint8Array | null>;
  /** The MD5 (hex) of each file's contents, null for one that is missing: in one request where the source can. */
  md5(paths: string[]): Promise<(string | null)[]>;
  /** The file's size in bytes, or null when it is missing. */
  size(path: string): Promise<number | null>;
  /** Learn every file in `dirs` and each of `files`, with MD5s, in as few requests as the source can. */
  survey?(dirs: string[], files: string[]): Promise<void>;
  /** How many more requests this call may make, where the source is limited. */
  remaining?(): number;
}

interface Entry {
  version: string;
  value: unknown;
  /** Characters of the text it was parsed from, for the cache's bound. */
  size: number;
}

/**
 * Parsed files by path, for as long as this isolate lives. Bounded in
 * characters so a large household cannot hold the isolate's memory: the
 * oldest entry goes first.
 */
export class ParsedCache {
  private entries = new Map<string, Entry>();
  private total = 0;

  constructor(private readonly maxChars = 24_000_000) {}

  get(key: string, version: string): unknown {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.version !== version) {
      this.drop(key);
      return undefined;
    }
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, version: string, value: unknown, size: number): void {
    this.drop(key);
    if (size > this.maxChars) return;
    this.entries.set(key, { version, value, size });
    this.total += size;
    for (const [k] of this.entries) {
      if (this.total <= this.maxChars) break;
      this.drop(k);
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.total -= e.size;
    this.entries.delete(key);
  }
}

const HOUSEHOLD = 'household.json';
const HOUSEHOLD_SCHEMA = 'medrec-household/v1';

/** One call's view of the folder. */
export class Folder {
  private household_: Promise<Household> | null = null;

  constructor(
    private readonly source: FileSource,
    private readonly cache: ParsedCache,
    /** Distinguishes folders sharing the cache (one per deployment, but tests run several). */
    private readonly scope: string,
  ) {}

  private async cached<T>(path: string, parse: (text: string) => T | Promise<T>): Promise<T | null> {
    const version = await this.source.version(path);
    if (version === null) return null;
    const key = `${this.scope}\u0000${path}`;
    const hit = this.cache.get(key, version);
    if (hit !== undefined) return hit as T;
    const text = await this.source.read(path);
    if (text === null) return null;
    const value = await parse(text);
    this.cache.set(key, version, value, text.length);
    return value;
  }

  /** A JSON file parsed, from the cache while its version holds. One path is always read with one `parse`. */
  parsed<T>(path: string, parse?: (text: string) => unknown): Promise<T | null> {
    return this.json<T>(path, parse);
  }

  bytes(path: string, start: number, end: number): Promise<Uint8Array | null> {
    return this.source.bytes(path, start, end);
  }

  /** A binary file whole, from the cache while its version holds. */
  async binary(path: string): Promise<Uint8Array | null> {
    const version = await this.source.version(path);
    if (version === null) return null;
    const key = `${this.scope}\u0000bytes\u0000${path}`;
    const hit = this.cache.get(key, version);
    if (hit !== undefined) return hit as Uint8Array;
    const size = await this.source.size(path);
    if (size === null) return null;
    const b = await this.source.bytes(path, 0, size);
    if (b === null || b.length !== size) return null;
    this.cache.set(key, version, b, b.length);
    return b;
  }

  md5(paths: string[]): Promise<(string | null)[]> {
    return this.source.md5(paths);
  }

  async survey(dirs: string[], files: string[]): Promise<void> {
    await this.source.survey?.(dirs, files);
  }

  /** How many more requests this call may make. */
  remaining(): number {
    return this.source.remaining?.() ?? Number.POSITIVE_INFINITY;
  }

  size(path: string): Promise<number | null> {
    return this.source.size(path);
  }

  private json<T>(path: string, parse: (text: string) => unknown = JSON.parse): Promise<T | null> {
    return this.cached(path, (text) => {
      try {
        return parse(text) as T;
      } catch {
        // The parser's message can quote the file's text: never pass it on.
        throw ToolError.other(`${path} is not valid JSON`);
      }
    });
  }

  /** A person's files, as paths in the folder. */
  personFiles(p: Person): string[] {
    return ['index.json', 'text.json', 'notes.md'].map((f) => `${p.folder}/${f}`);
  }

  /**
   * A value computed from files, kept in the cache for as long as none of
   * them changes: each person's search text, folded once. `from` is what else
   * it was made from.
   */
  async derived<T>(name: string, paths: string[], build: () => Promise<{ value: T; size: number }>, from = ''): Promise<T> {
    const version = [...(await Promise.all(paths.map((p) => this.source.version(p)))).map((v) => v ?? '-'), from].join('\u0001');
    const key = `${this.scope}\u0000derived\u0000${name}`;
    const hit = this.cache.get(key, version);
    if (hit !== undefined) return hit as T;
    const { value, size } = await build();
    this.cache.set(key, version, value, size);
    return value;
  }

  household(): Promise<Household> {
    this.household_ ??= (async () => {
      const h = await this.json<Household>(HOUSEHOLD);
      if (!h) throw ToolError.other(`${HOUSEHOLD} is missing: the configured folder is not a medrec records folder`);
      if (h.schema !== HOUSEHOLD_SCHEMA) throw ToolError.other(`${HOUSEHOLD} has schema \`${h.schema}\`; this connector reads \`${HOUSEHOLD_SCHEMA}\``);
      if (h.format > FORMAT) throw ToolError.other(`the records folder is format ${h.format}, newer than this connector (format ${FORMAT}); update the connector`);
      return h;
    })();
    return this.household_;
  }

  /** The person's index.json as it is: what an answer shows of it is the store's (RawStore). */
  async index(p: Person): Promise<PersonIndex> {
    const path = `${p.folder}/index.json`;
    const idx = (await this.json<PersonIndex & { person?: string }>(path, parseExact)) ?? { schema: 'medrec-index/v1', person: p.id };
    if (idx.person !== p.id) throw ToolError.other(`${path} names another person`);
    return idx;
  }

  async text(p: Person): Promise<PersonText> {
    return (await this.json<PersonText>(`${p.folder}/text.json`)) ?? { schema: 'medrec-text/v1', texts: {} };
  }

  async notes(p: Person): Promise<Note[]> {
    return (await this.cached(`${p.folder}/notes.md`, parseNotes)) ?? [];
  }
}
