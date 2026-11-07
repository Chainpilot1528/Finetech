import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { include: ['src/modules/identity/domain/**'] },
  },
});
