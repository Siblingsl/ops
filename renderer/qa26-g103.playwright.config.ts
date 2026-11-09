import { defineConfig, devices } from '@playwright/test'

process.env.OPS_QA26_G103_SETUP = '1'

export default defineConfig({
  testDir: './e2e',
  outputDir: '../.playwright-results/qa26-g103-desktop',
  testMatch: ['g1-setup.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5288', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{
    name: 'desktop-windows-electron',
    testMatch: ['g1-setup.spec.ts'],
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
  }],
})
