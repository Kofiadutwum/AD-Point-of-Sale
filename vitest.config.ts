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
    testTimeout: 20000, // PGlite start-up plus argon2 hashing
  },
});
