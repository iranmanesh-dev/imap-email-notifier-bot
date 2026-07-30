import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests need a real IMAP/SMTP server (see test/integration/)
    // and must never run as part of the default, Docker-free `npm test`.
    // They have their own config and script: `npm run test:integration`.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    testTimeout: 20_000,
  },
});
