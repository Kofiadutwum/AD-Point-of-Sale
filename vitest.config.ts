import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // the real server-only package throws outside React Server Components
    alias: { 'server-only': fileURLToPath(new URL('./tests/helpers/empty.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // PGlite start-up plus argon2 hashing; the first beforeEach of each file also migrates the template database
    testTimeout: 30000,
    hookTimeout: 60000,
    // each file runs its own PGlite database; more workers than half the cores starve them and tests time out
    maxWorkers: 4,
  },
});
