// Where this connector may send an authorization code: the callbacks of the
// assistants the owner turned on (ASSISTANTS), loopback clients when
// `loopback` is among them, and EXTRA_REDIRECT_URIS. Registration and every
// authorization request are held to it, so a client registered with another
// callback never reaches the consent page.
//
// A shared callback (claude.ai's, chatgpt.com's) serves every account of that
// assistant, which is why the consent page tells the user to continue only
// when they started connecting themselves, and why ASSISTANTS lists only the
// assistants the household uses.

export interface Assistant {
  name: string;
  /** Exact callbacks, matched on origin and path (the query is ignored). */
  exact?: string[];
  /** Callback prefixes, matched on origin and the start of the path. */
  prefixes?: string[];
  loopback?: boolean;
}

export const ASSISTANTS: Record<string, Assistant> = {
  claude: { name: 'Claude', exact: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'] },
  chatgpt: {
    name: 'ChatGPT',
    exact: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    prefixes: ['https://chatgpt.com/connector/oauth/'],
  },
  gemini: {
    name: 'Gemini',
    prefixes: ['https://oauth-redirect.googleusercontent.com/r/', 'https://oauth-redirect.googleusercontent.com/a/'],
  },
  perplexity: {
    name: 'Perplexity',
    exact: ['https://www.perplexity.ai/rest/connections/oauth_callback', 'https://www.perplexity.ai/rest/enterprise/connections/oauth_callback'],
  },
  // Claude Code, Gemini CLI and other programs on the user's own computer.
  loopback: { name: 'an app on this computer', loopback: true },
};

export const DEFAULT_ASSISTANTS = 'claude,loopback';

export interface RedirectConfig {
  ASSISTANTS?: string;
  EXTRA_REDIRECT_URIS?: string;
}

const list = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function enabled(env: RedirectConfig): Assistant[] {
  return list(env.ASSISTANTS ?? DEFAULT_ASSISTANTS).flatMap((k) => (ASSISTANTS[k.toLowerCase()] ? [ASSISTANTS[k.toLowerCase()]!] : []));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The assistant a callback belongs to, or null when no code may go there. */
export function redirectOwner(uri: string, env: RedirectConfig): Assistant | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  const target = `${u.origin}${u.pathname}`;
  for (const a of enabled(env)) {
    if (a.loopback && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return a;
    if (u.protocol !== 'https:') continue;
    if (a.exact?.includes(target)) return a;
    if (a.prefixes?.some((p) => target.startsWith(p) && target.length > p.length && !target.slice(p.length).includes('..'))) return a;
  }
  if (u.protocol === 'https:' && list(env.EXTRA_REDIRECT_URIS).includes(target)) return { name: u.hostname, exact: [target] };
  return null;
}

export function describeAllowed(env: RedirectConfig): string {
  const names = enabled(env).map((a) => a.name);
  if (list(env.EXTRA_REDIRECT_URIS).length > 0) names.push('the extra callbacks its owner listed');
  return names.length > 0 ? names.join(', ') : 'none';
}
