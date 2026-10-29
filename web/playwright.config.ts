import { defineConfig, devices } from '@playwright/test'

// 生产打包验收只允许专用本地 Compose；不连接真实部署或复用日常服务。
const production = process.env.OPS_E2E_PROD === '1'
// 本机若设置了 HTTP_PROXY 而未排除回环地址，webServer 健康检查会被代理接管并返回 404，
// 表现为「服务已起但 Playwright 一直等到超时」。这里显式放行回环。
if (!process.env.NO_PROXY) process.env.NO_PROXY = '127.0.0.1,localhost,::1'
if (!process.env.no_proxy) process.env.no_proxy = process.env.NO_PROXY
process.env.OPS_E2E_MOCK_BASE_URL ??= 'http://127.0.0.1:8191/v1'

export default defineConfig({
  outputDir: '../.playwright-results/web',
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../.playwright-results/report' }]],
  use: { baseURL: production ? 'http://127.0.0.1:44538' : 'http://127.0.0.1:5179', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: production ? undefined : [
    {
      command: 'go run ./cmd/ops-e2e', cwd: '../server', url: 'http://127.0.0.1:8180/healthz',
      env: {
        OPS_AGENT_WORKBENCH_FEATURES: 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse',
        OPS_DOCUMENT_PARSER_SOCKETS: process.env.OPS_DOCUMENT_PARSER_SOCKETS ?? '',
      },
      reuseExistingServer: !process.env.CI, timeout: 120_000,
    },
    { command: 'pnpm dev --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179', env: { OPS_API_TARGET: 'http://127.0.0.1:8180' }, reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
})
