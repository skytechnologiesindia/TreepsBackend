import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The real-Postgres smoke test has its own command (npm run e2e:rider).
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
    // Booting the real application under load can pass the 5 s default. A longer limit removes
    // that flakiness without hiding real failures. No retries: they would hide real bugs.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
