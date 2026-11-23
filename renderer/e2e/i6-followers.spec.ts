import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I6 桌面工作台旅程：跨平台合计、来源 chip、30 天折线与缺口回填。
// 浏览器形态见 web/e2e/i6-followers.spec.ts；两端独立种子数据，不共享文件。
function day(offset: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - offset * 86_400_000))
}

test('REF41 I6 桌面工作台：粉丝来源与逐条回填', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I6 桌面旅程使用本地手动来源，不触碰真实平台')
  test.setTimeout(150_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `i6-followers-desktop-${Date.now()}`)
  const second = await api(page, 'POST', '/accounts', {
    platform: 'toutiao', name: 'I6 桌面头条号', content_format: 'long_article',
  }) as { id: string }
  const before = day(1)
  const current = day(0)
  const importDay1 = day(4)
  const importDay2 = day(5)
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: before, cumulate: 90 })
  await api(page, 'POST', `/accounts/${second.id}/followers`, { date: before, cumulate: 40 })

  await page.goto(`/a/${account.id}/review`)
  const card = page.getByTestId('i6-followers-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('i6-follower-total')).toContainText('130')
  await expect(card.getByTestId('i6-covered-platforms')).toHaveText('2')

  const xhs = card.getByTestId('i6-platform-row').filter({ hasText: '小红书' })
  await expect(xhs.getByTestId('i6-platform-latest')).toHaveText('90')
  await expect(xhs.getByTestId('i6-platform-source')).toContainText('手动录入')
  await expect(xhs.getByTestId('i6-platform-collected')).not.toHaveText('采集时间未知')
  await expect(xhs.getByRole('img', { name: '近 30 天粉丝总数折线' })).toBeVisible()

  // 只回填当前缺口日期；不存在“全部回填”按钮。
  await xhs.getByRole('button', { name: current, exact: true }).click()
  const form = card.getByTestId('i6-backfill-form')
  await expect(form).toBeVisible()
  await expect(card.getByRole('button', { name: /全部/ })).toHaveCount(0)
  await form.getByRole('spinbutton').fill('95')
  await card.getByRole('button', { name: '写入缺失日' }).click()

  await expect(xhs.getByTestId('i6-platform-latest')).toHaveText('95')
  await expect(xhs.getByTestId('i6-platform-source')).toContainText('桌面回填')
  await expect(card.getByTestId('i6-follower-total')).toContainText('135')

  const csvInput = card.getByTestId('i6-followers-import-input')
  await csvInput.setInputFiles({
    name: 'followers.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`日期,粉丝数\n${importDay1},101\n${importDay2},102\n`),
  })
  await expect(page.getByText('已导入 2 天粉丝数据')).toBeVisible()
  for (const [dayValue, count] of [[importDay1, '101'], [importDay2, '102']] as const) {
    await expect(card.locator('tr').filter({ hasText: dayValue })).toContainText(count)
    await expect(card.locator('tr').filter({ hasText: dayValue })).toContainText('导入')
  }
  await csvInput.setInputFiles({
    name: 'followers.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`日期,粉丝数\n${importDay1},999\n${importDay2},999\n`),
  })
  await expect(page.getByText('已导入 0 天；2 天已有数据，未覆盖')).toBeVisible()
  await expect(card.locator('tr').filter({ hasText: importDay1 })).toContainText('101')
  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i6-desktop-followers.png' })
})

test('REF41 I6 桌面：粉丝接口 500 显示错误并可重试', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I6 异常分支使用本地 API 拦截')
  const account = await registerAccount(page, '图文笔记', 'xhs', `i6-followers-desktop-error-${Date.now()}`)
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: day(1), cumulate: 66 })
  const route = '**/api/v1/accounts/*/followers*'
  await page.route(route, (r) => r.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I6 桌面粉丝读取失败' } }),
  }))
  await page.goto(`/a/${account.id}/review`)
  const card = page.getByTestId('i6-followers-card')
  await expect(card.getByTestId('i6-followers-error')).toContainText('C 类 I6 桌面粉丝读取失败')
  await page.unroute(route)
  await card.getByTestId('i6-followers-error').getByRole('button', { name: '重试', exact: true }).click()
  await expect(card.getByTestId('i6-follower-total')).toContainText('66')
})
