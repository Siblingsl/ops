import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const webServers = Array.isArray(base.webServer) ? base.webServer : []

export default defineConfig({
  ...base,
  webServer: webServers.map(server => server.command.includes('ops-e2e')
    ? {
        ...server,
        env: {
          ...server.env,
          OPS_AGENT_WORKBENCH_FEATURES: 'workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines',
        },
      }
    : server),
})
