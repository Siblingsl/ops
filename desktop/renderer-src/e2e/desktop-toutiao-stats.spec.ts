import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { api, finishChecks, registerAccount } from './support'

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
  await mkdir(resolve('../../output'), { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    for (const width of [1440, 960, 740]) {
      await page.setViewportSize({ width, height: 640 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      const box = await formatSelect.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: resolve(`../../output/toutiao-stats-${theme}-${width}.png`), fullPage: true })
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
