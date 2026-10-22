import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { api, finishChecks, registerAccount } from './support'

test('头条合法非默认形态选题不误报，可开写；旧平台仍提示形态冲突', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '非默认微头条选题', format: 'micro_post' })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText(topic.title, { exact: true })).toBeVisible()
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toHaveCount(0)
  await expect(page.getByText('微头条', { exact: true })).toBeVisible()
  await mkdir(resolve('../output'), { recursive: true })
  for (const width of [1440, 960, 740]) {
    await page.setViewportSize({ width, height: 640 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    const button = page.getByRole('button', { name: '采用并开始写', exact: true })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: resolve(`../output/toutiao-topic-shapes-${width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: '采用并开始写', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const work = await api(page, 'GET', `/works/${page.url().split('/').pop()}`)
  expect(work.content_format).toBe('micro_post')
  expect(work.account_id).toBe(account.id)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出 Markdown', exact: true }).click()
  const download = await downloadEvent
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const markdown = Buffer.concat(chunks).toString('utf8')
  expect(markdown).toContain('今日头条 · 微头条')
  expect(markdown).toContain('内部名称与段落标题不作为发布正文')
  await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '修改默认后仍可开写的文章', format: 'long_article' })
  await api(page, 'PATCH', `/accounts/${account.id}`, { content_format: 'micro_post', confirm_type_change: true })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByText('修改默认后仍可开写的文章', { exact: true })).toBeVisible()
  await expect(page.getByText('文章', { exact: true })).toBeVisible()
  await expect(page.getByText('长图文', { exact: true })).toHaveCount(0)
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toHaveCount(0)
  const xhs = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '旧平台形态回归', content_format: 'image_note' })
  const old = await api(page, 'POST', `/accounts/${xhs.id}/topics`, { title: '迁移前图文选题', format: 'image_note' })
  await api(page, 'PATCH', `/accounts/${xhs.id}`, { content_format: 'list_note', confirm_type_change: true })
  await page.goto(`/a/${xhs.id}/topics`)
  await expect(page.getByText(old.topic.title, { exact: true })).toBeVisible()
  await expect(page.getByText('形态与账号类型不匹配', { exact: true })).toBeVisible()
})

test('推荐统计按形态切换，复盘联动且三个窗口双主题无关键控件溢出', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '文章', 'toutiao')
  for (const [format, reads] of [['long_article', 100], ['micro_post', 900]] as const) {
    let work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: `统计-${format}`, content_format: format })
    work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '记录自己的观察，再决定下一步行动。', base_revision: work.revision })
    work = await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '日常记录', key_point: '先完成今天的小事', material_ids: [] }], confirm: true, base_revision: work.revision })
    await api(page, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: '先把今天能做的小事记录下来，完成后再回顾过程。', base_revision: work.sections[0].revision })
    await finishChecks(page, work.id)
    work = await api(page, 'GET', `/works/${work.id}`)
    await api(page, 'POST', `/works/${work.id}/toutiao/pack`, { basis_revision: work.revision })
    const published = new Date(Date.now() - 7 * 86400_000).toISOString()
    await api(page, 'POST', `/works/${work.id}/published`, { published_at: published })
    await api(page, 'POST', `/works/${work.id}/metrics`, { reads, likes: reads / 10 })
  }
  await page.addInitScript(() => {
    const ua = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${ua} Electron/44.8.0` })
  })
  await page.goto(`/a/${account.id}/ops`)
  await page.getByRole('tab', { name: '推荐统计', exact: true }).click()
  const formatSelect = page.getByRole('combobox', { name: '推荐表现内容形态', exact: true })
  const performance = page.getByText(/^非推荐作品：/)
  await expect(formatSelect).toHaveValue('long_article')
  await expect(performance).toHaveText('非推荐作品：1 篇 · 平均阅读 100 · 平均点赞 10')
  await formatSelect.selectOption('micro_post')
  await expect(performance).toHaveText('非推荐作品：1 篇 · 平均阅读 900 · 平均点赞 90')
  await mkdir(resolve('../output'), { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    for (const width of [1440, 960, 740]) {
      await page.setViewportSize({ width, height: 640 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      const box = await formatSelect.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: resolve(`../output/toutiao-stats-${theme}-${width}.png`), fullPage: true })
    }
  }
  await page.goto(`/a/${account.id}/review`)
  await page.getByRole('button', { name: '查看趋势', exact: true }).click()
  const stats = page.locator('#desktop-review-followers').getByText(/^非推荐作品：/)
  await expect(stats).toContainText('平均阅读 100')
  await page.getByRole('combobox', { name: '复盘内容形态', exact: true }).selectOption('micro_post')
  await expect(stats).toContainText('平均阅读 900')
  await expect(stats).not.toContainText('平均阅读 100')
})
