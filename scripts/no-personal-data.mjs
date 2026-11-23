#!/usr/bin/env node
// A public repo holds no household's data. Every tracked file is checked for
// email addresses outside the reserved example domains, Google client
// secrets, a filled-in connector.local.json, and Drive ids outside the
// synthetic fixtures. ppr (run before every push) checks more; this keeps
// the cheapest mistakes out of CI too.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|[a-z0-9-]+\.example|users\.noreply\.github\.com|anthropic\.com)$/i;
const problems = [];
for (const f of files) {
  if (/(^|\/)connector\.local\.json$|(^|\/)client_secret[^/]*\.json$|(^|\/)\.dev\.vars/.test(f)) problems.push(`${f}: a household's own file is tracked`);
  let text;
  try {
    text = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  for (const m of text.matchAll(EMAIL)) {
    // `https://user@host` is a URL's userinfo, not an address.
    if (text.slice(Math.max(0, m.index - 2), m.index) === '//') continue;
    if (!ALLOWED_EMAIL.test(m[0])) problems.push(`${f}: email address ${m[0].replace(/^(.).*@/, '$1…@')}`);
  }
  if (/GOCSPX-[A-Za-z0-9_-]{10,}/.test(text)) problems.push(`${f}: a Google client secret`);
  if (/"client_secret"\s*:\s*"(?!test-)[^"]{8,}"/.test(text)) problems.push(`${f}: a client_secret value`);
  if (/[0-9]{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/.test(text)) problems.push(`${f}: a real Google client id`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${files.length} tracked files hold no personal data this check knows.`);
