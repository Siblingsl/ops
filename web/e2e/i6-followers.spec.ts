import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I6 浏览器旅程：手动来源、跨平台合计、30 天缺口与逐日回填。
// 桌面工作台形态见 renderer/e2e/i6-followers.spec.ts。
function shanghaiDay(daysAgo: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - daysAgo * 24 * 60 * 60_000))
}

test('REF41 I6 Web 粉丝来源、跨平台汇总与逐日回填', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I6 使用本地手动来源与回填，不触碰真实平台')
  test.setTimeout(120_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `i6-followers-web-${Date.now()}`)
  const second = await api(page, 'POST', '/accounts', {
    platform: 'toutiao', name: 'I6 Web 头条号', content_format: 'long_article',
  }) as { id: string }
  const yesterday = shanghaiDay(1)
  const today = shanghaiDay(0)
  const importDay1 = shanghaiDay(4)
  const importDay2 = shanghaiDay(5)
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: yesterday, cumulate: 120 })
  await api(page, 'POST', `/accounts/${second.id}/followers`, { date: yesterday, cumulate: 55 })

  await page.goto(`/a/${account.id}/review`)
  const card = page.getByTestId('i6-followers-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('i6-follower-total')).toContainText('175')
  await expect(card.getByTestId('i6-covered-platforms')).toHaveText('2')
  await expect(card.getByTestId('i6-platform-list')).toContainText('小红书')
  await expect(card.getByTestId('i6-platform-list')).toContainText('今日头条')

  const xhsRow = card.getByTestId('i6-platform-row').filter({ hasText: '小红书' })
  await expect(xhsRow.getByTestId('i6-platform-latest')).toHaveText('120')
  await expect(xhsRow.getByTestId('i6-platform-source')).toContainText('手动录入')
  await xhsRow.getByRole('button', { name: today, exact: true }).click()
  const form = card.getByTestId('i6-backfill-form')
  await expect(form).toContainText(today)
  await form.getByRole('spinbutton').fill('130')
  await card.getByRole('button', { name: '写入缺失日' }).click()

  await expect(xhsRow.getByTestId('i6-platform-latest')).toHaveText('130')
  await expect(xhsRow.getByTestId('i6-platform-source')).toContainText('桌面回填')
  await expect(card.getByTestId('i6-follower-total')).toContainText('185')
  await page.screenshot({ path: '../.playwright-results/web/i6-web-followers.png' })

  // 已存在任何来源的日期不能再回填：界面必须明确提示冲突，而不是静默覆盖。
  const conflictDay = shanghaiDay(2)
  await xhsRow.getByRole('button', { name: conflictDay, exact: true }).click()
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: conflictDay, cumulate: 140 })
  await form.getByRole('spinbutton').fill('141')
  await card.getByRole('button', { name: '写入缺失日' }).click()
  await expect(page.getByText('以下日期已有粉丝数据，未写入任何回填')).toBeVisible()
  await expect(xhsRow.getByTestId('i6-platform-latest')).toHaveText('130')

  // CSV 导入：只写缺失日期，来源显示“导入”；再次导入同日期不覆盖已有值。
  const csvInput = card.getByTestId('i6-followers-import-input')
  await csvInput.setInputFiles({
    name: 'followers.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`date,count\n${importDay1},150\n${importDay2},160\n`),
  })
  await expect(page.getByText('已导入 2 天粉丝数据')).toBeVisible()
  for (const [day, count] of [[importDay1, '150'], [importDay2, '160']] as const) {
    const row = card.locator('tr').filter({ hasText: day })
    await expect(row).toContainText(count)
    await expect(row).toContainText('导入')
  }
  await csvInput.setInputFiles({
    name: 'followers.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`date,count\n${importDay1},999\n${importDay2},999\n`),
  })
  await expect(page.getByText('已导入 0 天；2 天已有数据，未覆盖')).toBeVisible()
  for (const [day, count] of [[importDay1, '150'], [importDay2, '160']] as const) {
    await expect(card.locator('tr').filter({ hasText: day })).toContainText(count)
  }
})

test('REF41 I6 Web：粉丝接口 500 显示错误并可重试', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I6 异常分支使用本地 API 拦截')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i6-followers-web-error-${Date.now()}`)
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: shanghaiDay(1), cumulate: 88 })
  const route = '**/api/v1/accounts/*/followers*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I6 粉丝读取失败' } }),
  }))
  await page.goto(`/a/${account.id}/review`)
  const card = page.getByTestId('i6-followers-card')
  await expect(card.getByTestId('i6-followers-error')).toContainText('C 类 I6 粉丝读取失败')
  await page.unroute(route)
  await card.getByTestId('i6-followers-error').getByRole('button', { name: '重试', exact: true }).click()
  await expect(card.getByTestId('i6-follower-total')).toContainText('88')
})
