// The records folder in Google Drive, through the app's own Drive client
// (src/records/app, a pinned copy of own-your-health/app). One instance per
// call: its folder listings live for that call only, so every call sees the
// folder as it is now.

import { ToolError } from '../mcp/errors';
import { Drive, DriveError, FOLDER_MIME } from './app/drive';
import { DriveFolder } from './app/folder';
import type { FileSource } from './folder';

/** The app's client passes browser-only fetch options; the Workers runtime refuses `cache: 'no-store'`. */
const workerFetch: typeof fetch = (input, init) => {
  const { cache: _cache, referrerPolicy: _referrer, ...rest } = init ?? {};
  return fetch(input, rest);
};

export class DriveSource implements FileSource {
  private readonly folder: DriveFolder;

  constructor(accessToken: string, folderId: string, fetchImpl: typeof fetch = workerFetch) {
    this.folder = new DriveFolder(new Drive(() => accessToken, fetchImpl), folderId, 'records');
  }

  async version(path: string): Promise<string | null> {
    const f = await guarded(() => this.folder.resolve(path));
    if (!f || f.mimeType === FOLDER_MIME) return null;
    return `${f.id}\u0000${f.modifiedTime ?? ''}\u0000${f.size ?? ''}`;
  }

  read(path: string): Promise<string | null> {
    return guarded(() => this.folder.readText(path));
  }
}

/** Drive's failures as tool errors. Drive's own message is dropped: it can name files, and nothing here needs it. */
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
