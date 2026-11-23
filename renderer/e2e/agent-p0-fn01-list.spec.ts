import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-01（DEV-AI-39）：列表投影带待回答数与账号名；“待我处理 / 进行中”
// 都能筛出两个真实待处理会话（每个会话真实提出一个 request_input 问题）。
test('DEV-AI-39 FN-01 两个待处理会话的列表投影与状态筛选', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-01 列表投影验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  const question = {
    questions: [{ id: 'scope', title: '这次先做哪一部分？', required: true, options: [{ id: 'a', label: '标题' }, { id: 'b', label: '正文' }] }],
  }
  const conversations: { id: string; title: string }[] = []
  for (const title of ['FN01 待回答 A', 'FN01 待回答 B']) {
    const conversation = await api(page, 'POST', '/agent/conversations', {
      title, account_id: account.id, model: { provider_id: provider.id, model: 'mock-agent-tested' },
    }) as { id: string }
    await api(page, 'POST', `/agent/conversations/${conversation.id}/messages`, {
      text: `${title}\n#tool request_input ${JSON.stringify(question)}`,
      request_id: randomUUID(), protocol_version: 2,
    })
    conversations.push({ id: conversation.id, title })
  }
  await expect.poll(async () => {
    const list = await api(page, 'GET', '/agent/conversations?state=needs_action') as { items: { id: string; pending_questions: number }[] }
    return list.items.filter((item) => conversations.some((conversation) => conversation.id === item.id) && item.pending_questions === 1).length
  }, { timeout: 30_000 }).toBe(2)

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.goto(`/agent/c/${conversations[0].id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const filter = page.getByLabel('筛选对话状态').first()
  await filter.selectOption('needs_action')
  const rows = page.locator('.desktop-agent-conv-row')
  await expect(rows).toHaveCount(2, { timeout: 15_000 })
  const counts = await page.locator('.desktop-agent-conv-row-pending').allTextContents()
  expect(counts.map((text) => text.trim())).toEqual(['待你处理 1', '待你处理 1'])
  expect(counts.length).toBe(2)

  // 38 FN-01：进行中也包含待回答/待处理，而不是只看运行中的 run。
  await filter.selectOption('active')
  await expect(rows).toHaveCount(2, { timeout: 15_000 })
  await filter.selectOption('needs_action')
  await expect(rows).toHaveCount(2, { timeout: 15_000 })

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-fn01-pending-list.png') })
})
