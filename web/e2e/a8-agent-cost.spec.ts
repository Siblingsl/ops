import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, mockModelBaseUrl, registerAccount } from './support'

const price = {
  input_price_micros_per_1k: 500000,
  output_price_micros_per_1k: 1000000,
  price_currency: 'CNY',
}

async function prepareAgent(page: Page) {
  await registerAccount(page, '长图文', 'wechat_mp', `a8-cost-web-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A8 成本账浏览器模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-agent-writing'],
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

async function sendCostRun(page: Page) {
  await page.getByPlaceholder(/发送消息/).fill('A8 成本账验收：请用一句话确认收到')
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

test('REF41 A8 Web：单 run 成本落库，用量页智能体成本可查', async ({ page }) => {
  const providerId = await prepareAgent(page)
  const conversationId = await sendCostRun(page)

  const detail = await api(page, 'GET', `/agent/conversations/${conversationId}`) as {
    last_run: { id: string; cost_micros: number | null; cost_currency: string; prompt_tokens: number; completion_tokens: number }
  }
  expect(detail.last_run.cost_micros).toBeGreaterThan(0)
  expect(detail.last_run.cost_currency).toBe('CNY')
  expect(detail.last_run.prompt_tokens).toBeGreaterThan(0)

  const runCost = await api(page, 'GET', `/agent-runs/${detail.last_run.id}/cost`) as { cost_micros: number | null; unpriced: boolean; currency: string }
  expect(runCost.cost_micros).toBeGreaterThan(0)
  expect(runCost.unpriced).toBe(false)
  expect(runCost.currency).toBe('CNY')

  await expect(page.getByTestId('agent-run-cost')).toContainText('本轮 token')
  await expect(page.getByTestId('agent-run-cost')).toContainText('费用')
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/web/a8-agent-cost-run.png'), fullPage: true })

  // 清空单价后再跑一次：这一 run 必须记 NULL 并在双端显示“未配置价格”，旧 run 的历史费用仍保留。
  await api(page, 'PATCH', `/model-providers/${providerId}`, {
    input_price_micros_per_1k: -1, output_price_micros_per_1k: -1, price_currency: 'CNY',
  })
  const unpricedConversation = await sendCostRun(page)
  const unpricedDetail = await api(page, 'GET', `/agent/conversations/${unpricedConversation}`) as {
    last_run: { id: string; cost_micros: number | null; cost_currency: string }
  }
  expect(unpricedDetail.last_run.cost_micros).toBeNull()
  const unpricedRunCost = await api(page, 'GET', `/agent-runs/${unpricedDetail.last_run.id}/cost`) as { cost_micros: number | null; unpriced: boolean }
  expect(unpricedRunCost.cost_micros).toBeNull()
  expect(unpricedRunCost.unpriced).toBe(true)
  await expect(page.getByTestId('agent-run-cost')).toContainText('未配置价格')

  const cost = await api(page, 'GET', '/usage/agent-cost?group_by=day') as {
    runs: number; cost_micros: number | null; currency: string; unpriced_runs: number;
    rows: { cost_micros: number | null; unpriced_runs: number }[];
    currencies: { currency: string; cost_micros: number | null; unpriced_runs: number }[]
  }
  expect(cost.runs).toBe(2)
  expect(cost.currency).toBe('CNY')
  expect(cost.cost_micros).toBeGreaterThan(0)
  expect(cost.unpriced_runs).toBe(1)
  expect(cost.rows[0]?.unpriced_runs).toBe(1)
  expect(cost.currencies[0]?.currency).toBe('CNY')
  expect(cost.currencies[0]?.cost_micros).toBeGreaterThan(0)

  await page.goto('/settings/usage')
  await page.getByRole('button', { name: '智能体成本', exact: true }).click()
  await expect(page.getByTestId('agent-cost')).toBeVisible()
  await expect(page.getByTestId('agent-cost-unpriced')).toContainText('未定价 run')
  await expect(page.getByTestId('agent-cost-unpriced')).toContainText('1')
  await expect(page.getByTestId('agent-cost-row')).toHaveCount(1)
  await expect(page.getByTestId('agent-cost-row').first()).toContainText('¥')
  await expect(page.getByTestId('agent-cost-row').first()).toContainText('1')
  mkdirSync(resolve(process.cwd(), '../docs/41-evidence/screenshots'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../docs/41-evidence/screenshots/A8-web-agent-cost.png'), fullPage: true })
})

test('REF41 A8 Web：用量页 500 显示加载失败并可重试', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp', `a8-cost-web-error-${Date.now()}`)
  await page.goto('/settings/usage')
  const route = '**/api/v1/usage/agent-cost*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 A8 用量读取失败' } }),
  }))
  await page.getByRole('button', { name: '智能体成本', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('加载失败')
  await expect(alert).toContainText('C 类 A8 用量读取失败')
  // 查询失败会按指数退避自动重试；等本轮自动重试结束、按钮恢复可用后再手动重试。
  const retry = alert.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeEnabled()
  await page.unroute(route)
  await retry.click()
  await expect(page.getByTestId('agent-cost')).toBeVisible()
})
