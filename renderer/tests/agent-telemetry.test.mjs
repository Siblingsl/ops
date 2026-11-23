import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AGENT_TELEMETRY_EVENTS, agentTelemetryPayload, isAgentTelemetryEvent } from '../lib/agent-telemetry.ts'

test('OT-04 埋点白名单只含约定事件与安全目标类型', () => {
  assert.deepEqual([...AGENT_TELEMETRY_EVENTS].sort(), [
    'agent_browser_mode',
    'agent_command_run',
    'agent_panel_open',
    'agent_panel_tab',
    'agent_review_execute',
    'agent_review_open',
  ])
  assert.equal(isAgentTelemetryEvent('agent_panel_open'), true)
  assert.equal(isAgentTelemetryEvent('prompt'), false)
  assert.equal(agentTelemetryPayload('agent_panel_tab', 'context')?.events[0].event, 'agent_panel_tab')
  assert.equal(agentTelemetryPayload('agent_panel_tab', '含正文的目标'), null)
  assert.equal(agentTelemetryPayload('unknown_event', 'panel'), null)
})

test('OT-04 埋点接线不携带消息或提示词正文', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const agent = readFileSync(root + 'pages/Agent.tsx', 'utf8')
  const workbench = readFileSync(root + 'pages/agent/Workbench.tsx', 'utf8')
  const cards = readFileSync(root + 'pages/agent/ActionCards.tsx', 'utf8')
  assert.match(agent, /trackAgentEvent\('agent_panel_open'/)
  assert.match(agent, /trackAgentEvent\('agent_panel_tab'/)
  assert.match(agent, /trackAgentEvent\('agent_command_run'/)
  assert.match(agent, /trackAgentEvent\('agent_review_open'/)
  assert.match(workbench, /trackAgentEvent\('agent_browser_mode'/)
  assert.match(cards, /trackAgentEvent\('agent_review_execute'/)
  for (const src of [agent, workbench, cards]) {
    assert.equal(/trackAgentEvent\([^)]*(prompt|text|message|content)/i.test(src), false, '埋点参数不得带正文变量')
  }
})
