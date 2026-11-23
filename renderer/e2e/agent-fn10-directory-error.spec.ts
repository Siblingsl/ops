import { expect, test } from '@playwright/test'
import { api } from './support'

// FN-10 异常门：候选接口真实返回 500 时，480 抽屉只局部失败，保留重试并可恢复真实列表。
test('FN-10 运营目录异常态与重试', async ({ page }) => {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  const username = `fn10-err-${Date.now()}`
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const me = await api(page, 'GET', '/auth/me')
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'FN10 异常验收号', content_format: 'image_note' })
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'FN10 异常验收作品', content_format: 'image_note' })
  const userKey = me.user_id ?? me.username ?? username
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: `ops.currentAccount.v2:${userKey}:${me.workspace.id}`, id: account.id,
  })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN10 异常验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  await page.route('**/api/v1/agent/context-candidates**', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'FN10 真实 500' } }),
  }))
  await page.getByTestId('desktop-agent-add-menu-trigger').click()
  await page.getByTestId('desktop-agent-add-menu-list').getByRole('menuitem', { name: /运营目录/ }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByTestId('agent-operation-directory') })
  await expect(panel.getByRole('button', { name: '重试' })).toBeVisible()
  await expect(panel).toContainText('FN10 真实 500')
  await expect(page.locator('.desktop-agent-compose')).toBeVisible()

  await page.unroute('**/api/v1/agent/context-candidates**')
  await panel.getByRole('button', { name: '重试' }).click()
  await expect(panel.getByRole('button', { name: '引用作品 FN10 异常验收作品', exact: true })).toBeVisible()
})
