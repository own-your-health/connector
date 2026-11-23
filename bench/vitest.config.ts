import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// CPU measurements in Node (bench/*.cpu.ts), apart from the tests.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': join(import.meta.dirname, '../test/cloudflare-workers.ts') } },
  test: { include: ['bench/**/*.cpu.ts'], pool: 'forks', testTimeout: 600_000, env: { TZ: 'UTC' }, server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
});
