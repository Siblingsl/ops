import { test, expect } from '@playwright/test'
import { api, finishChecks, registerAccount } from './support'

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
