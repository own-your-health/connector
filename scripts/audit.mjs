#!/usr/bin/env node
// Who used the connector: time, Google account, connection, assistant, tool
// or event, and whether it answered. Never what was asked or answered.
//
//   npm run audit                       the last 7 days, newest first
//   npm run audit -- --since 2026-11-01 [--limit 500]

import { D1_NAME, fail, wrangler } from './local.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const since = opt('--since', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
const limit = Number(opt('--limit', '200'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) fail('--since takes a date, YYYY-MM-DD.');
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) fail('--limit takes 1 to 10000.');

const sql = `SELECT at, account, grant_id, client, event, ok FROM audit WHERE at >= '${since}' ORDER BY at DESC LIMIT ${limit}`;
const out = wrangler(['d1', 'execute', D1_NAME, '--remote', '--json', '--command', sql], { json: true });
const rows = out[0]?.results ?? [];
if (rows.length === 0) {
  console.log(`Nothing since ${since}.`);
  process.exit(0);
}
console.log('| Time (UTC) | Account | Assistant | Tool or event | Answered | Grant |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.at.slice(0, 19).replace('T', ' ')} | ${r.account} | ${r.client} | ${r.event} | ${r.ok ? 'yes' : 'no'} | ${r.grant_id} |`);
