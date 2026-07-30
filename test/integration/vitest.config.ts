import { defineConfig } from 'vitest/config';

// Separate config for the real-IMAP-server suite (see e2e.test.ts). Kept out
// of the root vitest.config.ts's include/exclude entirely so `npm test`
// never needs Docker: this file is only loaded by `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 40_000,
  },
});
