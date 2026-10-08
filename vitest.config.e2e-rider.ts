import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// The real-Postgres rider smoke test only (npm run e2e:rider). RUN_E2E_PG=1 is set here, so the spec
// can never run by accident from the normal unit run or from `npm run test:e2e`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/e2e/rider-smoke.e2e-spec.ts'],
    env: { RUN_E2E_PG: '1' },
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
