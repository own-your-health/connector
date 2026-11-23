// Google sign-in for the connector's own Web client: the authorization code
// flow with PKCE and a client secret, offline access for a refresh token, and
// the account's verified email from the ID token.
//
// Never revoke a token at Google. Every client of one Cloud project shares a
// person's grant, so one revoke would also sign them out of medrec on their
// computer and of the web app (pk-cli-drive docs/google-drive.md, "Scope").
// Ending a connection here deletes the grant that holds the refresh token.

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export const DRIVE_SCOPES = {
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
} as const;
export type DriveScope = keyof typeof DRIVE_SCOPES;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: DriveScope;
  /** Overrides for tests (a local stand-in for Google). */
  authUrl?: string;
  tokenUrl?: string;
}

export class GoogleError extends Error {
  constructor(
    /** `invalid_grant`: the sign-in has ended (revoked, password changed, expired). */
    readonly kind: 'invalid_grant' | 'refused' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function authorizeUrl(c: GoogleClient, state: string, verifier: string, loginHint?: string): Promise<string> {
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: `openid email ${DRIVE_SCOPES[c.scope]}`,
    access_type: 'offline',
    // A refresh token comes back only with consent; select_account lets a
    // person with several Google accounts pick the records account.
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${c.authUrl ?? GOOGLE_AUTH}?${p.toString()}`;
}

export interface SignedIn {
  email: string;
  sub: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
}

async function tokenCall(c: GoogleClient, body: Record<string, string>): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await fetch(c.tokenUrl ?? GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }).toString(),
    });
  } catch {
    throw new GoogleError('unavailable', 'Google could not be reached');
  }
  let answer: TokenAnswer = {};
  try {
    answer = (await res.json()) as TokenAnswer;
  } catch {
    // Not JSON: judged by the status below.
  }
  if (res.ok) return answer;
  // Only Google's error code is kept: its description may echo a request value.
  if (answer.error === 'invalid_grant') throw new GoogleError('invalid_grant', 'Google answered invalid_grant');
  if (res.status >= 500 || res.status === 429) throw new GoogleError('unavailable', `Google answered ${res.status}`);
  throw new GoogleError('refused', `Google answered ${res.status}${answer.error ? ` ${answer.error}` : ''}`);
}

/** The ID token's claims. It came straight from Google's token endpoint over TLS, so its signature need not be checked (OpenID Connect Core 3.1.3.7). */
function claims(idToken: string): Record<string, unknown> {
  const part = idToken.split('.')[1];
  if (!part) throw new GoogleError('refused', 'Google sent no usable ID token');
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
}

export async function exchangeCode(c: GoogleClient, code: string, verifier: string, now = Date.now()): Promise<SignedIn> {
  const t = await tokenCall(c, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: c.redirectUri });
  if (!t.access_token || !t.id_token) throw new GoogleError('refused', 'Google sent no tokens');
  if (!t.refresh_token) throw new GoogleError('refused', 'Google sent no refresh token');
  const granted = (t.scope ?? '').split(' ');
  if (!granted.includes(DRIVE_SCOPES[c.scope])) throw new GoogleError('refused', 'drive-scope');
  const id = claims(t.id_token);
  const iss = id.iss;
  if (id.aud !== c.clientId || (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com')) throw new GoogleError('refused', 'Google sent an ID token for another client');
  if (typeof id.email !== 'string' || id.email_verified !== true || typeof id.sub !== 'string') throw new GoogleError('refused', 'Google sent no verified email');
  return {
    email: id.email.toLowerCase(),
    sub: id.sub,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: now + (t.expires_in ?? 3600) * 1000,
  };
}

export async function refreshAccess(c: GoogleClient, refreshToken: string, now = Date.now()): Promise<{ accessToken: string; expiresAt: number }> {
  const t = await tokenCall(c, { grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!t.access_token) throw new GoogleError('refused', 'Google sent no access token');
  return { accessToken: t.access_token, expiresAt: now + (t.expires_in ?? 3600) * 1000 };
}
