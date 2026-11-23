// The connector's few HTML pages: the consent page before Google sign-in,
// and short messages. Everything that came from a client (its name, its
// domain, the callback host) is escaped.

import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}
h1{font-size:1.35rem}p.warn{background:#fff4e5;border-left:4px solid #e8a33d;padding:.6rem .8rem}
button{font:inherit;padding:.5rem 1.1rem;margin-right:.5rem;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}
button.go{background:#1d5c4b;color:#fff;border-color:#1d5c4b}small{color:#555}
@media (prefers-color-scheme:dark){body{background:#141414;color:#e8e8e8}button{background:#222;color:#e8e8e8}p.warn{background:#3a2c12}small{color:#aaa}}`;

/**
 * The pages' policy. The consent form posts here and is answered with a
 * redirect to Google (Allow) or to the assistant (Deny); browsers hold that
 * redirect to `form-action` too, so both origins are named.
 */
export function pageCsp(formTargets: string[] = []): string {
  const targets = [...new Set(formTargets)].map((t) => ` ${t}`).join('');
  return `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'${targets}; frame-ancestors 'none'; base-uri 'none'`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title><style>${STYLE}</style>
<body>${body}</body></html>`;
}

export function consentPage(d: ConsentDescription, handle: string, assistant: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const local = d.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to a program on your computer.</strong> Continue only if you just started connecting from it.</p>'
    : '';
  return page(
    `Connect ${d.clientName} to your medical records`,
    `<h1>Let ${name} read your household's medical records?</h1>
<p>${origin} Access goes to <strong>${escape(d.redirectHost)}</strong> (${escape(assistant)}).</p>
${local}
<p>It can read the records folder this connector is set up for: summaries, search, records and document text. It cannot change anything.</p>
<p class="warn">Continue only if you started connecting from ${escape(assistant)} yourself, just now. If someone sent you this link, close the page.</p>
<p>Next, Google asks you to sign in. Use the account that holds the records folder; this connector admits only the accounts its owner listed.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<p><button class="go" name="decision" value="approve">Continue to Google</button><button name="decision" value="deny">Cancel</button></p>
</form>`,
  );
}

export function messagePage(status: number, message: string, title = 'Medical records connector'): Response {
  return new Response(page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': pageCsp(),
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
