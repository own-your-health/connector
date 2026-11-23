// The records folder in Google Drive, through the app's own Drive client
// (src/records/app, a pinned copy of own-your-health/app). One instance per
// call: its folder listings live for that call only, so every call sees the
// folder as it is now.

import { ToolError } from '../mcp/errors';
import { DRIVE_API, Drive, DriveError, FOLDER_MIME, q } from './app/drive';
import { DriveFolder } from './app/folder';
import type { FileSource } from './folder';

/** The app's client passes browser-only fetch options; the Workers runtime refuses `cache: 'no-store'`. */
const workerFetch: typeof fetch = (input, init) => {
  const { cache: _cache, referrerPolicy: _referrer, ...rest } = init ?? {};
  return fetch(input, rest);
};

/**
 * Requests to Google one call may make: the Workers Free plan allows 50
 * subrequests a request, and the token check and audit need none of them.
 */
export const SUBREQUESTS = 48;

/** A file as a survey finds it. */
interface Known {
  id: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
}

export class DriveSource implements FileSource {
  private readonly folder: DriveFolder;
  private readonly drive: Drive;
  private spent = 0;
  /** Files a survey found, by path, and the folders it listed whole. */
  private readonly known = new Map<string, Known>();
  private readonly surveyed = new Set<string>();

  constructor(
    private readonly accessToken: string,
    private readonly folderId: string,
    fetchImpl: typeof fetch = workerFetch,
  ) {
    const counted: typeof fetch = (input, init) => {
      // Past the budget the platform refuses the request; say why instead.
      if (++this.spent > SUBREQUESTS) {
        throw ToolError.usage('this question needs more of the records than one request may read').withFix('Ask about one person, over fewer dates, or with fewer words');
      }
      return fetchImpl(input, init);
    };
    this.fetchImpl = counted;
    this.drive = new Drive(() => accessToken, counted);
    this.folder = new DriveFolder(this.drive, folderId, 'records');
  }

  private readonly fetchImpl: typeof fetch;

  /** How many requests to Google this call has made. */
  get requests(): number {
    return this.spent;
  }

  remaining(): number {
    return Math.max(0, SUBREQUESTS - this.spent);
  }

  /** A Drive API request outside the app's client (ranges, surveys), failing as the client does. */
  private async call(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await this.fetchImpl(url, { headers: { ...headers, Authorization: `Bearer ${this.accessToken}` } });
    if (res.ok) return res;
    let reason = 'error';
    try {
      reason = ((await res.json()) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason ?? reason;
    } catch {
      // Not JSON.
    }
    throw new DriveError(res.status, reason, `Drive answered ${res.status}.`);
  }

  /** The file at a path: from a survey when one covered it, otherwise through the folder's listings. */
  private async file(path: string): Promise<Known | null> {
    const k = this.known.get(path);
    if (k) return k;
    const i = path.lastIndexOf('/');
    if (this.surveyed.has(i === -1 ? '' : path.slice(0, i))) return null;
    return guarded(() => this.folder.resolve(path));
  }

  /**
   * One files.list for every file in `dirs` and each of `files`, with their
   * MD5s: later calls on them need no listing and no request of their own.
   */
  async survey(dirs: string[], files: string[]): Promise<void> {
    const ids = new Map<string, string>();
    const idOf = async (dir: string) => {
      if (ids.has(dir)) return ids.get(dir);
      const f = dir === '' ? { id: this.folderId, mimeType: FOLDER_MIME } : await guarded(() => this.folder.resolve(dir));
      if (f && f.mimeType === FOLDER_MIME) ids.set(dir, f.id);
      return ids.get(dir);
    };
    const whole: string[] = [];
    for (const d of dirs) if ((await idOf(d)) !== undefined) whole.push(d);
    const named = new Map<string, Set<string>>();
    for (const p of files) {
      const i = p.lastIndexOf('/');
      const dir = i === -1 ? '' : p.slice(0, i);
      if ((await idOf(dir)) === undefined) continue;
      (named.get(dir) ?? (named.set(dir, new Set()), named.get(dir)!)).add(p.slice(i + 1));
    }
    const parts = [
      ...(whole.length ? [`(${whole.map((d) => `${q(ids.get(d)!)} in parents`).join(' or ')})`] : []),
      ...[...named].map(([d, names]) => `(${q(ids.get(d)!)} in parents and (${[...names].map((n) => `name = ${q(n)}`).join(' or ')}))`),
    ];
    if (parts.length === 0) return;
    const byId = new Map([...ids].map(([d, id]) => [id, d]));
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `(${parts.join(' or ')}) and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,md5Checksum)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await guarded(() => this.call(`${DRIVE_API}/files?${params}`));
      const body = (await res.json()) as { nextPageToken?: string; files?: (Known & { name: string; parents?: string[] })[] };
      for (const f of body.files ?? []) {
        for (const parent of f.parents ?? []) {
          const dir = byId.get(parent);
          if (dir === undefined) continue;
          const path = dir === '' ? f.name : `${dir}/${f.name}`;
          const held = this.known.get(path);
          // Two files of one name: the newer, as the folder's listings choose.
          if (!held || (f.modifiedTime ?? '') > (held.modifiedTime ?? '')) this.known.set(path, f);
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    for (const d of whole) this.surveyed.add(d);
    // A named file the survey did not find is missing.
    for (const [d, names] of named) for (const n of names) if (!this.known.has(d === '' ? n : `${d}/${n}`)) this.known.set(d === '' ? n : `${d}/${n}`, MISSING);
  }

  async version(path: string): Promise<string | null> {
    const f = await this.file(path);
    if (!f || f === MISSING || f.mimeType === FOLDER_MIME) return null;
    return `${f.id}\u0000${f.modifiedTime ?? ''}\u0000${f.size ?? ''}`;
  }

  async read(path: string): Promise<string | null> {
    const f = await this.file(path);
    if (!f || f === MISSING || f.mimeType === FOLDER_MIME) return null;
    return guarded(async () => {
      try {
        return await this.drive.text(f.id);
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return null;
        throw e;
      }
    });
  }

  async size(path: string): Promise<number | null> {
    const f = await this.file(path);
    if (!f || f === MISSING || f.mimeType === FOLDER_MIME) return null;
    return f.size === undefined ? null : Number(f.size);
  }

  /** One Range request: the bytes a snippet or a page of text needs, not the whole file. */
  async bytes(path: string, start: number, end: number): Promise<Uint8Array | null> {
    const f = await this.file(path);
    if (!f || f === MISSING || f.mimeType === FOLDER_MIME) return null;
    if (end <= start) return new Uint8Array(0);
    const res = await guarded(() => this.call(`${DRIVE_API}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`, { Range: `bytes=${start}-${end - 1}` }));
    const b = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range sends the whole file.
    return res.status === 206 ? b : b.subarray(start, end);
  }

  /** Each path's MD5: from a survey, surveying first the ones none covered. */
  async md5(paths: string[]): Promise<(string | null)[]> {
    const unknown = paths.filter((p) => !this.known.has(p));
    if (unknown.length > 0) await this.survey([], unknown);
    return paths.map((p) => {
      const f = this.known.get(p);
      return f && f !== MISSING ? (f.md5Checksum ?? null) : null;
    });
  }
}

const MISSING: Known = { id: '', mimeType: '' };

async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof DriveError)) {
      if (e instanceof TypeError) throw ToolError.upstream('Google Drive could not be reached');
      throw e;
    }
    if (e.status === 401) throw ToolError.auth('the Google sign-in behind this connection no longer works');
    if (e.status === 429 || e.status >= 500 || e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded') {
      throw ToolError.upstream(`Google Drive answered ${e.status}`);
    }
    if (e.status === 403) throw ToolError.auth(`Google Drive refused to read the records folder (${e.reason})`);
    throw ToolError.other(`Google Drive answered ${e.status} (${e.reason})`);
  }
}
