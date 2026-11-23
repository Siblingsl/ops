import { expect, test } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { api, registerAccount } from './support'

// REF41 I7 桌面工作台旅程：非公众号禁止外链 → 公众号生成 UTM → 复制 →
// 复盘未接入 → 签名回传 → 转化数，并验证重复回传不重复计数。
// 浏览器形态见 web/e2e/i7-conversion.spec.ts；两端独立种子数据，不共享文件。
test('REF41 I7 桌面工作台：UTM 链接、禁止平台与签名回传', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I7 桌面旅程使用本地 public 回传，不触碰真实平台')
  test.setTimeout(150_000)
  const xhs = await registerAccount(page, '图文笔记', 'xhs', `i7-conversion-desktop-${Date.now()}`)
  const xhsWork = await api(page, 'POST', `/accounts/${xhs.id}/works`, { title: 'I7 桌面禁止外链作品' }) as { id: string }

  // 小红书作品只显示规则提示，不提供生成入口。
  await page.goto(`/works/${xhsWork.id}/push`)
  const forbidden = page.getByTestId('i7-conversion-card')
  await expect(forbidden.getByTestId('i7-conversion-forbidden')).toBeVisible()
  await expect(forbidden.getByTestId('i7-conversion-generate')).toHaveCount(0)

  const account = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'I7 桌面公众号验收号', content_format: 'long_article',
  }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'I7 桌面转化归因作品' }) as { id: string }

  await page.goto(`/works/${work.id}/push`)
  const card = page.getByTestId('i7-conversion-card')
  await expect(card).toBeVisible()
  await card.getByTestId('i7-conversion-target').fill('https://example.com/i7-desktop')
  await card.getByTestId('i7-conversion-generate').click()
  const urlText = await card.getByTestId('i7-conversion-url').textContent()
  expect(urlText).toContain('utm_source=wechat_mp')
  expect(urlText).toContain('utm_medium=article')
  expect(urlText).toContain('ops_code=')
  const code = new URL(urlText!).searchParams.get('ops_code')!
  expect(code).toHaveLength(12)
  await card.getByTestId('i7-conversion-copy').click()
  await expect(page.getByText('推广链接已复制').first()).toBeVisible()
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(500)
  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i7-desktop-conversion-link.png' })

  const token = await api(page, 'POST', '/conversion-ingest-tokens', { name: `I7 桌面回传 ${Date.now()}` }) as { token: string }
  await page.goto(`/a/${account.id}/review?work=${work.id}`)
  const reviewCard = page.getByTestId('i7-conversions-card')
  await expect(reviewCard).toBeVisible()
  await expect(reviewCard.getByTestId('i7-conversion-unconnected')).toContainText('未接入回传')
  await expect(reviewCard.getByTestId('i7-conversion-register')).toHaveText('0')

  const externalId = `order-desktop-${Date.now()}`
  const body = JSON.stringify({
    event: 'register', external_id: externalId,
    occurred_at: new Date().toISOString(), value_cents: 0, currency: 'CNY',
    payload: { channel: 'wechat', plan: 'pro' },
  })
  const signature = 'sha256=' + createHmac('sha256', token.token).update(body).digest('hex')
  const headers = { 'Content-Type': 'application/json', 'X-Ops-Token': token.token, 'X-Ops-Signature': signature }
  const first = await page.request.post(`/api/v1/public/conversion/${code}`, { headers, data: body })
  expect(first.status()).toBe(200)
  expect(await first.json()).toMatchObject({ ok: true, duplicate: false })

  // 同一 external_id 重复回传：200 且 duplicate=true，复盘仍只计 1。
  const replay = await page.request.post(`/api/v1/public/conversion/${code}`, { headers, data: body })
  expect(replay.status()).toBe(200)
  expect(await replay.json()).toMatchObject({ ok: true, duplicate: true })

  await page.reload()
  await expect(reviewCard.getByTestId('i7-conversion-register')).toHaveText('1')
  await expect(reviewCard.getByTestId('i7-conversion-paid')).toHaveText('0')
  await expect(reviewCard.getByTestId('i7-conversion-lead')).toHaveText('0')
  await reviewCard.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: '../.playwright-results/desktop-renderer/i7-desktop-conversion.png' })
})

test('REF41 I7 桌面：生成转化链接 500 提示失败', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I7 异常分支使用本地 API 拦截')
  await registerAccount(page, '图文笔记', 'xhs', `i7-conversion-desktop-error-${Date.now()}`)
  const account = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'I7 桌面异常验收号', content_format: 'long_article',
  }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'I7 桌面异常作品' }) as { id: string }
  await page.goto(`/works/${work.id}/push`)
  const card = page.getByTestId('i7-conversion-card')
  await page.route('**/works/*/conversion-links*', (r) => r.request().method() === 'POST'
    ? r.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I7 桌面生成链接失败' } }),
      })
    : r.continue())
  await card.getByTestId('i7-conversion-target').fill('https://example.com/i7-desktop-error')
  await card.getByTestId('i7-conversion-generate').click()
  await expect(page.getByText('C 类 I7 桌面生成链接失败')).toBeVisible()
})
