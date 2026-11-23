#!/usr/bin/env node
// The connections assistants hold, and ending them.
//
//   npm run grants                    list: account, assistant, when, id
//   npm run grants -- revoke <id>     end one: its tokens stop working at once
//   npm run grants -- revoke --all    end every connection
//
// Ending a connection deletes its grant and tokens from the Worker's KV, so
// the Google refresh token in it is gone too. It does not revoke anything at
// Google: that would also sign the household out of medrec and the web app,
// which share the Cloud project (README, "Revoking").

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, kvNamespaceId, wrangler } from './local.mjs';

const [cmd, target] = process.argv.slice(2);
const ns = kvNamespaceId();
const keys = (prefix) => wrangler(['kv', 'key', 'list', '--namespace-id', ns, '--prefix', prefix, '--remote'], { json: true }).map((k) => k.name);

/** `grant:<account>:<id>` (the account holds no `:`, nor does the id). */
const grants = () =>
  keys('grant:').map((name) => {
    const rest = name.slice('grant:'.length);
    const i = rest.lastIndexOf(':');
    return { key: name, account: rest.slice(0, i), id: rest.slice(i + 1) };
  });

if (!cmd || cmd === 'list') {
  const all = grants();
  if (all.length === 0) {
    console.log('No connections.');
    process.exit(0);
  }
  console.log('| Connected | Account | Assistant | Sends to | Grant id |\n|---|---|---|---|---|');
  for (const g of all) {
    const v = JSON.parse(wrangler(['kv', 'key', 'get', '--namespace-id', ns, g.key, '--remote', '--text'], { quiet: true }));
    const m = v.metadata ?? {};
    console.log(`| ${m.connectedAt ?? new Date(v.createdAt * 1000).toISOString()} | ${g.account} | ${m.client ?? v.clientId} | ${m.redirectHost ?? ''} | ${g.id} |`);
  }
} else if (cmd === 'revoke') {
  if (!target) fail('usage: npm run grants -- revoke <grant id> | --all');
  const chosen = target === '--all' ? grants() : grants().filter((g) => g.id === target);
  if (chosen.length === 0) fail(`No connection with grant id ${target}.`);
  const doomed = chosen.flatMap((g) => [...keys(`token:${g.account}:${g.id}:`), g.key]);
  const dir = mkdtempSync(join(tmpdir(), 'oyh-revoke-'));
  try {
    const file = join(dir, 'keys.json');
    writeFileSync(file, JSON.stringify(doomed));
    wrangler(['kv', 'bulk', 'delete', '--namespace-id', ns, file, '--remote', '--force'], { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Ended ${chosen.length} connection${chosen.length === 1 ? '' : 's'}: ${chosen.map((g) => g.id).join(', ')}. Each assistant must connect again.`);
} else {
  fail('usage: npm run grants [list | revoke <grant id> | revoke --all]');
}
