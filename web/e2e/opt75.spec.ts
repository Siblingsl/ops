import { expect, test } from '@playwright/test'
import { createOutline, registerAccount } from './support'

test('OPT75 检查项可用 Tab 聚焦并用 Enter 选择', async ({ page }) => {
  await registerAccount(page)
  const workId = await createOutline(page)
  const message = 'OPT75 键盘问题项'
  await page.route(`**/api/v1/works/${workId}/checks/latest`, route => route.fulfill({ json: { run: {
    id: 'opt75-check-run', revision: 1, target_platform: 'xhs', fact_status: 'done', completed_at: null,
    created_at: '2026-10-13T08:00:00Z', stale: false,
    items: [{ id: 'opt75-check-item', category: 'format', passed: true, matched_text: '',
      location: { field: 'title', label: '标题' }, message, detail: '', resolution: null, resolved_at: null }],
    total: 1, confirmed: 1, blocking: 0,
  } } }))
  await page.goto(`/works/${workId}/check`)
  const item = page.getByRole('button', { name: `定位检查项：${message}` })
  await expect(item).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  let reached = false
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab')
    if (await item.evaluate(el => el === document.activeElement)) {
      reached = true
      break
    }
  }
  expect(reached).toBeTruthy()
  await page.keyboard.press('Enter')
  await expect(item.locator('..')).toHaveClass(/border-gamboge-300/)
})

test('OPT75 快速双击公众号草稿同步只发送一个请求', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const workId = await createOutline(page)
  await page.route(`**/api/v1/works/${workId}`, async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const work = await response.json()
    await route.fulfill({ response, json: { ...work, status: 'pushed', wechat_draft_media_id: 'opt75-mock-draft' } })
  })
  await page.route(`**/api/v1/works/${workId}/wechat/push-preview`, async route => {
    const response = await route.fetch()
    const preview = await response.json()
    await route.fulfill({ response, json: { ...preview, can_push: true } })
  })
  let syncRequests = 0
  await page.route(`**/api/v1/works/${workId}/wechat/sync-draft`, async route => {
    syncRequests++
    await new Promise(resolve => setTimeout(resolve, 250))
    await route.fulfill({ json: { message: '已检查公众号草稿箱状态' } })
  })

  await page.goto(`/works/${workId}/push`)
  const sync = page.getByRole('button', { name: '同步状态', exact: true })
  await expect(sync).toBeVisible()
  await sync.dblclick({ delay: 20 })
  await expect(sync).toBeDisabled()
  await expect.poll(() => syncRequests).toBe(1)
  await expect(sync).toBeEnabled()
})
