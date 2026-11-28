// The versions GET /version gives: this connector's, as package.json has it,
// and the medrec contract it follows, which is the release whose answers it is
// held to (test/golden/medrec.json).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEDREC_CONTRACT, VERSION } from '../src/version';

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', path), 'utf8'));

describe('the versions', () => {
  it("are package.json's version", () => {
    expect(VERSION).toBe(read('package.json').version);
  });

  it("follow the contract of the medrec whose answers the connector is held to", () => {
    expect(MEDREC_CONTRACT).toBe(read('test/golden/medrec.json').medrec_version);
  });
});
