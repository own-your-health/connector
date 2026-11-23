// The connector as deployed (src/worker.ts), for the CPU bench only: its
// requests to Google go to the local fake (test/fake-google.ts, served by
// scripts/bench.mjs) instead. Never deployed; bench/wrangler.jsonc names it.

import connector from '../src/worker';

const FAKE = 'http://127.0.0.1:8790';
const GOOGLE = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com']);
const real = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const u = new URL(req.url);
  if (!GOOGLE.has(u.host)) return real(req);
  return real(new Request(`${FAKE}/${u.host}${u.pathname}${u.search}`, req));
};

export default connector;
