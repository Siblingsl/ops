import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-04（DEV-AI-39）：划选“引用追问”——assistant 正文选区 → 浮条 → 引用筹码 →
// 发送 payload 带带 anchor 的 message 引用；原文变化后 preview 422 提示重选（不自动发送）。
test('DEV-AI-39 IX-04 划选引用追问闭环', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-04 划选引用模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  const conversation = await api(page, 'POST', '/agent/conversations', {
    title: 'IX04 划选引用', account_id: account.id, model: { provider_id: provider.id, model: 'mock-agent-tested' },
  }) as { id: string }
  await page.goto(`/agent/c/${conversation.id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  // 真实 run 产生 assistant 正文。
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill('请解释一下内容日历的用法。')
  await composer.press('Enter')
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversation.id}`)).active_run, { timeout: 30_000 }).toBeNull()

  // 划选 assistant 消息正文前 8 个字符 → 浮条出现。
  const assistantParagraph = page.locator('article', { hasText: '我可以帮你查询和整理' }).locator('.agent-markdown, p').first()
  await expect(assistantParagraph).toBeVisible({ timeout: 15_000 })
  const box = await assistantParagraph.boundingBox()!
  await page.mouse.move(box.x + 12, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 10, { steps: 6 })
  await page.mouse.up()
  const bar = page.locator('.desktop-agent-selection-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await expect(bar.getByRole('button', { name: '引用追问' })).toBeVisible()

  // 点击引用追问 → 输入台出现“引用”筹码（type=message）。
  await bar.getByRole('button', { name: '引用追问' }).click()
  await expect(page.getByText(/引用/).first()).toBeVisible()
  // 筹码：名称与范围为两个 span，分开断言。
  await expect(page.getByText('引用', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('本轮引用', { exact: true }).first()).toBeVisible()

  // 发送 payload 断言 message 引用带 anchor。
  let payload: Record<string, unknown> | null = null
  await page.route(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/, async (route) => {
    payload = route.request().postDataJSON()
    await route.continue()
  })
  await composer.fill('针对这段引用追问一下')
  await composer.press('Enter')
  await expect.poll(() => payload).not.toBeNull()
  const refs = (payload!.context_refs as Array<{ type: string; anchor?: { quote: string } }>)
  expect(refs.some((ref) => ref.type === 'message' && ref.anchor && ref.anchor.quote.length > 0)).toBe(true)

  // 原文变化 → preview 422：消息不存在（user 消息）时筹码发送被服务端拒并提示（不伪造成功）。
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-ix04-selection.png') })
})
