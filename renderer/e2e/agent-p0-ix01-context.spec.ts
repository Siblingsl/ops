import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-01（DEV-AI-39）：@ 候选按 Enter 只选择不发送，选中后写筹码，发送 payload 带真实 context_refs。
test('DEV-AI-39 IX-01 引用候选选择、Enter 不发送与 payload 引用', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-01 验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '城市更新观察' }) as { id: string; title: string }
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, id: account.id,
  })

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  let messagePosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/agent\/conversations\/[^/]+\/messages$/.test(request.url())) messagePosts += 1
  })

  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill('@城市')
  const candidates = page.locator('.agent-composer-candidates')
  await expect(candidates).toBeVisible()
  const option = candidates.getByRole('option', { name: /城市更新观察/ })
  await expect(option).toBeVisible({ timeout: 15_000 })
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
  await expect(candidates).toBeHidden()
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: '移除引用 城市更新观察' })).toBeVisible()
  await expect(page.getByText('本轮引用', { exact: true })).toBeVisible()
  expect(messagePosts).toBe(0)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ix01-context.png') })

  let payload: Record<string, unknown> | null = null
  await page.route(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/, async (route) => {
    payload = route.request().postDataJSON()
    await route.abort()
  })
  await composer.press('Enter')
  await expect.poll(() => payload).not.toBeNull()
  expect(payload!.context_refs).toEqual([expect.objectContaining({ type: 'work', id: work.id, scope: 'turn' })])
})
