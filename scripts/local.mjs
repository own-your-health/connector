// What the scripts run on your computer share: the household's settings
// (connector.local.json, never committed) and wrangler, pointed at the
// account those settings name and no other.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WORKER = 'records-connector';
export const KV_TITLE = `${WORKER}-oauth-kv`;
export const D1_NAME = `${WORKER}-audit`;

export function settings() {
  const path = join(ROOT, 'connector.local.json');
  if (!existsSync(path)) fail('connector.local.json is missing: copy connector.example.json to it and fill it in (README, "Set it up").');
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[0-9a-f]{32}$/.test(s.account_id ?? '')) fail('connector.local.json: account_id must be the 32-character Cloudflare account id.');
  return s;
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** wrangler, always on the configured account. `input` goes to its stdin; nothing secret is ever an argument. */
export function wrangler(args, { input, json = false, quiet = false } = {}) {
  const { account_id, wrangler_config } = settings();
  const r = spawnSync(join(ROOT, 'node_modules/.bin/wrangler'), args, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...wranglerConfig(wrangler_config), CLOUDFLARE_ACCOUNT_ID: account_id, WRANGLER_SEND_METRICS: 'false' },
    stdio: [input === undefined ? 'inherit' : 'pipe', json || quiet ? 'pipe' : 'inherit', 'inherit'],
  });
  if (r.status !== 0) fail(`wrangler ${args[0]} ${args[1] ?? ''} failed (exit ${r.status}).`);
  if (!json) return r.stdout;
  const text = r.stdout.slice(r.stdout.search(/[[{]/));
  return JSON.parse(text);
}

/** `wrangler_config`: a directory for this account's own wrangler sign-in, as wrangler's XDG_CONFIG_HOME. */
function wranglerConfig(dir) {
  if (dir === undefined) return {};
  if (typeof dir !== 'string' || !/^(\/|~\/)/.test(dir)) fail('connector.local.json: wrangler_config must be a directory starting with / or ~/.');
  return { XDG_CONFIG_HOME: dir.replace(/^~(?=\/)/, homedir()) };
}

export function kvNamespaceId() {
  const list = wrangler(['kv', 'namespace', 'list'], { json: true });
  const ns = list.find((n) => n.title === KV_TITLE);
  if (!ns) fail(`No KV namespace "${KV_TITLE}" in this account: deploy the Worker first.`);
  return ns.id;
}
