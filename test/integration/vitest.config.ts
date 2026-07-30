import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Separate config for the real-IMAP-server suite (see e2e.test.ts). Kept out
// of the root vitest.config.ts's include/exclude entirely so `npm test`
// never needs Docker: this file is only loaded by `npm run test:integration`.

// `include` below is written relative to the project root, but Vitest's
// `root` otherwise defaults to the current working directory, not this
// config file's directory. Pin it explicitly so `npm run test:integration`
// resolves the same file set regardless of the shell's cwd; without this, a
// wrong cwd makes the glob match zero files and the suite exits "passed"
// having run nothing.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  test: {
    root: projectRoot,
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 40_000,
  },
});
