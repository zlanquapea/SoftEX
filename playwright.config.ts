import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const PORT = 4100;
// Absolute, because npm workspace scripts run from server/.
const DATA = resolve('e2e/.data');
const SAAS_PORT = 4101;
const SAAS_DATA = resolve('e2e/.data-saas');

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
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /(mobile|saas)\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
    // A second server in hosted (SaaS) mode: plans, trials and billing.
    { name: 'saas', use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${SAAS_PORT}` }, testMatch: /saas\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `SOFTEX_DATA_DIR=${DATA} npm run seed -- --reset && SOFTEX_DATA_DIR=${DATA} PORT=${PORT} npm start`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `rm -rf ${SAAS_DATA} && SOFTEX_DATA_DIR=${SAAS_DATA} SOFTEX_MODE=saas SOFTEX_LRD_PER_USD=190 SOFTEX_PAYMENT_INSTRUCTIONS='Send to Orange Money 0770 000 000' PORT=${SAAS_PORT} npm start`,
      url: `http://localhost:${SAAS_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
