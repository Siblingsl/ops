import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const servers = Array.isArray(base.webServer) ? base.webServer : []
if (servers.length !== 2) throw new Error('AW12 仅使用仓库本地隔离测试服务')

export default defineConfig({
  ...base,
  testMatch: 'agent-workbench-aw12-layout.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5281' },
  webServer: [
    {
      ...servers[0], url: 'http://127.0.0.1:8281/healthz', reuseExistingServer: false,
      env: { ...servers[0].env, OPS_E2E_LISTEN: '127.0.0.1:8281', OPS_E2E_MOCK_LISTEN: '127.0.0.1:8292',
        OPS_AGENT_WORKBENCH_FEATURES: 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse' },
    },
    {
      ...servers[1], command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5281 --strictPort',
      url: 'http://127.0.0.1:5281', reuseExistingServer: false,
      env: { ...servers[1].env, OPS_API_TARGET: 'http://127.0.0.1:8281' },
    },
  ],
})
