import { test, expect } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT15 真实错误短 ID 可复制并对应响应与服务端日志', async ({ page, context }) => {
  await registerAccount(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const id = '00000000-0000-0000-0000-000000000000'
  const responses: { id: string; bodyId: string }[] = []
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== `/api/v1/works/${id}`) return
    const body = await response.json()
    responses.push({ id: response.headers()['x-request-id'], bodyId: body.error.request_id })
  })
  await page.goto(`/works/${id}`)
  const error = page.getByText(/内容不存在或已删除（请求 ID：[^）]+）/, { exact: true })
  await expect(error).toBeVisible()
  await expect.poll(() => responses.length).toBeGreaterThan(0)
  const last = responses.at(-1)!
  expect(last.id).toBeTruthy()
  expect(last.bodyId).toBe(last.id)
  const short = last.id.slice(-12)
  await expect(error).toContainText(short)
  await error.evaluate((element, value) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = node.textContent!.indexOf(value)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at); range.setEnd(node, at + value.length)
      const selection = window.getSelection()!
      selection.removeAllRanges(); selection.addRange(range)
      return
    }
    throw new Error('没有找到可复制的短 ID')
  }, short)
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(short)
  console.log(`OPT15 复制短 ID=${short}，完整响应/日志 ID=${last.id}`)
})

test('OPT15 HTML 与流式错误附短 ID，AI 原因清理仍保留 ID 与人工重试', async ({ page }) => {
  const account = await registerAccount(page)
  const htmlId = 'opt15-html-header-112233445566'
  let failing = true
  await page.route(`**/api/v1/accounts/${account.id}/dashboard`, route => failing
    ? route.fulfill({ status: 503, contentType: 'text/html', headers: { 'X-Request-ID': htmlId }, body: '<h1>local gateway unavailable</h1>' })
    : route.continue())
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('alert').getByText('服务暂不可用，请稍后重试（请求 ID：112233445566）', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').getByRole('button', { name: '重试', exact: true })).toBeEnabled()
  failing = false
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  const section = work.sections[0]
  const streamId = 'opt15-stream-header-665544332211'
  await page.route(`**/api/v1/sections/${section.id}/draft`, route => route.fulfill({
    contentType: 'text/event-stream', headers: { 'X-Request-ID': streamId },
    body: 'event: error\ndata: {"code":"ai_upstream_error","message":"模拟模型失败。你的内容没有被改动。"}\n\n',
  }))
  await page.locator(`#sec-${section.id}`).getByRole('button', { name: '起草本段', exact: true }).click()
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: '模拟模型失败' })
  await expect(toast).toContainText('请求 ID：665544332211')
  await expect(toast.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await expect(toast.getByRole('button', { name: '换备用模型', exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toBe(section.content_md)
})
