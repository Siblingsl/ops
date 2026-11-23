import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-04（DEV-AI-39）：消息里只留只读摘要，唯一编辑/提交入口在右侧审阅抽屉；
// 600 宽、两列、差异高亮、底部按钮 32；关闭保留草稿，切换卡片先问保留/丢弃；观察者与逐卡确认不放宽。
test('DEV-AI-39 FN-04 审阅抽屉草稿保留与唯一提交实例', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-04 审阅验收模型',
    base_url: 'http://127.0.0.1:8297/v1',
    api_key: 'local-e2e-key',
    models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  await page.getByRole('textbox', { name: '发送消息' }).fill([
    '提出一条待我逐张审阅的素材卡片。',
    '#tool load_tool_domain {"domain":"materials"}',
    `#tool materials__create ${JSON.stringify({ account_id: account.id, kind: 'opinion', content: 'FN-04 草稿 A 原文' })}`,
  ].join('\n'))
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run, { timeout: 30_000 }).toBeNull()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).actions?.length ?? 0, { timeout: 30_000 }).toBe(1)
  const detail = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(detail.actions).toHaveLength(1)
  expect(detail.actions.every((action: { tool_name: string; status: string }) => action.tool_name === 'materials__create' && action.status === 'pending')).toBeTruthy()
  const [first] = detail.actions

  const firstCard = page.locator(`[data-action-id="${first.id}"]`)
  await expect(firstCard.getByRole('button', { name: '查看修改', exact: true })).toBeVisible()
  await expect(firstCard.getByRole('button', { name: '执行', exact: true })).toHaveCount(0)
  await expect(firstCard.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0)

  await firstCard.getByRole('button', { name: '查看修改', exact: true }).click()
  const review = page.locator('.desktop-agent-review-overlay')
  await expect(review).toHaveCount(1)
  await expect(review).toBeVisible()
  const metrics = await review.evaluate((element) => ({ width: element.getBoundingClientRect().width }))
  expect(metrics.width).toBe(600)
  const submit = review.getByRole('button', { name: '执行', exact: true })
  const reject = review.getByRole('button', { name: '拒绝', exact: true })
  await expect(submit).toHaveCount(1)
  await expect(reject).toHaveCount(1)
  const buttonHeights = await Promise.all([submit, reject].map((button) => button.evaluate((element) => element.getBoundingClientRect().height)))
  expect(buttonHeights).toEqual([32, 32])

  const editor = review.getByRole('textbox', { name: /修改内容/ })
  await expect(editor).toBeVisible()
  const edited = 'FN-04 草稿 A 已修改'
  await editor.fill(edited)
  await expect(review.locator('[class*="bg-ink-50"]').first()).toBeVisible()
  const columns = await review.locator('.desktop-agent-review-body .grid').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns)
  expect(columns.split(' ')).toHaveLength(2)

  const screenshotDir = resolve(process.cwd(), '../.playwright-results')
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, 'agent-p0-fn04-review-overlay.png') })

  await review.getByRole('button', { name: '关闭审阅', exact: true }).click()
  await expect(review).toHaveCount(0)
  await firstCard.getByRole('button', { name: '查看修改', exact: true }).click()
  await expect(review.getByRole('textbox', { name: /修改内容/ })).toHaveValue(edited)

  // Esc 也是关闭路径，草稿同样不能丢。
  await page.keyboard.press('Escape')
  await expect(review).toHaveCount(0)
  await firstCard.getByRole('button', { name: '查看修改', exact: true }).click()
  await expect(review.getByRole('textbox', { name: /修改内容/ })).toHaveValue(edited)

  const executed = page.waitForResponse((response) => response.url().endsWith(`/agent/actions/${first.id}/execute`) && response.request().method() === 'POST')
  await review.getByRole('button', { name: '执行', exact: true }).click()
  expect((await executed).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).actions[0].status, { timeout: 30_000 }).toBe('succeeded')
  await expect(firstCard.locator('.desktop-agent-action-summary-status')).toContainText('已完成')
})
