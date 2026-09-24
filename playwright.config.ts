import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const PORT = 4100;
// Absolute, because npm workspace scripts run from server/.
const DATA = resolve('e2e/.data');

/**
 * Browser smoke tests against the production build with the demo seed data.
 * Run `npm run build` first; `npm run test:e2e` starts the server itself.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : undefined,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `SOFTEX_DATA_DIR=${DATA} npm run seed -- --reset && SOFTEX_DATA_DIR=${DATA} PORT=${PORT} npm start`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
