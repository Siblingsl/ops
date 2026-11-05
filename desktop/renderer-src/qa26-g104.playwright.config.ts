import { defineConfig, devices } from '@playwright/test'

if (!process.env.NO_PROXY) process.env.NO_PROXY = '127.0.0.1,localhost,::1'
if (!process.env.no_proxy) process.env.no_proxy = process.env.NO_PROXY
delete process.env.ELECTRON_RUN_AS_NODE
process.env.OPS_QA26_G104 = '1'

const apiFeatures = 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse'

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../.playwright-results/qa26-g104-electron',
  testMatch: ['g1-public-preview-electron.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5487', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{
    name: 'desktop-windows-electron',
    testMatch: ['g1-public-preview-electron.spec.ts'],
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
  }],
  webServer: [
    {
      command: 'go run ./cmd/ops-e2e',
      cwd: '../../server',
      url: 'http://127.0.0.1:8487/healthz',
      env: {
        OPS_AGENT_WORKBENCH_FEATURES: apiFeatures,
        OPS_DOCUMENT_PARSER_SOCKETS: process.env.OPS_DOCUMENT_PARSER_SOCKETS ?? '',
        OPS_E2E_LISTEN: '127.0.0.1:8487',
        OPS_E2E_MOCK_LISTEN: '127.0.0.1:8497',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 5487 --strictPort',
      cwd: '.',
      url: 'http://127.0.0.1:5487',
      env: { OPS_API_TARGET: 'http://127.0.0.1:8487' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
