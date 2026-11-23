// A stand-in for the slices of Google the connector calls: the OAuth
// authorization and token endpoints, and Drive's files.list, files.get and
// alt=media over a folder on disk. Synthetic accounts and tokens only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-secret-not-real';
export const FOLDER_ID = 'folder-root-test';

interface Node {
  id: string;
  name: string;
  folder: boolean;
  parent: string;
  path: string;
}

export interface Account {
  email: string;
  sub: string;
  verified?: boolean;
}

export class FakeGoogle {
  readonly nodes = new Map<string, Node>();
  private codes = new Map<string, { account: Account; challenge: string; redirect: string; scope: string }>();
  readonly refresh = new Map<string, Account>();
  readonly access = new Map<string, { account: Account; expires: number }>();
  /** Requests seen, as `METHOD host path`, for tests that count calls. */
  readonly seen: string[] = [];
  /** Faults for the next Drive requests: an HTTP status and Drive reason. */
  faults: { status: number; reason: string }[] = [];
  /** Grant scopes as asked, or drop the Drive scope (the user unticked it). */
  dropDriveScope = false;
  /** The account the next sign-in approves as. */
  next: Account = { email: 'robin@example.com', sub: '1001' };
  revokedRefresh = new Set<string>();

  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    this.scan(root, FOLDER_ID);
  }

  private scan(dir: string, parent: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(this.root, path);
      const id = `f${createHash('sha256').update(rel).digest('hex').slice(0, 15)}`;
      const folder = statSync(path).isDirectory();
      this.nodes.set(id, { id, name, folder, parent, path });
      if (folder) this.scan(path, id);
    }
  }

  private md5s = new Map<string, { key: string; md5: string }>();
  /** A file's MD5, worked out again only when its size or time changes. */
  private md5Of(path: string, s: { size: number; mtimeMs: number }): string {
    const key = `${s.size}:${s.mtimeMs}`;
    const held = this.md5s.get(path);
    if (held?.key === key) return held.md5;
    const md5 = createHash('md5').update(readFileSync(path)).digest('hex');
    this.md5s.set(path, { key, md5 });
    return md5;
  }

  private meta(n: Node) {
    const s = statSync(n.path);
    return {
      id: n.id,
      name: n.name,
      mimeType: n.folder ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
      modifiedTime: s.mtime.toISOString(),
      ...(n.folder ? {} : { size: String(s.size), md5Checksum: this.md5Of(n.path, s) }),
      parents: [n.parent],
      capabilities: { canEdit: false, canDelete: false, canAddChildren: false },
    };
  }

  /** A `fetch` that answers Google's hosts and refuses every other. */
  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(req.url);
    this.seen.push(`${req.method} ${url.host} ${url.pathname}`);
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') return this.token(await req.text());
    if (url.host === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/')) return this.drive(req, url);
    throw new TypeError(`fake Google: no route to ${url.host}`);
  };

  /** What Google's consent screen would do: approve as `next` and redirect with a code. */
  approve(authorizeUrl: string): string {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    if (p.get('client_id') !== CLIENT_ID || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('fake Google: bad authorization request');
    const code = `code-${this.codes.size + 1}`;
    let scope = p.get('scope') ?? '';
    if (this.dropDriveScope) scope = scope.split(' ').filter((s) => !s.includes('/auth/drive')).join(' ');
    this.codes.set(code, { account: this.next, challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, scope });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    return back.toString();
  }

  private async token(body: string): Promise<Response> {
    const p = new URLSearchParams(body);
    if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) return Response.json({ error: 'invalid_client' }, { status: 401 });
    if (p.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(p.get('code') ?? '');
      this.codes.delete(p.get('code') ?? '');
      if (!c || c.redirect !== p.get('redirect_uri')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const digest = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (digest !== c.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const refresh = `rt-${c.account.sub}-${this.refresh.size + 1}`;
      this.refresh.set(refresh, c.account);
      const access = this.mint(c.account);
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: c.account.sub, email: c.account.email, email_verified: c.account.verified ?? true };
      const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
      return Response.json({ access_token: access, refresh_token: refresh, expires_in: 3599, id_token: idToken, scope: c.scope.replace('email', 'https://www.googleapis.com/auth/userinfo.email'), token_type: 'Bearer' });
    }
    if (p.get('grant_type') === 'refresh_token') {
      const rt = p.get('refresh_token') ?? '';
      const account = this.refresh.get(rt);
      if (!account || this.revokedRefresh.has(rt)) return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
      return Response.json({ access_token: this.mint(account), expires_in: 3599, token_type: 'Bearer' });
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  private mint(account: Account): string {
    const t = `at-${account.sub}-${this.access.size + 1}`;
    this.access.set(t, { account, expires: Date.now() + 3_599_000 });
    return t;
  }

  private drive(req: Request, url: URL): Response {
    const fault = this.faults.shift();
    if (fault) return Response.json({ error: { code: fault.status, message: 'File not found: secret-file-name.json', errors: [{ reason: fault.reason }] } }, { status: fault.status });
    const auth = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const a = this.access.get(auth);
    if (!a || a.expires < Date.now()) return Response.json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, { status: 401 });
    const rest = url.pathname.slice('/drive/v3/files'.length);
    if (rest === '' || rest === '/') {
      const q = url.searchParams.get('q') ?? '';
      const m = /^'([^']+)' in parents and trashed = false$/.exec(q);
      if (m) return Response.json({ files: [...this.nodes.values()].filter((n) => n.parent === m[1]).map((n) => this.meta(n)) });
      // Any and/or of `'<id>' in parents`, `name = '<name>'` and `trashed = false`, as DriveSource.survey asks.
      const test = parseQuery(q);
      if (!test) return Response.json({ error: { code: 400, message: 'unsupported query', errors: [{ reason: 'invalid' }] } }, { status: 400 });
      return Response.json({ files: [...this.nodes.values()].filter(test).map((n) => this.meta(n)) });
    }
    const id = decodeURIComponent(rest.slice(1));
    const n = this.nodes.get(id);
    if (!n) return Response.json({ error: { code: 404, message: `File not found: ${id}.`, errors: [{ reason: 'notFound' }] } }, { status: 404 });
    if (url.searchParams.get('alt') === 'media') {
      const body = readFileSync(n.path);
      const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range') ?? '');
      if (r) return new Response(body.subarray(Number(r[1]), Number(r[2]) + 1), { status: 206 });
      return new Response(body);
    }
    return Response.json(this.meta(n));
  }
}

/** Drive's query language, the slice of it the connector writes; null for anything else. */
function parseQuery(q: string): ((n: Node) => boolean) | null {
  const tokens = q.match(/'(?:[^'\\]|\\.)*'|\(|\)|[^\s()']+/g) ?? [];
  let i = 0;
  const str = (t: string) => t.slice(1, -1).replace(/\\(.)/g, '$1');
  type Test = (n: Node) => boolean;
  const atom = (): Test | null => {
    const t = tokens[i++];
    if (t === '(') {
      const e = or();
      return tokens[i++] === ')' ? e : null;
    }
    if (t?.startsWith("'") && tokens[i] === 'in' && tokens[i + 1] === 'parents') {
      i += 2;
      const id = str(t);
      return (n) => n.parent === id;
    }
    if (t === 'name' && tokens[i] === '=' && tokens[i + 1]?.startsWith("'")) {
      const name = str(tokens[i + 1]!);
      i += 2;
      return (n) => n.name === name;
    }
    if (t === 'trashed' && tokens[i] === '=' && tokens[i + 1] === 'false') {
      i += 2;
      return () => true;
    }
    return null;
  };
  const and = (): Test | null => {
    let a = atom();
    while (a && tokens[i] === 'and') {
      i++;
      const b = atom();
      if (!b) return null;
      const x = a;
      a = (n) => x(n) && b(n);
    }
    return a;
  };
  const or = (): Test | null => {
    let a = and();
    while (a && tokens[i] === 'or') {
      i++;
      const b = and();
      if (!b) return null;
      const x = a;
      a = (n) => x(n) || b(n);
    }
    return a;
  };
  const e = or();
  return e && i === tokens.length ? e : null;
}
