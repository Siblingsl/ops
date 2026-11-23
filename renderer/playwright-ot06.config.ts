import { defineConfig, devices } from '@playwright/test'

// OT-06 专用：只关 workbench_ui，其余子能力仍开，验证页面回到旧形态且无报错。
const featuresWithoutWorkbenchUI = 'conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse,chrome_connect,browser_workspace,plugin_mcp,personal_memories'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['agent-ot06-old-ui.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5288', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-windows-electron-ot06', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: [
    {
      command: 'go run ./cmd/ops-e2e',
      cwd: '../server',
      url: 'http://127.0.0.1:8288/healthz',
      env: {
        OPS_AGENT_WORKBENCH_FEATURES: featuresWithoutWorkbenchUI,
        OPS_DOCUMENT_PARSER_SOCKETS: process.env.OPS_DOCUMENT_PARSER_SOCKETS ?? '',
        OPS_E2E_LISTEN: '127.0.0.1:8288',
        OPS_E2E_MOCK_LISTEN: '127.0.0.1:8298',
        OPS_E2E_DESKTOP_AI_ENABLED: '1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 5288 --strictPort',
      cwd: '.',
      url: 'http://127.0.0.1:5288',
      env: { OPS_API_TARGET: 'http://127.0.0.1:8288' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
