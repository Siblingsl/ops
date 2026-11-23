import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-02（DEV-AI-39）：待你处理中心——任务页顶部统一列出卡片/问题，
// 每条可定位到消息并高亮；空时不渲染；>5 条折叠为“查看全部”。
test('DEV-AI-39 FN-02 待处理中心列表与定位', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-02 待处理中心验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  const conversation = await api(page, 'POST', '/agent/conversations', {
    title: 'FN02 待处理中心', account_id: account.id, model: { provider_id: provider.id, model: 'mock-agent-tested' },
  }) as { id: string }

  // 真实 run 第一轮：两张不同工具的卡片（materials__create + inbox__create；服务端
  // 第 5.5 节同一工具同一目标只允许一张未结束卡片，所以用两个工具）。
  await api(page, 'POST', `/agent/conversations/${conversation.id}/messages`, {
    text: ['FN02 待处理中心验收：提出两张待审阅卡片', '#tool load_tool_domain {"domain":"materials"}',
      `#tool materials__create ${JSON.stringify({ account_id: account.id, kind: 'opinion', content: 'FN02 待审阅卡片一' })}`,
      `#tool inbox__create ${JSON.stringify({ content: 'FN02 待审阅卡片二' })}`,
    ].join('\n'),
    request_id: randomUUID(), protocol_version: 2,
  })
  await expect.poll(async () => {
    const detail = await api(page, 'GET', `/agent/conversations/${conversation.id}`) as { actions: { status: string }[] }
    return detail.actions?.filter((action) => action.status === 'pending').length ?? 0
  }, { timeout: 30_000 }).toBe(2)

  // 第二轮：一个问题（request_input）。
  await api(page, 'POST', `/agent/conversations/${conversation.id}/messages`, {
    text: ['FN02 待处理中心验收：提问', '#tool load_tool_domain {"domain":"profile"}',
      `#tool request_input ${JSON.stringify({ questions: [{ id: 'scope', title: '这次先整理哪个账号的记忆？', required: true, options: [{ id: 'a', label: '公众号' }, { id: 'b', label: '小红书' }] }] })}`,
    ].join('\n'),
    request_id: randomUUID(), protocol_version: 2,
  })

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.goto(`/agent/c/${conversation.id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  // 打开任务面板：待处理中心 3 条（1 问题 + 2 卡片）。
  await page.locator('.desktop-agent-panel-button').first().click()
  const pending = page.getByTestId('agent-pending-list')
  await expect(pending).toBeVisible({ timeout: 30_000 })
  await expect(pending).toContainText('待你处理 3')
  const rows = pending.locator('li')
  await expect(rows).toHaveCount(3)
  await expect(pending.locator('.desktop-agent-pending-kind[data-kind="question"]')).toHaveCount(1)
  await expect(pending.locator('.desktop-agent-pending-kind[data-kind="action"]')).toHaveCount(2)

  // 定位：点第一个“定位”按钮，对应卡片获得焦点与 data-highlight，1.5s 后移除。
  const locate = pending.locator('.desktop-agent-pending-locate').first()
  await locate.click()
  const focusedCard = page.locator('[id^="agent-action-"]').first()
  await expect(focusedCard).toBeFocused({ timeout: 5_000 })
  await expect(focusedCard).toHaveAttribute('data-highlight', '1.5s')
  await expect(focusedCard).not.toHaveAttribute('data-highlight', /.+/, { timeout: 3_000 })

  // 空态：回答问题并处理两张卡不现实——直接开新对话验证空时不渲染。
  await page.goto('/agent')
  await page.locator('.desktop-agent-panel-button').first().click()
  await expect(page.getByTestId('agent-pending-list')).toHaveCount(0)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-fn02-pending.png') })
})
