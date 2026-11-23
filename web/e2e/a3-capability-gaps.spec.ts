import { expect, test, type Page } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

const capabilityGap = {
  gap_key: 'bulk-export-works',
  title: '缺少批量导出作品能力',
  detail: '用户希望一次导出 100 篇作品的正文与指标',
  need: '按筛选条件批量导出 CSV',
  workaround: '逐篇复制正文并手工汇总',
}

async function prepareAgent(page: Page) {
  await registerAccount(page, '长图文', 'wechat_mp', `a3-gap-web-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A3 能力缺口浏览器模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-agent-writing'],
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
}

async function sendGapTool(page: Page) {
  await page.getByPlaceholder(/发送消息/).fill(`请记录这个能力缺口\n#tool report_capability_gap ${JSON.stringify(capabilityGap)}`)
  const response = page.waitForResponse((r) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  return id
}

test('REF41 A3 Web：工具记录能力缺口后，所有者设置页可见并标记计划', async ({ page }) => {
  await prepareAgent(page)
  await sendGapTool(page)

  await page.goto('/settings/agent')
  const card = page.getByTestId('capability-gaps')
  await expect(card).toBeVisible()
  const row = card.getByTestId('capability-gap-row').filter({ hasText: capabilityGap.title })
  await expect(row).toBeVisible()
  await expect(row).toContainText('待评估')
  await expect(row).toContainText('请求 1 次')
  await expect(row).toContainText('按筛选条件批量导出 CSV')

  const planned = page.waitForResponse((r) => /\/agent-capability-gaps\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'PATCH')
  await row.getByRole('button', { name: '标记为已计划', exact: true }).click()
  expect((await planned).ok()).toBeTruthy()
  await expect(row).toContainText('已计划')

  const gaps = await api(page, 'GET', '/agent-capability-gaps') as { gaps: Array<{ gap_key: string; status: string; request_count: number }> }
  const saved = gaps.gaps.find((gap) => gap.gap_key === capabilityGap.gap_key)
  expect(saved).toMatchObject({ status: 'planned', request_count: 1 })
  await page.screenshot({ path: '../.playwright-results/web/a3-capability-gaps.png', fullPage: true })
})

test('REF41 A3 Web：能力缺口 500 可重试，PATCH 404 显示错误', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'A3 异常分支使用本地 API 拦截')
  await prepareAgent(page)
  await sendGapTool(page)
  const listRoute = '**/api/v1/agent-capability-gaps*'
  await page.route(listRoute, (r) => r.request().method() === 'GET'
    ? r.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 A3 能力缺口读取失败' } }),
      })
    : r.continue())
  await page.goto('/settings/agent')
  const card = page.getByTestId('capability-gaps')
  await expect(card).toContainText('加载失败：C 类 A3 能力缺口读取失败')
  await page.unroute(listRoute)
  await card.getByRole('button', { name: '重试', exact: true }).click()
  const row = card.getByTestId('capability-gap-row').filter({ hasText: capabilityGap.title })
  await expect(row).toBeVisible()

  const patchRoute = '**/api/v1/agent-capability-gaps/*'
  await page.route(patchRoute, (r) => r.fulfill({
    status: 404, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'not_found', message: 'C 类 A3 缺口状态更新失败' } }),
  }))
  await row.getByRole('button', { name: '标记为已计划', exact: true }).click()
  await expect(page.getByText('C 类 A3 缺口状态更新失败')).toBeVisible()
})
