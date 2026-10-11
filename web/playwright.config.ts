import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5179', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: [
    { command: 'go run ./cmd/ops-e2e', cwd: '../server', url: 'http://127.0.0.1:8180/healthz', reuseExistingServer: false, timeout: 120_000 },
    { command: 'pnpm dev --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179', env: { OPS_API_TARGET: 'http://127.0.0.1:8180' }, reuseExistingServer: false, timeout: 120_000 },
  ],
})
