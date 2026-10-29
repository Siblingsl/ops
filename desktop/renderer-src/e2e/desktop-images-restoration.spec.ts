import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('Electron 图片库按原型布局并逐项点击筛选与详情操作', async ({ page }) => {
  const account = await registerAccount(page)
  const works = await Promise.all([
    api(page, 'POST', `/accounts/${account.id}/works`, { title: '窗边的写作时间' }),
    api(page, 'POST', `/accounts/${account.id}/works`, { title: '留白与日常' }),
  ])
  const assets = Array.from({ length: 8 }, (_, index) => ({
    id: `image-${index + 1}`,
    work_id: works[index % works.length].id,
    mime: 'image/svg+xml',
    width: 1200,
    height: 900,
    bytes: 512,
    position: 0,
    alt_text: ['窗边的写作时间', '安静的一页纸', '留白与日常', '工作台的一角', '给周末的小清单', '一点自己的时间', '清晨的笔记', '选择与节奏'][index],
    url: `/api/v1/assets/image-${index + 1}/file`,
    account_id: account.id,
    account_name: '浏览器验收号',
    work_title: index % 2 === 0 ? '窗边的写作时间' : '留白与日常',
    ai_generated: index === 1 || index === 5,
    created_at: new Date(Date.now() - index * 60_000).toISOString(),
  }))
  const changes: { id: string; body: unknown }[] = []
  await page.route((url) => url.pathname === '/api/v1/assets', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const filtered = assets.filter((asset) =>
      (!query.get('account_id') || query.get('account_id') === asset.account_id)
      && (!query.get('work_id') || query.get('work_id') === asset.work_id)
      && (query.get('ai') === null || String(Number(asset.ai_generated)) === query.get('ai')),
    )
    await route.fulfill({ json: filtered })
  })
  await page.route('**/api/v1/assets/*/file*', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#efe8da"/><circle cx="900" cy="230" r="120" fill="#f3cf91"/><path d="M0 650 400 350l260 220 190-160 350 300v190H0z" fill="#7f927c"/></svg>',
  }))
  await page.route((url) => url.pathname.startsWith('/api/v1/assets/') && !url.pathname.endsWith('/file'), async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (route.request().method() === 'POST' && pathname.endsWith('/alt-suggestion')) {
      await route.fulfill({ json: { suggestion: '一束晨光落在窗边的笔记本上。' } })
      return
    }
    if (route.request().method() === 'PATCH' && pathname.split('/').length === 5) {
      const body = route.request().postDataJSON()
      changes.push({ id: route.request().url().split('/').at(-1)!, body })
      const updated = { ...assets.find((asset) => asset.id === route.request().url().split('/').at(-1)), ...body }
      assets[assets.findIndex((asset) => asset.id === updated.id)] = updated as typeof assets[number]
      await route.fulfill({ json: updated })
      return
    }
    await route.continue()
  })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/images')
  await expect(page.getByTestId('desktop-image-grid')).toBeVisible()

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="images"]').click()
  await expect(prototype.locator('.image-grid')).toBeVisible()

  const productSelectors = [
    '.desktop-page-frame h1', '.desktop-page-frame > div:first-child p', '.desktop-image-toolbar',
    '.desktop-image-search', '.desktop-image-search input', '.desktop-image-work-select', '.desktop-image-grid',
    '.desktop-image-grid > button:first-child img', '.desktop-image-grid > button:first-child > div',
  ]
  const prototypeSelectors = ['.page-top h1', '.page-top p', '.filters', '.filters > .input-wrap', '.filters > .input-wrap input', '.filters > select', '.image-grid', '.image-grid > button:first-child .image-art', '.image-grid > button:first-child .caption']
  const metrics = await Promise.all(productSelectors.map(async (selector, index) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const actual = await page.locator(selector).evaluate(rect)
    const expected = await prototype.locator(prototypeSelectors[index]).evaluate(rect)
    return { selector, actual, expected }
  }))
  console.log('Images layout comparison', JSON.stringify(metrics))
  const toolbarStyle = await page.locator('.desktop-image-toolbar').evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius, shadow: style.boxShadow }
  })
  expect(toolbarStyle).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px', radius: '0px', shadow: 'none' })
  await page.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/images-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/images-layout-prototype.png') })
  for (const { selector, actual, expected } of metrics) {
    expect(Math.abs(actual.x - expected.x), `${selector} horizontal position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.y - expected.y), `${selector} vertical position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(2)
  }
  await expect(page.locator('.desktop-image-grid > button')).toHaveCount(8)
  await expect(page.getByLabel('按账号筛选')).toHaveCount(0)
  await expect(page.getByLabel('按来源筛选')).toHaveCount(0)
  const search = page.getByRole('textbox', { name: '搜索图片描述' })
  await search.fill('周末的小清单')
  await expect(page.locator('.desktop-image-grid > button')).toHaveCount(1)
  await search.fill('没有这张图')
  await expect(page.getByText('没有符合条件的图片', { exact: true })).toBeVisible()
  await search.fill('')
  await page.getByLabel('按作品筛选').selectOption(works[0].id)
  await expect(page.locator('.desktop-image-grid > button')).toHaveCount(4)
  await page.getByLabel('按作品筛选').selectOption('')

  await page.locator('.desktop-image-grid > button').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '窗边的写作时间', exact: true })).toBeVisible()
  await dialog.getByLabel('替代文字').fill('一束晨光落在窗边的笔记本上')
  await dialog.getByRole('button', { name: '生成 AI 建议' }).click()
  await expect(dialog.getByLabel('替代文字')).toHaveValue('一束晨光落在窗边的笔记本上。')
  await dialog.getByLabel('替代文字').fill('窗边笔记本上的晨光')
  await dialog.getByRole('button', { name: '保存替代文字' }).click()
  await expect(page.getByText('替代文字已保存', { exact: true })).toBeVisible()
  expect(changes).toEqual([{ id: 'image-1', body: { alt_text: '窗边笔记本上的晨光' } }])
  await dialog.getByRole('link', { name: '打开所在作品' }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${works[0].id}$`))
  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()
  await prototype.close()
})
