import { expect, test } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { api, registerAccount } from './support'

// REF41 I7 Web 旅程：公众号作品生成 UTM 链接 → 复盘未接入 → 签名回传 → 转化数。
// 桌面工作台形态见 renderer/e2e/i7-conversion.spec.ts。
test('REF41 I7 Web 转化链接与回传归因', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I7 使用本地 public 回传，不触碰真实平台')
  test.setTimeout(120_000)
  await registerAccount(page, '图文笔记', 'xhs', `i7-conversion-web-${Date.now()}`)
  const account = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'I7 Web 公众号验收号', content_format: 'long_article',
  }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'I7 转化归因验收作品' }) as { id: string }

  await page.goto(`/works/${work.id}/push`)
  const card = page.getByTestId('i7-conversion-card')
  await expect(card).toBeVisible()
  await card.getByTestId('i7-conversion-target').fill('https://example.com/i7-web')
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
  await page.screenshot({ path: '../.playwright-results/web/i7-web-conversion-link.png' })

  const token = await api(page, 'POST', '/conversion-ingest-tokens', { name: `I7 Web 回传 ${Date.now()}` }) as { token: string }
  await page.goto(`/a/${account.id}/review?work=${work.id}`)
  const reviewCard = page.getByTestId('i7-conversions-card')
  await expect(reviewCard).toBeVisible()
  await expect(reviewCard.getByTestId('i7-conversion-unconnected')).toContainText('未接入回传')
  await expect(reviewCard.getByTestId('i7-conversion-register')).toHaveText('0')

  const body = JSON.stringify({
    event: 'register', external_id: `order-web-${Date.now()}`,
    occurred_at: new Date().toISOString(), value_cents: 0, currency: 'CNY',
    payload: { channel: 'wechat', plan: 'pro' },
  })
  const signature = 'sha256=' + createHmac('sha256', token.token).update(body).digest('hex')
  const response = await page.request.post(`/api/v1/public/conversion/${code}`, {
    headers: { 'Content-Type': 'application/json', 'X-Ops-Token': token.token, 'X-Ops-Signature': signature },
    data: body,
  })
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, duplicate: false })

  await page.reload()
  await expect(reviewCard.getByTestId('i7-conversion-register')).toHaveText('1')
  await expect(reviewCard.getByTestId('i7-conversion-paid')).toHaveText('0')
  await expect(reviewCard.getByTestId('i7-conversion-lead')).toHaveText('0')
  await reviewCard.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: '../.playwright-results/web/i7-web-conversion.png' })
})

test('REF41 I7 Web：生成转化链接 500 提示失败', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'I7 异常分支使用本地 API 拦截')
  await registerAccount(page, '图文笔记', 'xhs', `i7-conversion-web-error-${Date.now()}`)
  const account = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'I7 Web 异常验收号', content_format: 'long_article',
  }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'I7 Web 异常作品' }) as { id: string }
  await page.goto(`/works/${work.id}/push`)
  const card = page.getByTestId('i7-conversion-card')
  await page.route('**/works/*/conversion-links*', (r) => r.request().method() === 'POST'
    ? r.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'C 类 I7 生成链接失败' } }),
      })
    : r.continue())
  await card.getByTestId('i7-conversion-target').fill('https://example.com/i7-web-error')
  await card.getByTestId('i7-conversion-generate').click()
  await expect(page.getByText('C 类 I7 生成链接失败')).toBeVisible()
})
