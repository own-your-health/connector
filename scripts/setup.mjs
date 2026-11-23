#!/usr/bin/env node
// Sends the household's settings to the Worker as secrets, in one
// `wrangler secret bulk` over stdin. Values are never printed or passed as
// arguments.
//
//   npm run setup -- <Google's client JSON>     everything, the first time
//   npm run setup -- --settings-only            connector.local.json only
//
// The client JSON is the file Google's console downloads for the
// connector's Web client (client_secret_….json). Delete it afterwards.

import { readFileSync } from 'node:fs';
import { fail, settings, wrangler } from './local.mjs';

const arg = process.argv[2];
if (!arg) fail('usage: npm run setup -- <client_secret_….json> | --settings-only');
const s = settings();
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

const secrets = {};
const accounts = list(s.allowed_accounts);
if (accounts.length === 0 || !accounts.every((a) => /^[^@\s:,]+@[^@\s:,]+\.[^@\s:,]+$/.test(a))) fail('connector.local.json: allowed_accounts must list Google account emails.');
if (!/^[A-Za-z0-9_-]{10,}$/.test(s.folder_id ?? '')) fail('connector.local.json: folder_id must be a Drive folder id (the part after /folders/ in its link).');
secrets.ALLOWED_ACCOUNTS = accounts.join(',');
secrets.FOLDER_ID = s.folder_id;
if (s.time_zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: s.time_zone });
  } catch {
    fail('connector.local.json: time_zone is not an IANA time zone (such as Europe/Paris).');
  }
  secrets.TIME_ZONE = s.time_zone;
}
if (s.assistants) secrets.ASSISTANTS = list(s.assistants).join(',');
if (s.drive_scope) {
  if (!['drive.file', 'drive.readonly'].includes(s.drive_scope)) fail('connector.local.json: drive_scope is drive.file or drive.readonly.');
  secrets.DRIVE_SCOPE = s.drive_scope;
}

if (arg !== '--settings-only') {
  let web;
  try {
    web = JSON.parse(readFileSync(arg, 'utf8')).web;
  } catch {
    fail(`${arg} is not Google's client JSON.`);
  }
  if (!web?.client_id || !web?.client_secret) fail(`${arg} holds no Web client (a "web" object with client_id and client_secret).`);
  const callback = s.worker_url ? `${s.worker_url.replace(/\/$/, '')}/google/callback` : null;
  if (callback && !(web.redirect_uris ?? []).includes(callback)) fail(`The client's redirect URIs do not include ${callback}: add it in Google's console first.`);
  secrets.GOOGLE_CLIENT_ID = web.client_id;
  secrets.GOOGLE_CLIENT_SECRET = web.client_secret;
}

console.log(`Setting ${Object.keys(secrets).join(', ')} on the Worker.`);
wrangler(['secret', 'bulk'], { input: JSON.stringify(secrets) });
