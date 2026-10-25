import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { api, registerAccount } from './support'

test('Electron 复盘页按原型布局并逐项点击数据入口', async ({ page }) => {
  const account = await registerAccount(page)
  const rows = [
    { id: 'review-work-one', title: '把时间留给自己', status: 'published', published_at: '2026-10-10T09:00:00Z', d7: { day_offset: 7, reads: 2864, favorites: 128, shares: 62, follows_gained: 29, source: 'screenshot' }, nodes: [1, 3, 7], points: 1 },
    { id: 'review-work-two', title: '周末留白', status: 'published', published_at: '2026-10-11T09:00:00Z', d7: { day_offset: 7, reads: 2145, favorites: 91, shares: 51, follows_gained: 23, source: 'manual' }, nodes: [7], points: 1 },
    { id: 'review-work-three', title: '给生活一点空间', status: 'published', published_at: '2026-10-12T09:00:00Z', d7: { day_offset: 7, reads: 1833, favorites: 67, shares: 36, follows_gained: 16, source: 'manual' }, nodes: [7], points: 1 },
  ]
  await page.route(`**/api/v1/accounts/${account.id}/board`, (route) => route.fulfill({ status: 200, json: rows }))
  await page.route('**/api/v1/ai/status', (route) => route.fulfill({ status: 200, json: { ready: true, vision_route: true, image_route: false, tokens_today: 0 } }))
  await page.route('**/api/v1/accounts/*/reviews', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, json: [] })
    : route.continue())
  await page.route('**/api/v1/works/review-work-one/metrics', (route) => route.fulfill({ status: 200, json: [] }))
  await page.route('**/api/v1/accounts/*/metrics/screenshots', (route) => route.fulfill({ status: 200, json: {
    id: 'review-shot-1', rows: [{ index: 0, title: rows[0].title, published_hint: '2026-10-10', day_hint: '发布后第 7 天', work_id: rows[0].id,
      match_type: 'exact', similarity: 1, estimated: false, raw_text: '阅读 2864 收藏 128 分享 62', dropped: [], status: 'pending',
      reads: 2864, likes: 86, wows: null, favorites: 128, comments: 31, shares: 62, follows_gained: 29 }],
  } }))
  await page.route('**/api/v1/metrics/screenshots/review-shot-1/rows/0/confirm', (route) => route.fulfill({ status: 200, json: {
    id: 'review-metric-shot-1', work_id: rows[0].id, reads: 2864, likes: 86, favorites: 128, comments: 31, shares: 62, follows_gained: 29,
    source: 'screenshot', day_offset: 7, captured_at: '2026-10-17T09:00:00Z', note: '', merged: false,
  } }))
  await page.route('**/api/v1/works/review-work-one/metrics', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, json: [] })
    const body = route.request().postDataJSON()
    return route.fulfill({ status: 200, json: { id: 'review-metric-manual-1', work_id: rows[0].id, ...body, source: 'manual', day_offset: 7, merged: false } })
  })

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/review`)
  await expect(page.getByTestId('desktop-review-table')).toBeVisible()

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="review"]').click()
  await expect(prototype.locator('.page-top')).toBeVisible()
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  const productSelectors = [
    '.desktop-review-page > div:first-child h1', '.desktop-review-page > div:first-child p',
    '.desktop-review-stats', '.desktop-review-board-heading', '.desktop-review-table', '.desktop-review-teasers',
  ]
  const prototypeSelectors = ['.page-top h1', '.page-top p', '.compact-stats', '.section-heading', '.panel.table-wrap table', '.insight-row']
  const metrics = await Promise.all(productSelectors.map(async (selector, index) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    return { selector, actual: await page.locator(selector).evaluate(rect), expected: await prototype.locator(prototypeSelectors[index]).evaluate(rect) }
  }))
  console.log('Review layout comparison', JSON.stringify(metrics))
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/review-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/review-layout-prototype.png') })
  for (const { selector, actual, expected } of metrics) {
    expect(Math.abs(actual.x - expected.x), `${selector} x`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.y - expected.y), `${selector} y`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(2)
  }

  await expect(page.getByTestId('desktop-review-stats')).toContainText('6,842')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('286')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('149')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('68')
  await page.getByRole('button', { name: '查看报告与证据', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AI 复盘', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '粘贴回填', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: '粘贴数据回填' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  const csvChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入表格（CSV）', exact: true }).click()
  await (await csvChooserPromise).setFiles([])
  await page.getByRole('button', { name: '查看趋势', exact: true }).click()
  await expect(page.getByRole('heading', { name: '什么在起作用', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '粉丝记录', exact: true }).click()
  await expect(page.getByRole('heading', { name: /账号粉丝变化/ })).toBeVisible()
  await page.getByRole('button', { name: '补录一天', exact: true }).click()
  await expect(page.getByLabel('日期')).toBeVisible()
  await page.getByRole('button', { name: '收起', exact: true }).click()
  const firstRow = page.getByTestId('desktop-review-table').locator('tbody tr').first()
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkWQAAAAASUVORK5CYII=', 'base64')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '截图识别', exact: true }).click()
  await (await chooserPromise).setFiles({ name: 'metrics.png', mimeType: 'image/png', buffer: image })
  await expect(page.getByRole('dialog').getByRole('heading', { name: '核对截图识别结果' })).toBeVisible()
  await page.getByRole('button', { name: '导入这一行' }).click()
  await expect(page.getByText('已导入', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '完成', exact: true }).click()

  const saved = page.waitForRequest((request) => request.url().endsWith(`/api/v1/works/${rows[0].id}/metrics`) && request.method() === 'POST')
  await page.getByRole('button', { name: '录入数据', exact: true }).click()
  const drawer = page.getByRole('heading', { name: rows[0].title, exact: true }).locator('xpath=../../..')
  await expect(drawer).toBeVisible()
  await drawer.getByLabel('观看').fill('3000')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  expect((await saved).postDataJSON()).toMatchObject({ reads: 3000 })
  await drawer.getByRole('button', { name: '关闭' }).click()
  await firstRow.getByRole('button', { name: `录入${rows[0].title}数据` }).click()
  const rowDrawer = page.getByRole('heading', { name: rows[0].title, exact: true }).locator('xpath=../../..')
  await expect(rowDrawer).toBeVisible()
  await rowDrawer.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '同步与匹配', exact: true }).click()
  await expect(page.locator('#desktop-review-board')).toBeInViewport()
  await prototype.close()
})
