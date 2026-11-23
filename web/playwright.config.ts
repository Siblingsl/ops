import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Playwright 在 Windows 上用 `taskkill /T /F` 回收 webServer 进程树。
// 宿主若裁剪过 PATH（例如 Agent 沙箱），cmd 能找到（ComSpec），taskkill 却找不到，
// 表现为用例结束后 runner 一直等 webServer 退出。显式补回系统目录。
function ensureWindowsSystemPath() {
  if (process.platform !== 'win32') return
  const root = process.env.SystemRoot || 'C:\\Windows'
  const required = [path.join(root, 'System32'), path.join(root, 'System32', 'Wbem')]
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const missing = required.filter((entry) => !current.some((item) => item.toLowerCase() === entry.toLowerCase()))
  if (missing.length) process.env.PATH = [...missing, ...current].join(path.delimiter)
}
ensureWindowsSystemPath()

// 生产打包验收只允许专用本地 Compose；不连接真实部署或复用日常服务。
const production = process.env.OPS_E2E_PROD === '1'
// 本机若设置了 HTTP_PROXY 而未排除回环地址，webServer 健康检查会被代理接管并返回 404，
// 表现为「服务已起但 Playwright 一直等到超时」。这里显式放行回环。
if (!process.env.NO_PROXY) process.env.NO_PROXY = '127.0.0.1,localhost,::1'
if (!process.env.no_proxy) process.env.no_proxy = process.env.NO_PROXY
process.env.OPS_E2E_MOCK_BASE_URL ??= production ? 'http://mock:8191/v1' : 'http://127.0.0.1:8191/v1'

export default defineConfig({
  outputDir: '../.playwright-results/web',
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../.playwright-results/web-report' }]],
  use: { baseURL: production ? 'http://127.0.0.1:44538' : 'http://127.0.0.1:5179', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: production ? undefined : [
    {
      command: 'go run ./cmd/ops-e2e', cwd: '../server', url: 'http://127.0.0.1:8180/healthz',
      env: {
        OPS_AGENT_WORKBENCH_FEATURES: 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,agent_roles,document_parse,personal_memories,workflow_templates',
        OPS_E2E_CRAWL_MODE: 'allow',
        OPS_DOCUMENT_PARSER_SOCKETS: process.env.OPS_DOCUMENT_PARSER_SOCKETS ?? '',
      },
      reuseExistingServer: !process.env.CI, timeout: 120_000,
    },
    { command: 'pnpm dev --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179', env: { OPS_API_TARGET: 'http://127.0.0.1:8180' }, reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
})
