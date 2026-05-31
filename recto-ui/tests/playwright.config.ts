import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  // Seeds the eikiyo@recto.so fixture user + a site + a couple of pages + a
  // candidate so the persona-sim specs (daniel-sim insertion view) have data
  // to act against. Without this they fall through past test.skip and fail
  // on "no orphan found".
  globalSetup: './specs/helpers/global-setup.ts',
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8765',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
});
