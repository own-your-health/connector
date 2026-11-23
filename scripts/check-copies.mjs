#!/usr/bin/env node
// The app's Drive client is used as a pinned copy (src/records/app/PIN.json).
// This checks each copy is byte-for-byte what PIN.json records, and with
// --upstream that the pinned commit of own-your-health/app holds the same.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(ROOT, 'src/records/app/PIN.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let bad = 0;
for (const [path, f] of Object.entries(pin.files)) {
  const got = sha(readFileSync(join(ROOT, path)));
  if (got !== f.sha256) {
    console.error(`${path} differs from the copy PIN.json records: copy ${pin.repo}@${pin.commit} ${f.from} again, or update the pin.`);
    bad++;
  }
  if (process.argv.includes('--upstream')) {
    const res = await fetch(`https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${f.from}`);
    if (!res.ok) {
      console.error(`${pin.repo}@${pin.commit} ${f.from}: GitHub answered ${res.status}`);
      bad++;
    } else if (sha(Buffer.from(await res.arrayBuffer())) !== f.sha256) {
      console.error(`${path} is not ${pin.repo}@${pin.commit} ${f.from}.`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`${Object.keys(pin.files).length} pinned copies match ${pin.repo}@${pin.commit.slice(0, 12)}.`);
