import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': join(import.meta.dirname, 'test/cloudflare-workers.ts') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Dates in the views are the household's, never the machine's.
    env: { TZ: 'UTC' },
    // Some tests copy a large family's folder, which takes over 5 s on a busy machine.
    testTimeout: 30_000,
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
