import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 FN-03（DEV-AI-39）：运行时间线按业务步骤聚合，成功折叠、失败默认展开，
// 头行 13/20、展开行 12/18，只展示 summary，不展示工具参数。
test('DEV-AI-39 FN-03 运行时间线成功折叠与失败展开', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'FN-03 时间线验收模型',
    base_url: 'http://127.0.0.1:8297/v1',
    api_key: 'local-e2e-key',
    models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const workA = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'FN03 时间线作品 A' })
  const workB = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'FN03 时间线作品 B' })

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill(`读取两篇作品并核对摘要。\n#tool load_tool_domain {"domain":"works"}\n#tool works__get ${JSON.stringify({ id: workA.id })}\n#tool works__get ${JSON.stringify({ id: workB.id })}`)
  await page.getByRole('button', { name: '发送', exact: true }).click()

  const successTimeline = page.locator('.desktop-agent-timeline').last()
  await expect(successTimeline).toBeVisible({ timeout: 30_000 })
  const successHead = successTimeline.locator('.desktop-agent-timeline-head')
  await expect(successHead).toContainText(/已读取 2 项资料/)
  await expect(successHead).toHaveAttribute('aria-expanded', 'false')
  const headMetrics = await successHead.evaluate((element) => ({
    fontSize: getComputedStyle(element).fontSize,
    minHeight: getComputedStyle(element).minHeight,
  }))
  expect(headMetrics.fontSize).toBe('13px')
  expect(headMetrics.minHeight).toBe('32px')

  await successHead.click()
  await expect(successHead).toHaveAttribute('aria-expanded', 'true')
  const successRows = successTimeline.locator('.desktop-agent-timeline-row')
  await expect(successRows).toHaveCount(1)
  const rowMetrics = await successRows.first().evaluate((element) => ({
    fontSize: getComputedStyle(element).fontSize,
    minHeight: getComputedStyle(element).minHeight,
  }))
  expect(rowMetrics.fontSize).toBe('12px')
  expect(rowMetrics.minHeight).toBe('28px')
  await expect(successRows.first()).toContainText(/读取作品 2 项/)
  // TL-02：展开行渲染服务端投影的业务对象名（works__get 返回真实作品 title），不出现工具参数。
  const successObjects = successRows.first().locator('.desktop-agent-timeline-object')
  await expect(successObjects.first()).toContainText('FN03 时间线作品')
  const objectMetrics = await successObjects.first().evaluate((element) => ({
    fontSize: getComputedStyle(element).fontSize,
    text: element.textContent?.trim() || '',
  }))
  expect(objectMetrics.fontSize).toBe('12px')
  expect(objectMetrics.text, '对象名不携带 JSON 参数').not.toMatch(/[{}"]/)

  const conversationPath = new URL(page.url()).pathname
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationPath.split('/').pop()!}`)).active_run, { timeout: 30_000 }).toBeNull()
  await expect(page.locator('.desktop-agent-run-live')).toHaveCount(0)
  const screenshotDir = resolve(process.cwd(), '../.playwright-results')
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, 'agent-p0-fn03-timeline-success.png') })
  await successTimeline.screenshot({ path: resolve(screenshotDir, 'agent-p0-fn03-timeline-success-detail.png') })

  await composer.fill('验证失败步骤默认展开。\n#tool unknown_fn03 {}')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const failedTimeline = page.locator('.desktop-agent-timeline').last()
  await expect(failedTimeline).toBeVisible({ timeout: 30_000 })
  const failedHead = failedTimeline.locator('.desktop-agent-timeline-head')
  await expect(failedHead).toHaveAttribute('aria-expanded', 'true')
  await expect(failedHead).toContainText(/有步骤失败，已展开失败项/)
  await expect(failedTimeline.locator('.desktop-agent-timeline-row')).toContainText(/失败/)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationPath.split('/').pop()!}`)).active_run, { timeout: 30_000 }).toBeNull()
  await failedTimeline.screenshot({ path: resolve(screenshotDir, 'agent-p0-fn03-timeline-failed.png') })
})
