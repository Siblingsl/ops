import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: '../tmpverify/playwright-verify-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5285',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: [
    {
      command: 'go run ./cmd/ops-e2e',
      cwd: '../server',
      url: 'http://127.0.0.1:8285/healthz',
      env: {
        OPS_E2E_LISTEN: '127.0.0.1:8285',
        OPS_E2E_MOCK_LISTEN: '127.0.0.1:8286',
        OPS_E2E_PLATFORM_ENABLED: '1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 5285 --strictPort',
      url: 'http://127.0.0.1:5285',
      env: { OPS_API_TARGET: 'http://127.0.0.1:8285' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
