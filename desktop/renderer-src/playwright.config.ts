import { defineConfig, devices } from '@playwright/test'

// 本机 HTTP_PROXY 会接管回环健康检查并返回 404，webServer 会一直等到超时。
// 桌面用例全部走 127.0.0.1，显式放行回环。
if (!process.env.NO_PROXY) process.env.NO_PROXY = '127.0.0.1,localhost,::1'
if (!process.env.no_proxy) process.env.no_proxy = process.env.NO_PROXY

// IDE / Agent 宿主常注入 ELECTRON_RUN_AS_NODE=1（它自己就跑在 Electron 里）。
// 该变量会让 electron.exe 退化为 Node 解释器，`--user-data-dir`、`--remote-debugging-port`
// 等 GUI 参数被当成坏选项，报 "bad option" 后退出码 9，真实窗口用例全部无法启动。
// 桌面 e2e 必须启动真正的客户端窗口，因此在加载配置时清除它。
delete process.env.ELECTRON_RUN_AS_NODE
process.env.OPS_E2E_MOCK_BASE_URL = 'http://127.0.0.1:8297/v1'

const desktopOnly = [
  'desktop-images-restoration.spec.ts',
  'desktop-creative-ui.spec.ts',
  'desktop-editor-restoration.spec.ts',
  'desktop-dashboard-restoration.spec.ts',
  'desktop-ops-restoration.spec.ts',
  'desktop-agent-restoration.spec.ts',
  'desktop-materials-restoration.spec.ts',
  'desktop-review-restoration.spec.ts',
  'd122-preferences-electron.spec.ts',
  'desktop-toutiao-stats.spec.ts',
  'desktop-creative-restoration.spec.ts',
  'platform-sync-echo.spec.ts',
  'd126-unified-settings.spec.ts',
  'd126-settings-electron.spec.ts',
  'd131-platform-login-entry.spec.ts',
  'd132-current-account-settings.spec.ts',
  'd133-platform-account-sync-ui.spec.ts',
  'd148-platform-metrics-refresh-resume-ui.spec.ts',
  'platform-sync-details.spec.ts',
  'pb12-platform-partial-coverage.spec.ts',
  'st08-sensitive-word-undo.spec.ts',
  'toutiao-preview.spec.ts',
  'toutiao-ui.spec.ts',
]

const sharedScenarios = [
  'agent-workbench.spec.ts',
  'agent-workbench-aw08.spec.ts',
  'agent-workbench-aw12-layout.spec.ts',
  'agent-documents.spec.ts',
  'agent-events.spec.ts',
  'agent-goals.spec.ts',
  'agent-modes.spec.ts',
  'agent-plans-questions.spec.ts',
  'agent-routines.spec.ts',
  'd122-ui-layout.spec.ts',
  'd123-ui-alignment.spec.ts',
  'skills-boundaries.spec.ts',
  'toutiao-completion.spec.ts',
]

const apiFeatures = 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse'

export default defineConfig({
  outputDir: '../../.playwright-results/desktop-renderer',
  // 桌面 renderer 只加载自己的用例目录，不再借用 Web 用例目录。
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../.playwright-results/desktop-renderer-report' }]],
  use: { baseURL: 'http://127.0.0.1:5287', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'desktop-renderer',
      testMatch: desktopOnly,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'desktop-renderer-shared-scenarios',
      testMatch: sharedScenarios,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'desktop-windows-electron',
      testMatch: [
        'desktop-window-drag.spec.ts', 'platform-intents-real-electron.local.spec.ts',
        'skills-electron.spec.ts', 'toutiao-electron.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: [
    {
      command: 'go run ./cmd/ops-e2e',
      cwd: '../../server',
      url: 'http://127.0.0.1:8287/healthz',
      env: {
        OPS_AGENT_WORKBENCH_FEATURES: apiFeatures,
        OPS_DOCUMENT_PARSER_SOCKETS: process.env.OPS_DOCUMENT_PARSER_SOCKETS ?? '',
        OPS_E2E_LISTEN: '127.0.0.1:8287',
        OPS_E2E_MOCK_LISTEN: '127.0.0.1:8297',
        OPS_E2E_DESKTOP_AI_ENABLED: '1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 5287 --strictPort',
      cwd: '.',
      url: 'http://127.0.0.1:5287',
      env: { OPS_API_TARGET: 'http://127.0.0.1:8287' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
