import { defineConfig } from '@playwright/test';

/**
 * Runs against the local stack: `pnpm db`, `pnpm seed`, `pnpm dev` (or a production build with
 * `next start`). Slow machines and CI can stretch every wait without editing tests (DX-04):
 *   E2E_TIMEOUT_MS  per test (default 60 s; tests marked slow get three times this)
 *   E2E_EXPECT_MS   per check (default 5 s)
 *   E2E_BASE_URL    where the app is (default http://localhost:3000)
 *   E2E_CHANNEL     browser channel (default chrome; empty uses Playwright's own Chromium)
 */
const timeout = Number(process.env.E2E_TIMEOUT_MS ?? 60_000);
const expectTimeout = Number(process.env.E2E_EXPECT_MS ?? 5_000);
const channel = process.env.E2E_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout,
  expect: { timeout: expectTimeout },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    ...(channel ? { channel } : {}),
    headless: true,
    screenshot: 'only-on-failure',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    actionTimeout: expectTimeout * 2,
  },
});
