// A read-only MCP connector over one medrec records folder in Google Drive,
// deployed by a household into its own Cloudflare account.
//
//   /mcp                 Streamable HTTP MCP (stateless, JSON), behind OAuth
//   /authorize           consent, then Google sign-in
//   /google/callback     Google's answer; admits only ALLOWED_ACCOUNTS
//   /oauth/token, /oauth/register, /.well-known/*   workers-oauth-provider
//   /version             public: this connector's version and the medrec contract it follows
//
// Records are read from Drive on each call, with the caller's own Google
// token, and held only in this isolate's memory (src/records/folder.ts).
// Google's refresh token lives in the grant's props, which the provider
// encrypts in KV; the access token in the props of the access token that
// carries it. Nothing logs a record, an argument or a token.

import { AuthorizationError, CimdFetchError, OAuthError, OAuthProvider, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import type { OAuthHelpers, TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { audit, pruneAudit } from './audit';
import { describeAllowed, redirectOwner } from './auth/assistants';
import { type DriveScope, DRIVE_SCOPES, GoogleError, authorizeUrl, exchangeCode, randomToken, refreshAccess, type GoogleClient } from './auth/google';
import { ToolError } from './mcp/errors';
import { consentPage, messagePage, pageCsp } from './pages';
import { DriveSource } from './records/drive-source';
import { Folder, ParsedCache } from './records/folder';
import { ViewsStore } from './views/store';
import { SERVER, TOOLS, callTool, instructions, unknownTool } from './records/tools';
import { MEDREC_CONTRACT, VERSION } from './version';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** D1, optional: the audit log (src/audit.ts). */
  AUDIT?: D1Database;
  /** Secret: the connector's own Web client in the household's Cloud project. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Secret: the Google accounts that may connect, comma-separated. */
  ALLOWED_ACCOUNTS: string;
  /** Secret: the Drive id of the records folder (the one holding household.json). */
  FOLDER_ID: string;
  /** Var: `drive.file` (default) or `drive.readonly`. */
  DRIVE_SCOPE?: string;
  /** Var: the household's IANA time zone, for "today" (bills past due). UTC by default. */
  TIME_ZONE?: string;
  /** Var: the assistants that may connect (src/auth/assistants.ts). */
  ASSISTANTS?: string;
  /** Var: more callbacks to allow, comma-separated. */
  EXTRA_REDIRECT_URIS?: string;
}

const SCOPE = 'records:read';
const CALLBACK = '/google/callback';
/** An access token lives a little less than the Google token it carries, so a client refreshes before Drive refuses. */
const ACCESS_MARGIN_S = 300;
const GRANT_IDLE_S = 60 * 86_400;

/** What a grant keeps (encrypted by the provider). */
interface GrantProps {
  email: string;
  sub: string;
  /** Google's refresh token. */
  rt: string;
  client: string;
  grant?: string;
  /** Google's access token and its expiry, held only until the code exchange moves them to the access token. */
  at?: string;
  atExp?: number;
}

/** What an access token carries. */
interface TokenProps {
  email: string;
  sub: string;
  at: string;
  grant: string;
  client: string;
}

const accounts = (env: Env) =>
  new Set(
    (env.ALLOWED_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
const admitted = (env: Env, email: string | undefined) => email !== undefined && accounts(env).has(email.toLowerCase());

/** What signing in needs. A tool call also needs FOLDER_ID, so an assistant can be connected before the folder is known. */
const SIGN_IN = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_ACCOUNTS'] as const;

function missingConfig(env: Env, keys: readonly (keyof Env)[] = [...SIGN_IN, 'FOLDER_ID']): string[] {
  return keys.filter((k) => !String(env[k] ?? '').trim()) as string[];
}

function driveScope(env: Env): DriveScope {
  return env.DRIVE_SCOPE?.trim() === 'drive.readonly' ? 'drive.readonly' : 'drive.file';
}

function google(env: Env, origin: string): GoogleClient {
  return { clientId: env.GOOGLE_CLIENT_ID.trim(), clientSecret: env.GOOGLE_CLIENT_SECRET.trim(), redirectUri: `${origin}${CALLBACK}`, scope: driveScope(env) };
}

/** A formatter per time zone: building one costs more than a call's own work. */
const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The household's date, `YYYY-MM-DD`. */
export function today(env: Pick<Env, 'TIME_ZONE'>, now = new Date()): string {
  const fmt = (timeZone: string) => {
    let f = DAY_FORMATS.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      DAY_FORMATS.set(timeZone, f);
    }
    return f.format(now);
  };
  try {
    return fmt(env.TIME_ZONE?.trim() || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/** Parsed files, shared by every call this isolate serves (src/records/folder.ts). */
const CACHE = new ParsedCache();

/** Empties the parsed files, as a fresh isolate has them: for the CPU bench. */
export function clearCacheForTests(): void {
  CACHE.clear();
}

// ---- /mcp ----------------------------------------------------------------------------------------

function challenge(origin: string, description: string): Response {
  return Response.json(
    { error: 'invalid_token', error_description: description },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token", scope="${SCOPE}"`,
      },
    },
  );
}

/**
 * The SDK builds an Ajv validator for every Server, to check what a user
 * answers when a server elicits; this connector never asks, so it builds none.
 */
const NO_ELICITATION: jsonSchemaValidator = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: 'this connector asks the user nothing' }),
};

function mcpServer(env: Env, props: TokenProps, ctx: ExecutionContext): Server {
  const server = new Server(
    { name: 'own-your-health-connector', title: 'Medical records', version: VERSION },
    { capabilities: { tools: {} }, instructions: instructions(), jsonSchemaValidator: NO_ELICITATION },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as never }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    // A JSON-RPC error as medrec words it; an McpError would prefix "MCP error -32602:".
    if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(unknownTool(name)), { code: ErrorCode.InvalidParams });
    let result;
    const missing = missingConfig(env);
    if (missing.length > 0) {
      result = { content: [{ type: 'text' as const, text: ToolError.other(`this connector is not set up: ${missing.join(', ')} not set`).withFix('Tell the user; its owner sets the Worker secrets the README lists').render(SERVER) }], isError: true };
    } else {
      const folder = new Folder(new DriveSource(props.at, env.FOLDER_ID.trim()), CACHE, env.FOLDER_ID.trim());
      try {
        result = (await callTool(name, request.params.arguments, { store: new ViewsStore(folder), today: today(env) }))!;
      } catch (e) {
        // A bug, not the caller's doing. Only the error's class is told or logged: a message could quote a record.
        const kind = e instanceof Error ? e.name : typeof e;
        console.error(`tool ${name} failed: ${kind}`);
        result = { content: [{ type: 'text' as const, text: ToolError.other(`the connector failed while answering (${kind})`).render(SERVER) }], isError: true };
      }
    }
    ctx.waitUntil(audit(env.AUDIT, { account: props.email, grant: props.grant, client: props.client, event: name, ok: !result.isError }));
    return result as never;
  });
  return server;
}

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    const c = ctx as ExecutionContext & { props?: TokenProps; auth?: { scope: string[] } };
    const props = c.props;
    if (!props?.at || !c.auth?.scope.includes(SCOPE)) return challenge(origin, 'This connection is from an earlier version of the connector. Connect again.');
    // The allowlist as it is now, not as it was when this connection was made.
    if (!admitted(env, props.email)) return challenge(origin, 'This Google account is no longer admitted by this connector.');
    const server = mcpServer(env, props, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  },
};

// ---- /authorize and Google ------------------------------------------------------------------------

const site = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/authorize') return request.method === 'POST' ? await approve(request, env, url.origin) : await showConsent(request, env);
      if (url.pathname === CALLBACK && request.method === 'GET') return await googleCallback(request, env, url.origin);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return messagePage(400, `${error.description ?? 'The request is not valid.'} Start connecting again from your assistant.`);
      if (error instanceof CimdFetchError) return messagePage(400, 'The assistant asking to connect could not be verified. Try again in a minute.');
      throw error;
    }
    if (url.pathname === '/version' && request.method === 'GET') return versionResponse();
    if (url.pathname === '/' && request.method === 'GET') {
      return messagePage(200, `This is a household's medical records connector. Its owner adds ${url.origin}/mcp to an AI assistant as a custom connector.`);
    }
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};

/**
 * What a medrec about to change the household's folder reads first: whether
 * this connector follows its contract. Nothing of the household is in it.
 */
function versionResponse(): Response {
  return Response.json({ version: VERSION, medrec_contract: MEDREC_CONTRACT }, { headers: { 'Cache-Control': 'no-store' } });
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const missing = missingConfig(env, SIGN_IN);
  if (missing.length > 0) return messagePage(503, `This connector is not set up yet: ${missing.join(', ')} not set. Its README says how.`);
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const owner = redirectOwner(details.redirectUri, env);
  if (!owner) return messagePage(400, `This connector does not send access to ${details.redirectHost}. It is set up for: ${describeAllowed(env)}.`);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  consent.headers.set('Referrer-Policy', 'no-referrer');
  consent.headers.set('Content-Security-Policy', pageCsp(['https://accounts.google.com', new URL(details.redirectUri).origin]));
  return new Response(consentPage(details, consent.handle, owner.name), { headers: consent.headers });
}

async function approve(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  if (!redirectOwner(approved.request.redirectUri, env)) return messagePage(400, 'This connector does not send access there.');
  const verifier = randomToken(48);
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  headers.set('Location', await authorizeUrl(google(env, origin), state, verifier));
  return new Response(null, { status: 302, headers });
}

async function googleCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (params.get('error') || !code) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }
  let signedIn;
  try {
    signedIn = await exchangeCode(google(env, origin), code, data.verifier);
  } catch (e) {
    if (e instanceof GoogleError && e.message === 'drive-scope') {
      return messagePage(403, 'Google did not grant access to Drive. Start connecting again from your assistant, and on Google\'s page leave the Drive box ticked.');
    }
    if (e instanceof GoogleError) return messagePage(502, `Google sign-in did not finish (${e.message}). Start connecting again from your assistant.`);
    throw e;
  }
  const client = (await oauth.lookupClient(original.clientId))?.clientName ?? new URL(original.redirectUri).hostname;
  if (!admitted(env, signedIn.email) || signedIn.email.includes(':')) {
    await audit(env.AUDIT, { account: signedIn.email, grant: '', client, event: 'refused', ok: false });
    return messagePage(403, 'This Google account is not one this connector admits. Start connecting again and sign in with the account its owner listed.');
  }
  const props: GrantProps = { email: signedIn.email, sub: signedIn.sub, rt: signedIn.refreshToken, client, at: signedIn.accessToken, atExp: signedIn.expiresAt };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: signedIn.email,
    // Kept in the clear beside the grant, for `npm run grants`: no token, nothing from the records.
    metadata: { client, redirectHost: new URL(original.redirectUri).hostname, connectedAt: new Date().toISOString() },
    scope: original.scope.includes(SCOPE) ? original.scope : [SCOPE],
    props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

// ---- tokens ---------------------------------------------------------------------------------------

function accessTtl(expiresAt: number, now = Date.now()): number {
  return Math.max(60, Math.min(3600, Math.floor((expiresAt - now) / 1000) - ACCESS_MARGIN_S));
}

async function onTokenExchange(o: TokenExchangeCallbackOptions<Env>, origin: string) {
  const props = o.props as GrantProps;
  const env = o.env;
  if (o.grantType !== 'authorization_code' && o.grantType !== 'refresh_token') return;
  if (!admitted(env, props.email)) {
    await audit(env.AUDIT, { account: props.email, grant: o.grantId, client: props.client, event: 'refused', ok: false });
    throw new OAuthError('invalid_grant', { description: 'This Google account is no longer admitted by this connector.' });
  }
  const kept: GrantProps = { email: props.email, sub: props.sub, rt: props.rt, client: props.client, grant: o.grantId };
  if (o.grantType === 'authorization_code') {
    await audit(env.AUDIT, { account: props.email, grant: o.grantId, client: props.client, event: 'connect', ok: true });
    const token: TokenProps = { email: props.email, sub: props.sub, at: props.at ?? '', grant: o.grantId, client: props.client };
    return { accessTokenProps: token, newProps: kept, accessTokenTTL: accessTtl(props.atExp ?? 0) };
  }
  try {
    const fresh = await refreshAccess(google(env, origin), props.rt);
    const token: TokenProps = { email: props.email, sub: props.sub, at: fresh.accessToken, grant: o.grantId, client: props.client };
    return { accessTokenProps: token, newProps: kept, accessTokenTTL: accessTtl(fresh.expiresAt) };
  } catch (e) {
    if (e instanceof GoogleError && e.kind === 'invalid_grant') {
      await audit(env.AUDIT, { account: props.email, grant: o.grantId, client: props.client, event: 'google-ended', ok: false });
      // Revokes this grant: the client signs in again instead of retrying.
      throw new OAuthError('invalid_grant', { description: 'The Google sign-in behind this connection has ended. Connect again.' });
    }
    if (e instanceof GoogleError) throw new OAuthError('temporarily_unavailable', { description: 'Google is unavailable. Try again in a minute.', statusCode: 503 });
    throw e;
  }
}

// The protected resource's URL must be absolute, but a deploy-your-own
// Worker learns its hostname only when a request arrives; Cloudflare routes
// only this Worker's own hostnames here.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string, env: Env): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApi,
      defaultHandler: site,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Medical records' },
      // A connection lasts while it is used and lapses after 60 days unused;
      // `npm run grants` ends one, or all, at once.
      refreshTokenTTL: undefined,
      refreshTokenIdleTTL: GRANT_IDLE_S,
      tokenExchangeCallback: (o) => onTokenExchange(o, origin),
      // Registration stays open (assistants register themselves), but only
      // for callbacks this connector sends codes to; /authorize checks each
      // request again.
      clientRegistrationCallback: ({ clientMetadata }) => {
        const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris.map(String) : [];
        if (uris.length === 0 || !uris.every((u) => redirectOwner(u, env))) {
          return { code: 'invalid_redirect_uri', description: `This connector is set up for: ${describeAllowed(env)}.` };
        }
      },
      onError: ({ code, status, internal }) => {
        // Codes and reasons only: descriptions can carry what a client sent.
        console.warn(`oauth ${status} ${code} ${internal?.category ?? ''}/${internal?.reason ?? ''}`);
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export { DRIVE_SCOPES };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin, env).fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pruneAudit(env.AUDIT));
    await providerFor('https://connector.invalid', env).purgeExpiredData(env);
  },
};
