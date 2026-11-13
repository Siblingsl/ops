import { expect, test, type Page } from '@playwright/test'
import type { AgentAction } from '../lib/agent'

const computerAction: AgentAction = {
  id: 'action-fixture',
  run_id: 'run-fixture',
  tool_name: 'computer_command',
  title: '在 Notepad 中输入「卡片确认写入」',
  kind: 'W',
  gate: '',
  second_confirm: null,
  status: 'pending',
  target: { type: 'computer', id: 'target-fixture', name: '无标题 - 记事本', link: '' },
  changes: [{ field: 'target_window', label: '目标窗口', before: '', after: '无标题 - 记事本', editable: false, blank: false }],
  notices: [],
  ai_cost: false,
  need: null,
  result_summary: '',
  error: null,
  last_error: null,
  expires_at: '2099-01-01T00:00:00Z',
  batch_id: 'batch-fixture',
  created_at: '2026-11-13T00:00:00Z',
  editable_fields: [],
  blank_fields: [],
  computer_execution: {
    grant_id: 'grant-fixture',
    generation: 3,
    action_kind: 'type',
    payload: { value: '卡片确认写入' },
    target_ref: 'ref-fixture',
    target_summary: '无标题 - 记事本',
    approval_hash: 'approval-fixture',
  },
}

async function mountComputerCard(page: Page) {
  let commandBody: Record<string, unknown> | null = null

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith('/agent/bootstrap')) {
      return route.fulfill({ json: { features: { event_resume: false } } })
    }
    if (url.pathname.endsWith('/agent/computer/commands') && method === 'POST') {
      commandBody = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ json: { state: 'queued' } })
    }
    return route.fulfill({ status: 404, json: { error: `unexpected ${method} ${url.pathname}` } })
  })

  // 用真实 AgentActionCards 组件，只替换入口；不复制组件实现。
  await page.route('**/main.tsx*', async (route) => {
    const source = await (await route.fetch()).text()
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])
    const dependency = (name: string) => imports.find((path) => path.includes(`/${name}.js`))!
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        import '/styles.css';
        import React from '${dependency('react')}';
        import ReactDOM from '${dependency('react-dom_client')}';
        import { QueryClient, QueryClientProvider } from '${dependency('@tanstack_react-query')}';
        import { BrowserRouter } from '${dependency('react-router-dom')}';
        import { AgentActionCards } from '/pages/agent/ActionCards.tsx';
        const client = new QueryClient();
        function Fixture() {
          return React.createElement(AgentActionCards, {
            actions: [${JSON.stringify(computerAction)}],
            running: false,
            desktopPresentation: true,
            onRefresh: async () => { window.__refreshed = (window.__refreshed || 0) + 1 },
            onContinue: async () => {},
          });
        }
        ReactDOM.createRoot(document.getElementById('root')).render(
          React.createElement(QueryClientProvider, { client },
            React.createElement(BrowserRouter, null, React.createElement(Fixture))),
        );
      `,
    })
  })

  await page.goto('/__computer-command-card')
  await expect(page.getByRole('heading', { name: computerAction.title, exact: true })).toBeVisible()
  await expect(page.locator('.desktop-agent-action-card')).toBeVisible()
  await expect(page.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
  return {
    commandBody: () => commandBody,
  }
}

test('DEV-CU P5-5 桌面电脑命令卡只发一次 /agent/computer/commands 且字段正确', async ({ page }, testInfo) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景只验证本地 renderer E2E')
  const fixture = await mountComputerCard(page)

  await page.getByRole('button', { name: '执行', exact: true }).click()
  await expect.poll(() => fixture.commandBody()).not.toBeNull()
  const body = fixture.commandBody()!
  expect(body.action).toBe('type')
  expect(body.expected_generation).toBe(3)
  expect(body.grant_id).toBe('grant-fixture')
  expect(body.card_id).toBe('action-fixture')
  expect(body.approval_hash).toBe('approval-fixture')
  expect(body.payload).toEqual({ value: '卡片确认写入' })
  expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/i)
  await expect(page.locator('.desktop-agent-action-card').getByText('执行中', { exact: true })).toBeVisible()
  await expect.poll(() => (page.evaluate(() => (window as unknown as { __refreshed?: number }).__refreshed ?? 0))).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('desktop-computer-card.png'), fullPage: true })
})
