// The Drive REST API (v3), called with fetch. Every request goes to
// www.googleapis.com, the one host the Content-Security-Policy allows for it.

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  /** Whether this token may change the file (drive.file reaches only the app's own). */
  capabilities?: { canEdit?: boolean; canDelete?: boolean; canAddChildren?: boolean };
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,capabilities(canEdit,canDelete,canAddChildren)';

/** A string inside a Drive query, quoted, with `'` and `\` escaped. Never quote it again. */
export function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The query for a folder's children. */
export function childrenQuery(folderId: string): string {
  return `${q(folderId)} in parents and trashed = false`;
}

/** The query for folders of one name, anywhere the account can see. */
export function folderNamedQuery(name: string, parentId?: string): string {
  return `${parentId ? `${q(parentId)} in parents and ` : ''}name = ${q(name)} and mimeType = ${q(FOLDER_MIME)} and trashed = false`;
}

/** The query for the household.json files the account can see. */
export const HOUSEHOLD_QUERY = `name = ${q('household.json')} and trashed = false`;

export class Drive {
  constructor(
    private readonly token: () => string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly onUnauthorized: () => void = () => {},
  ) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token()}`);
    const res = await this.fetchImpl(url, { ...init, headers, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (res.ok) return res;
    let reason = 'error';
    let message = `Drive answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? reason;
      // Drive's own message names the file id at most; it carries no file content.
      if (body.error?.message) message = `Drive: ${body.error.message.slice(0, 200)}`;
    } catch {
      // Not JSON.
    }
    if (res.status === 401) this.onUnauthorized();
    throw new DriveError(res.status, reason, message);
  }

  async about(): Promise<{ email?: string; name?: string }> {
    const res = await this.call(`${DRIVE_API}/about?fields=user(displayName,emailAddress)`);
    const body = (await res.json()) as { user?: { displayName?: string; emailAddress?: string } };
    return { email: body.user?.emailAddress, name: body.user?.displayName };
  }

  async list(query: string, opts: { pageSize?: number; orderBy?: string } = {}): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const p = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(opts.pageSize ?? 1000),
        spaces: 'drive',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (opts.orderBy) p.set('orderBy', opts.orderBy);
      if (pageToken) p.set('pageToken', pageToken);
      const res = await this.call(`${DRIVE_API}/files?${p.toString()}`);
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  children(folderId: string): Promise<DriveFile[]> {
    return this.list(childrenQuery(folderId));
  }

  async get(fileId: string): Promise<DriveFile> {
    const res = await this.call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
    return (await res.json()) as DriveFile;
  }

  async text(fileId: string): Promise<string> {
    const res = await this.call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    return res.text();
  }

  /** Creates a JSON file in a folder, in one multipart upload. */
  async createJson(parentId: string, name: string, body: unknown): Promise<DriveFile> {
    const boundary = `oyh${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    const meta = { name, parents: [parentId], mimeType: 'application/json' };
    const payload = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(meta),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      JSON.stringify(body, null, 2),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await this.call(`${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: payload,
    });
    return (await res.json()) as DriveFile;
  }

  async remove(fileId: string): Promise<void> {
    await this.call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: 'DELETE' });
  }
}

export function viewUrl(file: Pick<DriveFile, 'id' | 'mimeType'>): string {
  return file.mimeType === FOLDER_MIME
    ? `https://drive.google.com/drive/folders/${encodeURIComponent(file.id)}`
    : `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
}

/** A folder id from a Drive folder link, or the id itself. */
export function folderIdFrom(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}
