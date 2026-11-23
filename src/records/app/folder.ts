// The records folder by path, the same for Drive and for the demo's
// synthetic folder. Paths are relative to the folder, `/`-separated, as
// medrec writes them in the index (`Robin Example/index.json`).

import { Drive, DriveError, FOLDER_MIME, viewUrl, type DriveFile } from './drive';

export interface Entry {
  name: string;
  folder: boolean;
  modifiedTime?: string;
  /** Whether this app may delete it: true only for files the app created. */
  deletable: boolean;
}

export interface RecordsFolder {
  readonly kind: 'drive' | 'demo';
  readonly id: string;
  readonly name: string;
  readText(path: string): Promise<string | null>;
  list(path: string): Promise<Entry[] | null>;
  /** A link that opens the file or folder in Drive's own viewer. */
  link(path: string): Promise<string | null>;
  /** Writes `_requests/<name>`; the only write the app makes. */
  createRequest(name: string, body: unknown): Promise<void>;
  /** Deletes one of the app's own pending requests (a cancel). */
  deleteRequest(name: string): Promise<void>;
  /** Forgets what was read under a path, so the next read goes to Drive. */
  forget(prefix: string): void;
}

export async function readJson(folder: RecordsFolder, path: string): Promise<unknown | null> {
  const text = await folder.readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((p) => p !== '' && p !== '.');
}

export const REQUESTS_DIR = '_requests';

export class DriveFolder implements RecordsFolder {
  readonly kind = 'drive' as const;
  private listings = new Map<string, Promise<Map<string, DriveFile>>>();

  constructor(
    private readonly drive: Drive,
    readonly id: string,
    readonly name: string,
  ) {}

  private listing(dirPath: string, dirId: string): Promise<Map<string, DriveFile>> {
    let p = this.listings.get(dirPath);
    if (!p) {
      p = this.drive.children(dirId).then((files) => {
        const m = new Map<string, DriveFile>();
        for (const f of files) {
          const held = m.get(f.name);
          // Drive allows two files of one name; medrec never writes them, so
          // take the newer one.
          if (!held || (f.modifiedTime ?? '') > (held.modifiedTime ?? '')) m.set(f.name, f);
        }
        return m;
      });
      p.catch(() => this.listings.delete(dirPath));
      this.listings.set(dirPath, p);
    }
    return p;
  }

  /** The Drive file at a path, or null when any part of it is missing. */
  async resolve(path: string): Promise<DriveFile | null> {
    const parts = splitPath(path);
    let dir: DriveFile = { id: this.id, name: this.name, mimeType: FOLDER_MIME };
    let dirPath = '';
    for (const part of parts) {
      if (dir.mimeType !== FOLDER_MIME) return null;
      const next = (await this.listing(dirPath, dir.id)).get(part);
      if (!next) return null;
      dir = next;
      dirPath = dirPath ? `${dirPath}/${part}` : part;
    }
    return dir;
  }

  async readText(path: string): Promise<string | null> {
    const f = await this.resolve(path);
    if (!f || f.mimeType === FOLDER_MIME) return null;
    try {
      return await this.drive.text(f.id);
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null;
      throw e;
    }
  }

  async list(path: string): Promise<Entry[] | null> {
    const f = await this.resolve(path);
    if (!f || f.mimeType !== FOLDER_MIME) return null;
    const m = await this.listing(splitPath(path).join('/'), f.id);
    return [...m.values()].map((x) => ({
      name: x.name,
      folder: x.mimeType === FOLDER_MIME,
      modifiedTime: x.modifiedTime,
      deletable: x.capabilities?.canDelete === true,
    }));
  }

  async link(path: string): Promise<string | null> {
    const f = await this.resolve(path);
    return f ? viewUrl(f) : null;
  }

  async createRequest(name: string, body: unknown): Promise<void> {
    const dir = await this.resolve(REQUESTS_DIR);
    if (!dir || dir.mimeType !== FOLDER_MIME) throw new Error('The records folder has no _requests folder.');
    await this.drive.createJson(dir.id, name, body);
    this.forget(REQUESTS_DIR);
  }

  async deleteRequest(name: string): Promise<void> {
    const f = await this.resolve(`${REQUESTS_DIR}/${name}`);
    if (!f) return;
    await this.drive.remove(f.id);
    this.forget(REQUESTS_DIR);
  }

  forget(prefix: string): void {
    const p = splitPath(prefix).join('/');
    for (const k of [...this.listings.keys()]) {
      if (p === '' || k === p || k.startsWith(`${p}/`)) this.listings.delete(k);
    }
  }
}

/**
 * The synthetic records folder shipped with the app (public/demo/), read
 * over the page's own origin. Writes stay in memory, and a simulated Mac
 * answers refresh requests, so the whole flow can be tried without a Drive.
 */
export class DemoFolder implements RecordsFolder {
  readonly kind = 'demo' as const;
  readonly id = 'demo';
  readonly name = 'Sample records';
  private files: Promise<Set<string>>;
  private written = new Map<string, string>();
  private deleted = new Set<string>();
  private mine = new Set<string>();

  private shiftMs = 0;

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    now: Date = new Date(),
  ) {
    this.files = this.fetchImpl(`${base}manifest.json`)
      .then((r) => r.json() as Promise<{ files: string[]; anchor?: string }>)
      .then((m) => {
        // The sample was written at its anchor time; move its timestamps to
        // now, so its loads look as recent as when it was written.
        if (m.anchor) this.shiftMs = now.getTime() - Date.parse(m.anchor);
        return new Set(m.files);
      });
  }

  private shift(text: string): string {
    if (!this.shiftMs) return text;
    return text.replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z\b/g, (t) => new Date(Date.parse(t) + this.shiftMs).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }

  private url(path: string): string {
    return this.base + splitPath(path).map(encodeURIComponent).join('/');
  }

  private async exists(path: string): Promise<boolean> {
    const p = splitPath(path).join('/');
    if (this.deleted.has(p)) return false;
    return this.written.has(p) || (await this.files).has(p);
  }

  async readText(path: string): Promise<string | null> {
    const p = splitPath(path).join('/');
    if (this.deleted.has(p)) return null;
    const w = this.written.get(p);
    if (w !== undefined) return w;
    if (!(await this.exists(p))) return null;
    const res = await this.fetchImpl(this.url(p));
    return res.ok ? this.shift(await res.text()) : null;
  }

  async list(path: string): Promise<Entry[] | null> {
    const dir = splitPath(path).join('/');
    const prefix = dir ? `${dir}/` : '';
    const all = new Set([...(await this.files), ...this.written.keys()]);
    const names = new Map<string, boolean>();
    let any = dir === '';
    for (const f of all) {
      if (this.deleted.has(f) || !f.startsWith(prefix)) continue;
      any = true;
      const rest = f.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      if (head) names.set(head, (names.get(head) ?? false) || tail.length > 0);
    }
    // A folder that only holds folders still exists; `_requests/` and
    // `_requests/done/` are kept by a placeholder in the manifest.
    for (const f of all) if (f === `${prefix}.keep`) any = true;
    if (!any) return null;
    return [...names]
      .filter(([n]) => n !== '.keep')
      .map(([name, folder]) => ({ name, folder, deletable: this.mine.has(`${prefix}${name}`) }));
  }

  async link(): Promise<string | null> {
    return null;
  }

  async createRequest(name: string, body: unknown): Promise<void> {
    const p = `${REQUESTS_DIR}/${name}`;
    this.deleted.delete(p);
    this.written.set(p, JSON.stringify(body, null, 2));
    this.mine.add(p);
  }

  async deleteRequest(name: string): Promise<void> {
    const p = `${REQUESTS_DIR}/${name}`;
    if (!this.mine.has(p)) throw new Error('Only a request this app made can be cancelled.');
    this.written.delete(p);
    this.mine.delete(p);
    this.deleted.add(p);
  }

  /** The simulated Mac's own write: it is medrec's, not the app's. */
  writeAsMac(path: string, text: string): void {
    const p = splitPath(path).join('/');
    this.deleted.delete(p);
    this.written.set(p, text);
  }

  removeAsMac(path: string): void {
    const p = splitPath(path).join('/');
    this.written.delete(p);
    this.mine.delete(p);
    this.deleted.add(p);
  }

  forget(): void {}
}
