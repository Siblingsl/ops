import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

const mockBase = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'
const price = {
  input_price_micros_per_1k: 500000,
  output_price_micros_per_1k: 1000000,
  price_currency: 'CNY',
}

async function prepareDesktopAgent(page: Page) {
  await registerAccount(page, '长图文', 'wechat_mp', `a8-cost-desktop-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A8 成本账桌面模型', base_url: mockBase, api_key: 'local-e2e-key', models: ['mock-agent-writing'],
    ...price,
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    { task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-writing' },
    { task_type: 'default', provider_id: provider.id, model: 'mock-agent-writing' },
  ])
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  return provider.id as string
}

test('REF41 A8 桌面：单 run 成本落库，设置用量页智能体成本可查', async ({ page }) => {
  const providerId = await prepareDesktopAgent(page)
  await page.getByPlaceholder(/发送消息/).fill('A8 桌面成本账验收：请用一句话确认收到')
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationId = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).active_run).toBeNull()

  const detail = await api(page, 'GET', `/agent/conversations/${conversationId}`) as {
    last_run: { id: string; cost_micros: number | null; cost_currency: string; prompt_tokens: number }
  }
  expect(detail.last_run.cost_micros).toBeGreaterThan(0)
  expect(detail.last_run.cost_currency).toBe('CNY')
  expect(detail.last_run.prompt_tokens).toBeGreaterThan(0)
  await expect(page.getByTestId('agent-run-cost')).toContainText('费用')

  // 清空单价后再跑一次：这一 run 记 NULL，页面如实显示“未配置价格”；旧 run 的历史费用保留。
  await api(page, 'PATCH', `/model-providers/${providerId}`, {
    input_price_micros_per_1k: -1, output_price_micros_per_1k: -1, price_currency: 'CNY',
  })
  await page.getByPlaceholder(/发送消息/).fill('A8 桌面无价 run 验收：请用一句话确认收到')
  const unpricedResponse = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await unpricedResponse).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const unpricedConversationId = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${unpricedConversationId}`)).active_run).toBeNull()
  const unpricedDetail = await api(page, 'GET', `/agent/conversations/${unpricedConversationId}`) as {
    last_run: { id: string; cost_micros: number | null }
  }
  expect(unpricedDetail.last_run.cost_micros).toBeNull()
  const unpricedRunCost = await api(page, 'GET', `/agent-runs/${unpricedDetail.last_run.id}/cost`) as { cost_micros: number | null; unpriced: boolean }
  expect(unpricedRunCost.cost_micros).toBeNull()
  expect(unpricedRunCost.unpriced).toBe(true)
  await expect(page.getByTestId('agent-run-cost')).toContainText('未配置价格')

  await page.goto('/settings/usage')
  await page.getByRole('button', { name: '智能体成本', exact: true }).click()
  await expect(page.getByTestId('agent-cost')).toBeVisible()
  await expect(page.getByTestId('agent-cost-unpriced')).toContainText('1')
  await expect(page.getByTestId('agent-cost-row')).toHaveCount(1)
  await expect(page.getByTestId('agent-cost-row').first()).toContainText('¥')
  await expect(page.getByTestId('agent-cost-row').first()).toContainText('1')

  const cost = await api(page, 'GET', '/usage/agent-cost?group_by=model') as {
    rows: { key: string; cost_micros: number | null; currency: string; unpriced_runs: number }[]
  }
  expect(cost.rows.some((row) => row.cost_micros != null && row.cost_micros > 0 && row.currency === 'CNY')).toBe(true)
  expect(cost.rows.some((row) => row.unpriced_runs === 1)).toBe(true)
  mkdirSync(resolve(process.cwd(), '../.playwright-results/desktop-renderer'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/desktop-renderer/a8-agent-cost.png'), fullPage: true })
  mkdirSync(resolve(process.cwd(), '../docs/41-evidence/screenshots'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../docs/41-evidence/screenshots/A8-desktop-agent-cost.png'), fullPage: true })
})

test('REF41 A8 桌面：用量页 500 显示加载失败并可重试', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp', `a8-cost-desktop-error-${Date.now()}`)
  await page.goto('/settings/usage')
  const route = '**/api/v1/usage/agent-cost*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 A8 桌面用量读取失败' } }),
  }))
  await page.getByRole('button', { name: '智能体成本', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('加载失败')
  await expect(alert).toContainText('C 类 A8 桌面用量读取失败')
  const retry = alert.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  await page.unroute(route)
  await retry.click()
  await expect(page.getByTestId('agent-cost')).toBeVisible()
})
