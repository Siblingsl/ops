import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I5 浏览器旅程：同账号 3 篇更早作品 + 本期作品，第 7 天中位数对比、
// 样本不足提示、缺失节点不补 0、同批作品可展开。桌面形态见 renderer/e2e/i5-peer-compare.spec.ts。
function shanghaiDate(daysAgo: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - daysAgo * 24 * 60 * 60_000))
}

async function importPublished(page: Page, accountId: string, title: string, daysAgo: number) {
  const work = await api(page, 'POST', `/accounts/${accountId}/works/import`, {
    confirm_published: true,
    title,
    published_date: shanghaiDate(daysAgo),
    sections: [{ heading: '正文', content_md: `${title} 的正文。` }],
  }) as { id: string; published_at: string }
  return work
}

async function addNode7(page: Page, work: { id: string; published_at: string }, reads: number, likes: number, current = false) {
  const capturedAt = current
    ? new Date()
    : new Date(new Date(work.published_at).getTime() + 7 * 86_400_000 + 3_600_000)
  await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: capturedAt.toISOString(), reads, likes, favorites: Math.round(likes / 2),
    comments: 1, shares: 1, follows_gained: Math.round(likes / 3),
  })
}

test('REF41 I5 Web 同龄对比：第 7 天中位数、缺失节点与同批作品', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I5 使用本地回填作品与手录指标')
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp', `i5-peer-web-${Date.now()}`)

  const current = await importPublished(page, account.id, 'I5 Web 本期作品', 7)
  const peerA = await importPublished(page, account.id, 'I5 Web 同批作品一', 8)
  const peerB = await importPublished(page, account.id, 'I5 Web 同批作品二', 9)
  const peerC = await importPublished(page, account.id, 'I5 Web 同批作品三', 10)
  await addNode7(page, current, 100, 10, true)
  await addNode7(page, peerA, 80, 8)
  await addNode7(page, peerB, 60, 6)
  await addNode7(page, peerC, 120, 12)

  await page.goto(`/a/${account.id}/review`)
  const row = page.getByRole('row').filter({ hasText: 'I5 Web 本期作品' })
  await row.getByRole('button', { name: /录入/ }).click()
  const drawer = page.getByRole('dialog').filter({ hasText: 'I5 Web 本期作品' })
  await expect(drawer.getByTestId('review-peer-card')).toBeVisible()

  // 默认第 7 天：样本 3 篇，阅读 100 对中位数 80。
  await expect(drawer.getByTestId('review-peer-node-7')).toHaveAttribute('aria-selected', 'true')
  await expect(drawer.getByTestId('review-peer-peers-toggle')).toContainText('查看同批作品（3）')
  const reads = drawer.getByTestId('review-peer-metric-reads')
  await expect(reads).toContainText('100')
  await expect(reads).toContainText('80')
  await expect(reads).toContainText('高于中位数 25.0%')
  await expect(drawer.getByTestId('review-peer-insufficient')).toHaveCount(0)

  // 第 1 天没有手录数据：显示未采集，不能把缺失当 0。
  await drawer.getByTestId('review-peer-node-1').click()
  await expect(drawer.getByTestId('review-peer-notice')).toContainText('未采集')
  await expect(drawer.getByTestId('review-peer-current-reads')).toHaveText('未采集')
  await expect(drawer.getByTestId('review-peer-median-reads')).toHaveText('未采集')

  // 回到第 7 天并展开同批作品，标题可见。
  await drawer.getByTestId('review-peer-node-7').click()
  await drawer.getByTestId('review-peer-peers-toggle').click()
  const peers = drawer.getByTestId('review-peer-peers')
  await expect(peers).toContainText('I5 Web 同批作品一')
  await expect(peers).toContainText('I5 Web 同批作品二')
  await expect(peers).toContainText('I5 Web 同批作品三')

  await page.screenshot({ path: '../.playwright-results/web/i5-web-peer-compare.png' })
})

test('REF41 I5 Web：同龄对比 500 显示错误并可重试', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I5 500 分支使用本地 API 拦截')
  const account = await registerAccount(page, '长图文', 'wechat_mp', `i5-peer-error-web-${Date.now()}`)
  await importPublished(page, account.id, 'I5 Web 错误态作品', 0)
  await page.goto(`/a/${account.id}/review`)
  const route = '**/peer-compare*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I5 同龄对比读取失败' } }),
  }))
  await page.getByRole('row').filter({ hasText: 'I5 Web 错误态作品' }).getByRole('button', { name: /录入/ }).click()
  const card = page.getByRole('dialog').filter({ hasText: 'I5 Web 错误态作品' }).getByTestId('review-peer-card')
  await expect(card).toContainText('同龄对比加载失败')
  await page.unroute(route)
  await card.getByRole('button', { name: '重试', exact: true }).click()
  await expect(card).not.toContainText('同龄对比加载失败')
})
