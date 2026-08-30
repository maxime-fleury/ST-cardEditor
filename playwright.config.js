import { defineConfig } from '@playwright/test';

// E2E smoke suite for the ST Card Editor. Covers the regression classes found
// across the first three bug hunts so they can never silently ship again.
//
// Locally: uses the installed Google Chrome (no browser download needed).
// In CI:   falls back to the bundled Chromium, installed by the workflow.
export default defineConfig({
  testDir: './tests',
  // The unit tests under tests/unit are Bun unit tests (bun:test) and must not
  // run in the browser suite.
  testIgnore: ['**/unit/**'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8182',
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run server.js',
    url: 'http://localhost:8182',
    // The ambient shell can export PORT=0 (random port); force the port the
    // suite expects so the server is findable at all.
    env: { ...process.env, PORT: '8182' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
