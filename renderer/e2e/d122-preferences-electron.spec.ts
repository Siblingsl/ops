import { test, expect } from '@playwright/test'
import { registerAccount } from './support'

test('Electron 复盘页清楚区分统计偏好的四种适用状态', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.route(`**/api/v1/accounts/${account.id}/data-preferences`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'pref-current', feature: 'title_digit', conclusion: '当前偏好结论', basis: '按第 7 天阅读比较', sample_size: 14, applicable: true, applicability: 'current', basis_sample_count: 14, computed_at: '2026-10-19T00:00:00Z' },
      { id: 'pref-stale', feature: 'title_length', conclusion: '过期偏好结论', basis: '按第 7 天阅读比较', sample_size: 12, applicable: false, applicability: 'stale', basis_sample_count: 12, computed_at: '2026-10-18T00:00:00Z' },
      { id: 'pref-insufficient', feature: 'publish_hour', conclusion: '样本不足结论', basis: '按第 7 天阅读比较', sample_size: 8, applicable: false, applicability: 'insufficient_samples', basis_sample_count: 8, computed_at: '2026-10-17T00:00:00Z' },
      { id: 'pref-unverified', feature: 'body_length', conclusion: '旧记录结论', basis: '', sample_size: 11, applicable: false, applicability: 'unverified', basis_sample_count: 0, computed_at: null },
    ]),
  }))

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(`/a/${account.id}/review`)
  await page.getByRole('button', { name: '查看趋势', exact: true }).click()
  const preferences = page.getByText('写作生成使用的统计偏好', { exact: true })
  await expect(preferences).toBeVisible()
  await expect(page.getByText('当前偏好结论')).toBeVisible()
  await expect(page.getByText('过期偏好结论')).toBeVisible()
  await expect(page.getByText('样本不足结论')).toBeVisible()
  await expect(page.getByText('旧记录结论')).toBeVisible()
  await expect(page.getByText('当前可用', { exact: true })).toBeVisible()
  await expect(page.getByText('数据已变化，等待重算', { exact: true })).toBeVisible()
  await expect(page.getByText('样本不足，暂停注入', { exact: true })).toBeVisible()
  await expect(page.getByText('旧记录未验证', { exact: true })).toBeVisible()
  await expect(page.getByText('只有标记为“当前可用”的偏好会进入指定生成任务；其他记录保留供查看，不会注入。')).toBeVisible()
  const panel = page.locator('#desktop-review-insights > .rounded-xl')
  await panel.scrollIntoViewIfNeeded()
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1025)
  expect(bounds!.width).toBeGreaterThan(500)
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy()
})
