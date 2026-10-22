import { expect, test } from '@playwright/test'
import { api, finishChecks, registerAccount } from './support'

test('今日头条账号逐篇选择文章和微头条，编辑器与发布门槛在窄窗口可用', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const account = await registerAccount(page, '文章', 'toutiao')

  const create = async (format: 'long_article' | 'micro_post', label: string) => {
    await page.goto(`/a/${account.id}/works?create=1`)
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
    await expect(dialog).toBeVisible()
    const choice = dialog.getByRole('radio', { name: new RegExp(`^${label}`) })
    if (format === 'micro_post') await choice.check()
    else await expect(choice).toBeChecked()
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${account.id}/works`) && r.request().method() === 'POST')
    await dialog.getByRole('button', { name: '开始创作', exact: true }).click()
    await page.waitForURL(/\/works\/[a-f0-9-]+$/)
    const id = page.url().split('/').pop()!
    const work = await (await created).json()
    expect(work.id).toBe(id)
    expect(work.content_format).toBe(format)
    await expect(page.getByText(`浏览器验收号 · 今日头条 · ${label}`, { exact: true })).toBeVisible()
    return id
  }

  const microID = await create('micro_post', '微头条')
  const articleID = await create('long_article', '文章')
  const micro = await api(page, 'GET', `/works/${microID}`)
  const article = await api(page, 'GET', `/works/${articleID}`)
  expect(micro.account_id).toBe(article.account_id)
  expect(micro.content_format).toBe('micro_post')
  expect(article.content_format).toBe('long_article')

  await page.goto(`/works/${microID}/pack`)
  await expect(page.getByText('发布前检查还没有全部确认，不能生成今日头条发布包。', { exact: true })).toBeVisible()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 740, height: 640 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    const action = page.getByRole('button', { name: '去检查', exact: true }).first()
    const box = await action.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath(`toutiao-pack-${viewport.width}x${viewport.height}.png`), fullPage: true })
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await page.screenshot({ path: testInfo.outputPath('toutiao-pack-dark.png'), fullPage: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})

test('微头条完整发布包在桌面与窄窗口排版正确', async ({ page }, testInfo) => {
  const account = await registerAccount(page, '微头条', 'toutiao')
  await page.goto(`/a/${account.id}/works?create=1`)
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(dialog).toBeVisible()
  const createResponse = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${account.id}/works`) && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const workID = page.url().split('/').pop()!
  await createResponse

  let work = await api(page, 'GET', `/works/${workID}`)
  work = await api(page, 'PATCH', `/works/${workID}`, {
    viewpoint: '先把一件小事做好，比同时追求很多目标更容易坚持。', base_revision: work.revision,
  })
  work = await api(page, 'PUT', `/works/${workID}/outline`, {
    items: [{ heading: '从一件小事开始', key_point: '选择一个今天能完成的行动。', material_ids: [] }],
    confirm: true, base_revision: work.revision,
  })
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: '先选一件今天能完成的小事，把它做到位。完成后记下过程，再决定下一步。', base_revision: section.revision,
    })
  }
  work = await api(page, 'GET', `/works/${workID}`)
  work = await api(page, 'PATCH', `/works/${workID}`, {
    title: '内部名称不进入微头条正文', topics: ['日常记录', '习惯养成'], base_revision: work.revision,
  })
  await finishChecks(page, workID)
  work = await api(page, 'GET', `/works/${workID}`)
  expect(work.content_format).toBe('micro_post')

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto(`/works/${workID}/pack`)
  const generate = page.getByRole('button', { name: '生成当前修订发布包', exact: true })
  await expect(generate).toBeVisible()
  await generate.click()
  await expect(page.getByRole('heading', { name: '发布包', exact: true })).toBeVisible()
  await expect(page.getByText('今日头条 · 微头条', { exact: true })).toBeVisible()
  await expect(page.getByText('“内部名称不进入微头条正文”仅为系统内部名称，不会写入微头条发布正文。', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '发布正文文本' })).toHaveValue(/先选一件今天能完成的小事/)
  await expect(page.getByRole('textbox', { name: '头条话题' })).toHaveValue('#日常记录\n#习惯养成')
  await expect(page.getByText('手动发布清单', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '发布标题', exact: true })).toHaveCount(0)

  for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 740, height: 640 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    const download = page.getByRole('button', { name: '下载完整发布包', exact: true }).first()
    const box = await download.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath(`toutiao-ready-pack-${viewport.width}x${viewport.height}.png`), fullPage: true })
  }
  const columns = page.locator('main > .grid').first()
  await page.setViewportSize({ width: 1440, height: 900 })
  const leftWide = await columns.locator(':scope > section').boundingBox()
  const rightWide = await columns.locator(':scope > aside').boundingBox()
  expect(leftWide).toBeTruthy()
  expect(rightWide).toBeTruthy()
  expect(leftWide!.x + leftWide!.width).toBeLessThanOrEqual(rightWide!.x + 1)
  await page.setViewportSize({ width: 960, height: 640 })
  const leftNarrow = await columns.locator(':scope > section').boundingBox()
  const rightNarrow = await columns.locator(':scope > aside').boundingBox()
  expect(leftNarrow).toBeTruthy()
  expect(rightNarrow).toBeTruthy()
  expect(leftNarrow!.y + leftNarrow!.height).toBeLessThanOrEqual(rightNarrow!.y + 1)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(darkBackground).not.toBe(lightBackground)
  await page.evaluate(async () => {
    const transitions = document.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)
    await Promise.all(transitions.map((animation) => animation.finished.catch(() => undefined)))
  })
  await page.screenshot({ path: testInfo.outputPath('toutiao-ready-pack-dark-960x640.png'), fullPage: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载完整发布包', exact: true }).first().click()
  expect((await downloadEvent).suggestedFilename()).toMatch(/^toutiao-\d{4}-\d{2}-\d{2}\.zip$/)
})

test('头条区间截图必须逐行确认累计值后才能导入', async ({ page }, testInfo) => {
  const account = await registerAccount(page, '微头条', 'toutiao')
  const work = { id: 'toutiao-ui-micro-work', title: '截图回收验收作品', content_format: 'micro_post', status: 'published', published_at: '2026-10-10T09:00:00Z', d7: null, nodes: [], points: 1 }
  await page.route(`**/api/v1/accounts/${account.id}/board**`, (route) => route.fulfill({ status: 200, json: [work] }))
  await page.route('**/api/v1/ai/status', (route) => route.fulfill({ status: 200, json: { ready: true, vision_route: true, image_route: false, tokens_today: 0 } }))
  await page.route(`**/api/v1/accounts/${account.id}/metrics/screenshots`, (route) => route.fulfill({ status: 200, json: {
    id: 'toutiao-ui-shot', rows: [{ index: 0, title: '', content_format: 'micro_post', published_hint: '2026-10-10', day_hint: '近 7 天', interval_hint: true,
      work_id: null, match_type: 'none', similarity: 0, estimated: false, raw_text: '近 7 天展现 1200，阅读 300', dropped: [], status: 'pending',
      impressions: 1200, impressions_exact: '1200', reads: 300, likes: null, wows: null, favorites: null, comments: null, shares: null, follows_gained: null }],
  } }))
  let confirmation: Record<string, unknown> | undefined
  await page.route('**/api/v1/metrics/screenshots/toutiao-ui-shot/rows/0/confirm', async (route) => {
    confirmation = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 200, json: {
      id: 'toutiao-ui-shot-metric', work_id: work.id, captured_at: '2026-10-20T09:00:00Z', source: 'screenshot', day_offset: null,
      impressions: 1200, reads: 300, likes: null, favorites: null, comments: null, shares: null, follows_gained: null, merged: false,
    } })
  })

  await page.setViewportSize({ width: 740, height: 640 })
  await page.goto(`/a/${account.id}/review`)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '截图识别', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'toutiao-metrics.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkWQAAAAASUVORK5CYII=', 'base64'),
  })
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '核对截图识别结果', exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('区间统计', { exact: false })).toBeVisible()
  await expect(dialog.getByText('微头条', { exact: false }).first()).toBeVisible()
  await expect(dialog.getByRole('combobox').locator('option')).toHaveCount(2)
  await dialog.getByRole('combobox').selectOption(work.id)
  const importRow = dialog.getByRole('button', { name: '导入这一行', exact: true })
  await expect(importRow).toBeDisabled()
  const checkbox = dialog.getByRole('checkbox', { name: '我已核对，并将本行数值改为截至采集时间的累计值' })
  await checkbox.check()
  await expect(importRow).toBeEnabled()
  await expect(importRow).toBeInViewport()
  const importRowBox = await importRow.boundingBox()
  expect(importRowBox).toBeTruthy()
  expect(importRowBox!.y + importRowBox!.height).toBeLessThanOrEqual(640)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: testInfo.outputPath('toutiao-screenshot-cumulative-confirmation-740x640.png'), fullPage: true })
  await importRow.click()
  await expect(page.getByText('已导入', { exact: true })).toBeVisible()
  expect(confirmation).toMatchObject({ work_id: work.id, cumulative_confirmed: true, impressions: 1200, reads: 300 })
})
