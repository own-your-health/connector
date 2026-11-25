// Test helpers: a records folder on disk as the tools' FileSource.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Folder, ParsedCache, type FileSource } from '../src/records/folder';
import { VIEWS_INDEX, personDir, storedName, type SlimSource, type ViewsIndex } from '../src/views/format';
import type { Household, Person } from '../src/records/model';
import type { Privacy } from '../src/records/private';
import { NO_NAMES, codeNamesOf, type CodeNames, type CodeNamesView } from '../src/records/code-names';
import { NO_LABELS, providerLabelsOf, type ProviderLabels, type ProvidersView } from '../src/records/provider-labels';
import { RawStore, type Standing } from '../src/records/store';
import { privacyOf, standingOf, type BillsView, type PrivateView } from '../src/views/store';

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
 * The views only medrec makes, each in test/fixtures/<view>/<folder>/<person id>.json
 * (scripts/derived.mjs; code-names.json is not rebuilt, see its README).
 */
export const DERIVED = ['events.json', 'bills.json', 'private.json', 'code-names.json', 'providers.json'] as const;

/**
 * Gives views this connector wrote what medrec adds beside them: each
 * person's events.json (0.9.0), bills.json and private.json (0.9.1), code-names.json (0.9.4) and providers.json (0.9.7), from
 * test/fixtures/<view>/`folder` as medrec wrote them for that folder,
 * stored under content-addressed names and listed in `files`, and the
 * `overrides`, `marks`, `provider_state` and `linked` MD5s they were made from. `linked`
 * follows medrec's own rule: a person with a birth date and their
 * guardians, both ways. `views` limits it to some of them.
 */
export function addDerived(root: string, folder: 'records' | 'large' | 'labels', views: readonly (typeof DERIVED)[number][] = DERIVED): void {
  const md5 = (path: string) => (existsSync(path) ? createHash('md5').update(readFileSync(path)).digest('hex') : null);
  const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; folder: string; birth_date?: string | null; guardians?: string[] }[] };
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  for (const p of h.people) {
    const v = index.people[p.id];
    if (!v) continue;
    for (const view of views) {
      const file = join(import.meta.dirname, 'fixtures', view.replace(/[.]json$/, ''), folder, `${p.id}.json`);
      if (!existsSync(file)) continue;
      const body = readFileSync(file);
      const sum = createHash('md5').update(body).digest('hex');
      writeFileSync(join(root, personDir(p.id) + storedName(view, sum)), body);
      v.files[view] = sum;
    }
    v.overrides = md5(join(root, p.folder, 'overrides.json'));
    v.marks = md5(join(root, p.folder, 'marks.json'));
    const state = md5(join(root, p.folder, 'provider-state.json'));
    if (state !== null) v.provider_state = state;
    const linked = h.people.filter((q) => q.id !== p.id && ((p.birth_date && p.guardians?.includes(q.id)) || (q.birth_date && q.guardians?.includes(p.id))));
    v.linked = Object.fromEntries(linked.map((q) => [q.id, { index: md5(join(root, q.folder, 'index.json')), text: md5(join(root, q.folder, 'text.json')) }]));
  }
  writeFileSync(at, JSON.stringify(index));
}

/** Puts test/fixtures/code-names/`folder` in views that medrec wrote, as scripts/golden.mjs does before recording. */
export function addCodeNames(root: string, folder: 'records' | 'large'): void {
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  for (const [pid, v] of Object.entries(index.people)) {
    const file = join(import.meta.dirname, 'fixtures/code-names', folder, `${pid}.json`);
    if (!existsSync(file)) continue;
    const body = readFileSync(file);
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(pid) + storedName('code-names.json', sum)), body);
    v.files['code-names.json'] = sum;
  }
  writeFileSync(at, JSON.stringify(index));
}

/**
 * The files read whole, with what only medrec's views say beside them: the
 * private items, bill standing and provider labels medrec wrote for `folder`
 * (test/fixtures/private, bills and providers). The parity test's files pass,
 * so it checks the tools' answers from the files, privacy and payments
 * included, against medrec's.
 */
export class RawWithDerived extends RawStore {
  constructor(
    folder: Folder,
    private readonly which: 'records' | 'large' | 'labels',
    /** A folder whose own views, as a test changed them, come first. */
    private readonly root?: string,
  ) {
    super(folder);
  }

  private fixture<T>(view: 'private' | 'bills' | 'code-names' | 'providers', p: Person): T | undefined {
    const index = this.root === undefined ? undefined : join(this.root, VIEWS_INDEX);
    const sum = index !== undefined && existsSync(index) ? (JSON.parse(readFileSync(index, 'utf8')) as ViewsIndex).people[p.id]?.files[`${view}.json`] : undefined;
    const file = sum !== undefined ? join(this.root!, personDir(p.id) + storedName(`${view}.json`, sum)) : join(import.meta.dirname, 'fixtures', view, this.which, `${p.id}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  }

  override async privacy(h: Household, p: Person): Promise<Privacy> {
    const v = this.fixture<PrivateView>('private', p);
    return v ? privacyOf(v) : super.privacy(h, p);
  }

  override async bills(_h: Household, p: Person): Promise<ReadonlyMap<string, Standing> | null> {
    const v = this.fixture<BillsView>('bills', p);
    return v ? standingOf(v) : null;
  }

  override async codeNames(_h: Household, p: Person): Promise<CodeNames> {
    const v = this.fixture<CodeNamesView>('code-names', p);
    return v ? codeNamesOf(v, p.id) : NO_NAMES;
  }

  override async providerLabels(_h: Household, p: Person): Promise<ProviderLabels> {
    const v = this.fixture<ProvidersView>('providers', p);
    return v ? providerLabelsOf(v, p.id) : NO_LABELS;
  }
}

/** Changes the source of every record the views hold, as another writer's would differ. */
export function editSources(root: string, edit: (s: SlimSource) => void): void {
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  let n = 0;
  for (const [pid, v] of Object.entries(index.people)) {
    for (const [view, sum] of Object.entries(v.files)) {
      if (!view.startsWith('records-')) continue;
      const records = JSON.parse(readFileSync(join(root, personDir(pid) + storedName(view, sum)), 'utf8')) as { provenance?: { source: SlimSource }[] }[];
      for (const r of records) {
        for (const p of r.provenance ?? []) {
          edit(p.source);
          n++;
        }
      }
      const text = JSON.stringify(records);
      const next = createHash('md5').update(text).digest('hex');
      writeFileSync(join(root, personDir(pid) + storedName(view, next)), text);
      v.files[view] = next;
    }
  }
  if (n === 0) throw new Error('the views name no source');
  writeFileSync(at, JSON.stringify(index));
}

/**
 * Gives every claim of each person a label in their providers.json, and the
 * file `others` labels no claim has, as medrec would for a household whose
 * providers a directory knows, for measuring what labels cost. A private
 * claim's are the private part's. Returns the files' sizes.
 */
export function labelClaims(root: string, others: number): number[] {
  const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; folder: string }[] };
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  const sizes: number[] = [];
  const id = (n: number) => `v_${createHash('md5').update(String(n)).digest('hex').slice(0, 20)}`;
  const label = (n: number) => ({
    name: `Sample Person ${n}, MD`,
    practice: `Example Practice ${n}`,
    role: 'family doctor',
    phone: '555-010-0101',
    phone_from: { from: 'directory', date: '2026-03-08' },
    confidence: 'likely',
    evidence: [{ from: 'only_match', state: 'FL' }],
  });
  for (const p of h.people) {
    const v = index.people[p.id]!;
    const records = (JSON.parse(readFileSync(join(root, p.folder, 'index.json'), 'utf8')) as { records?: { id: string; kind: string; fields?: { provider?: string } }[] }).records ?? [];
    const priv = (JSON.parse(readFileSync(join(root, personDir(p.id) + storedName('private.json', v.files['private.json']!)), 'utf8')) as PrivateView).records ?? {};
    const part = (claims: { id: string; fields?: { provider?: string } }[], from: number, more: number) => {
      const names = [...new Set(claims.flatMap((r) => (r.fields?.provider === undefined ? [] : [r.fields.provider])))];
      const all = [...names, ...Array.from({ length: more }, (_, n) => `SAMPLE PERSON ${from + names.length + n}`)];
      return {
        labels: Object.fromEntries(all.map((_, n) => [id(from + n), label(from + n)])),
        by_name: Object.fromEntries(all.map((name, n) => [name, id(from + n)])),
        by_item: {},
        claims: Object.fromEntries(claims.flatMap((r) => (r.fields?.provider === undefined ? [] : [[r.id, id(from + names.indexOf(r.fields.provider))]]))),
        overrides: [],
      };
    };
    const claims = records.filter((r) => r.kind === 'claim');
    if (claims.length === 0) continue;
    const body = JSON.stringify({ schema: 'medrec-providers/v1', person: p.id, ...part(claims.filter((r) => !priv[r.id]), 0, others), private: part(claims.filter((r) => priv[r.id]), 100_000, 0) });
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(p.id) + storedName('providers.json', sum)), body);
    v.files['providers.json'] = sum;
    sizes.push(body.length);
  }
  writeFileSync(at, JSON.stringify(index));
  return sizes;
}

/**
 * Marks every `every`-th record of each person private in their private.json,
 * as medrec would list them, for measuring a household with private items.
 */
export function markPrivate(root: string, every: number): number {
  const h = JSON.parse(readFileSync(join(root, 'household.json'), 'utf8')) as { people: { id: string; folder: string }[] };
  const at = join(root, VIEWS_INDEX);
  const index = JSON.parse(readFileSync(at, 'utf8')) as ViewsIndex;
  let n = 0;
  for (const p of h.people) {
    const records = (JSON.parse(readFileSync(join(root, p.folder, 'index.json'), 'utf8')) as { records?: { id: string }[] }).records ?? [];
    const marked = records.filter((_, i) => i % every === every - 1);
    n += marked.length;
    const body = JSON.stringify({ schema: 'medrec-private/v1', person: p.id, records: Object.fromEntries(marked.map((r) => [r.id, { area: 'mental_health', from: 'code' }])), documents: {}, events: {}, studies: {} });
    const sum = createHash('md5').update(body).digest('hex');
    writeFileSync(join(root, personDir(p.id) + storedName('private.json', sum)), body);
    index.people[p.id]!.files['private.json'] = sum;
  }
  writeFileSync(at, JSON.stringify(index));
  return n;
}

