// The invented CDSi supporting data archive of medrec's own tests
// (test/fixtures/schedule/cdsi, medrec's tests/fixtures/schedule at v0.9.12),
// zipped as medrec::testdata::cdsi_archive zips it: its XML under
// "Version 0.1 - 508/XML/", and its release notes, a document whose first date
// is the table's. Its antigens and CVX codes are none CDC has.
// `keepCdsi` keeps it as the `cdsi` table of the medrec that `run` runs.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const FROM = join(import.meta.dirname, '../test/fixtures/schedule/cdsi');
const AT = 'Version 0.1 - 508';
const XML = ['ScheduleSupportingData.xml', 'AntigenSupportingData- Examplitis.xml', 'AntigenSupportingData- Samplepox A.xml', 'AntigenSupportingData- Samplepox B.xml', 'AntigenSupportingData- Samplepox C.xml'];

/** A zip of these files, deflated, each dated as given. */
function zipOf(files) {
  const local = [];
  const central = [];
  let at = 0;
  for (const { name, data, day: [y, m, d] } of files) {
    const packed = deflateRawSync(data, { level: 9 });
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(((y - 1980) << 9) | (m << 5) | d, 12);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(((y - 1980) << 9) | (m << 5) | d, 14);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(at, 42);
    local.push(head, n, packed);
    central.push(entry, n);
    at += head.length + n.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, dir, end]);
}

export function cdsiArchive() {
  const notes = zipOf([{ name: 'word/document.xml', data: readFileSync(join(FROM, 'document.xml')), day: [2026, 9, 8] }]);
  const files = XML.map((n) => ({ name: `${AT}/XML/${n}`, data: readFileSync(join(FROM, n)), day: [2026, 9, 1] }));
  return zipOf([...files, { name: `${AT}/Release Notes.docx`, data: notes, day: [2026, 9, 1] }]);
}

/** Keeps the archive, written to `zip`, as the medrec's `cdsi` table: it is not the recorded file, so on the word of its SHA-256. */
export function keepCdsi(run, zip) {
  const bytes = cdsiArchive();
  writeFileSync(zip, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  run('tables', 'fetch', 'cdsi', '--file', zip, '--accept', sha, '--json');
  return sha;
}
