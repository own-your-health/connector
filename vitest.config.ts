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
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
