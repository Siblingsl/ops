import { defineConfig, devices } from '@playwright/test'

// 只加载真实卡片组件并拦截其 HTTP 请求，不需要数据库、模拟模型或 API 服务。
export default defineConfig({
  testDir: './e2e',
  testMatch: 'agent-cards.spec.ts',
  timeout: 30_000,
  expect: { timeout: 5000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5181', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5181 --strictPort',
    url: 'http://127.0.0.1:5181',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
