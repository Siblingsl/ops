import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { api, registerAccount } from './support'

test('Electron 账号运营按原型布局并逐项点击功能页签', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/strategy`, {
    niche: '生活与时间管理',
    audience: '希望重新掌握生活节奏的人',
    differentiation: '从真实生活观察出发，记录可实行的小练习。',
    persona: '诚实、温和、有行动感',
    pillars: [
      { name: '时间与选择', desc: '写下日常里的取舍。', ratio: 40, examples: ['把时间留给重要的事'] },
      { name: '生活练习', desc: '记录能坚持的小练习。', ratio: 35, examples: ['周末重启清单'] },
      { name: '阅读与表达', desc: '分享读书和表达经验。', ratio: 25, examples: ['重新找回表达'] },
    ],
    cadence: { per_week: 3, days: [3, 5, 7], format: 'image_note' },
    stage: 'growth',
    goals: [],
    benchmarks: [],
    keywords: ['生活节奏'],
    taboo: [],
    hot_enabled: false,
    blocked_words: [],
    daily_settings: { generate: 'off' },
  })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/ops`)
  await expect(page.getByTestId('desktop-ops-main')).toBeVisible()
  await page.locator('.desktop-ops-page').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="ops"]').click()
  await expect(prototype.locator('.page-top')).toBeVisible()
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })

  const productSelectors = [
    '.desktop-ops-page > div:first-child h1', '.desktop-ops-page > div:first-child p', '.desktop-ops-tabs',
    '.desktop-ops-layout', '.desktop-ops-main', '.desktop-ops-aside', '.desktop-ops-rhythm',
    '.desktop-ops-strategy-card',
  ]
  const prototypeSelectors = ['.page-top h1', '.page-top p', '.tabs', '.split-page', '.split-page > .settings-card', '.split-page > .details-panel', '.split-page > .details-panel', '.split-page > .settings-card']
  const metrics = await Promise.all(productSelectors.map(async (selector, index) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const actual = await page.locator(selector).evaluate(rect)
    const expected = await prototype.locator(prototypeSelectors[index]).evaluate(rect)
    return { selector, actual, expected }
  }))
  console.log('Operations layout comparison', JSON.stringify(metrics))
  await page.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/operations-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/operations-layout-prototype.png') })
  for (const { selector, actual, expected } of metrics) {
    expect(Math.abs(actual.x - expected.x), `${selector} horizontal position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.y - expected.y), `${selector} vertical position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(2)
    if (selector.includes('h1') || selector.endsWith(' p') || selector.includes('strategy-card') || selector.includes('ops-aside') || selector.includes('ops-rhythm')) {
      expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(2)
    }
  }
  const tabs = page.getByRole('tablist', { name: '账号运营功能' })
  await expect(tabs.getByRole('tab')).toHaveCount(6)
  await expect(page.getByRole('heading', { name: '当前方案 · 第 1 版', exact: true })).toBeVisible()
  for (let index = 0; index < 3; index++) {
    const row = page.locator('.desktop-strategy-row').nth(index)
    const detailButton = row.getByRole('button')
    await detailButton.click()
    await expect(detailButton).toHaveAttribute('aria-expanded', 'true')
    await expect(row.locator('.desktop-strategy-detail')).toBeVisible()
    await row.getByRole('button', { name: '收起' }).click()
    await expect(row.locator('.desktop-strategy-detail')).toHaveCount(0)
  }
  await page.getByRole('button', { name: '调整当前方案' }).click()
  await expect(page.getByLabel('调整意见（可选）')).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: '查看启用与历史' }).click()
  await expect(page.getByText(/v1 · 使用中/)).toBeVisible()
  await page.getByRole('button', { name: '版本历史' }).click()
  await expect(page.getByText(/v1 · 使用中/)).toBeVisible()
  await page.getByRole('button', { name: '起号问卷' }).click()
  for (const [label, expected] of [
    ['内容大纲', '未来四周'], ['热点参考', '热点采集未开启'], ['对标参考', '对标参考'],
    ['每日推荐', '今日推荐'], ['推荐统计', '近 30 天推荐采用情况'],
  ]) {
    await tabs.getByRole('tab', { name: label }).click()
    await expect(page.getByTestId('desktop-ops-main')).toContainText(expected)
  }
  await page.getByRole('link', { name: /查看内容日历/ }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/calendar$`))
  await expect(page.getByTestId('desktop-calendar-layout')).toBeVisible()
  await prototype.close()
})
