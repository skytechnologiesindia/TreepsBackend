import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Booting the real application under load can pass the 5 s default. A longer limit removes
    // that flakiness without hiding real failures. No retries: they would hide real bugs.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
