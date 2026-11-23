import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I5 桌面工作台旅程：回填 3 篇同账号更早作品，第 7 天中位数、样本门槛、
// 缺失节点不补 0、同批作品展开。浏览器形态见 web/e2e/i5-peer-compare.spec.ts。
function shanghaiDay(daysAgo: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - daysAgo * 24 * 60 * 60_000))
}

async function seedPublished(page: Page, accountId: string, title: string, daysAgo: number) {
  return await api(page, 'POST', `/accounts/${accountId}/works/import`, {
    confirm_published: true,
    title,
    published_date: shanghaiDay(daysAgo),
    sections: [{ heading: '正文', content_md: `${title} 桌面回填正文。` }],
  }) as { id: string; published_at: string }
}

async function recordDay7(page: Page, work: { id: string; published_at: string }, reads: number, likes: number, isCurrent = false) {
  const captured = isCurrent
    ? new Date()
    : new Date(new Date(work.published_at).getTime() + 7 * 86_400_000 + 2 * 3_600_000)
  await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: captured.toISOString(), reads, likes, favorites: Math.round(likes / 2),
    comments: 1, shares: 1, follows_gained: Math.round(likes / 3),
  })
}

test('REF41 I5 桌面工作台：同龄对比卡、样本与缺失节点', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I5 使用本地回填作品与手录指标')
  test.setTimeout(150_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')

  const current = await seedPublished(page, account.id, 'I5 桌面本期作品', 7)
  const peerA = await seedPublished(page, account.id, 'I5 桌面同批甲', 8)
  const peerB = await seedPublished(page, account.id, 'I5 桌面同批乙', 9)
  const peerC = await seedPublished(page, account.id, 'I5 桌面同批丙', 10)
  await recordDay7(page, current, 100, 10, true)
  await recordDay7(page, peerA, 80, 8)
  await recordDay7(page, peerB, 60, 6)
  await recordDay7(page, peerC, 120, 12)

  await page.goto(`/a/${account.id}/review`)
  const row = page.getByRole('row').filter({ hasText: 'I5 桌面本期作品' })
  await row.getByRole('button', { name: /录入/ }).click()
  const drawer = page.getByRole('dialog').filter({ hasText: 'I5 桌面本期作品' })
  const card = drawer.getByTestId('review-peer-card')
  await expect(card).toBeVisible()

  // 第 7 天节点：3 篇样本，阅读中位数 80。
  await expect(drawer.getByTestId('review-peer-node-7')).toHaveAttribute('aria-selected', 'true')
  await expect(drawer.getByTestId('review-peer-peers-toggle')).toContainText('查看同批作品（3）')
  await expect(drawer.getByTestId('review-peer-metric-reads')).toContainText('高于中位数 25.0%')
  await expect(drawer.getByTestId('review-peer-metric-reads')).toContainText('80')

  // 切到第 1 天：该节点没有记录，不把缺失补成 0。
  await drawer.getByTestId('review-peer-node-1').click()
  await expect(drawer.getByTestId('review-peer-notice')).toContainText('未采集')
  await expect(drawer.getByTestId('review-peer-metric-reads')).toContainText('未采集')

  // 展开同批作品，显示标题与第 7 天数值。
  await drawer.getByTestId('review-peer-node-7').click()
  await drawer.getByTestId('review-peer-peers-toggle').click()
  const list = drawer.getByTestId('review-peer-peers')
  await expect(list).toContainText('I5 桌面同批甲')
  await expect(list).toContainText('I5 桌面同批乙')
  await expect(list).toContainText('I5 桌面同批丙')

  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i5-desktop-peer-compare.png' })
})

test('REF41 I5 桌面：同龄对比 500 显示错误并可重试', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I5 500 分支使用本地 API 拦截')
  const account = await registerAccount(page, '长图文', 'wechat_mp', `i5-peer-error-desktop-${Date.now()}`)
  await seedPublished(page, account.id, 'I5 桌面错误态作品', 0)
  await page.goto(`/a/${account.id}/review`)
  const route = '**/peer-compare*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I5 桌面同龄对比读取失败' } }),
  }))
  await page.getByRole('row').filter({ hasText: 'I5 桌面错误态作品' }).getByRole('button', { name: /录入/ }).click()
  const card = page.getByRole('dialog').filter({ hasText: 'I5 桌面错误态作品' }).getByTestId('review-peer-card')
  await expect(card).toContainText('同龄对比加载失败')
  await page.unroute(route)
  await card.getByRole('button', { name: '重试', exact: true }).click()
  await expect(card).not.toContainText('同龄对比加载失败')
})
