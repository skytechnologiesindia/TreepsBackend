import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // The real-application spec runs in parallel with the HTTP specs and can push them past
    // the 5 s default. A longer limit removes that flakiness without hiding real failures.
    // No retries: they would hide real bugs.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
