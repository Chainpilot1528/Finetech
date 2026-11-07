import { defineConfig } from '@playwright/test';

/** Runs against the local stack: `pnpm db`, `pnpm seed`, `pnpm dev`. */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3000', channel: 'chrome', headless: true, screenshot: 'only-on-failure' },
});
