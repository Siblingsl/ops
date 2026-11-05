import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { api, registerAccount } from './support'

test('OPT37 扫码预览公开展示与当前公众号主题相同的只读排版', async ({ page, browser }) => {
  const journeyStarted = performance.now()
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT37 手机预览验收' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '这是本人输入的核心观点：清楚说明每一步，读者才能重复执行。', base_revision: work.revision })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '手机预览标题', key_point: '确认阅读体验', material_ids: [] }], confirm: true,
  })
  let current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: '这段内容用于检查手机扫码后的公众号排版。', base_revision: current.sections[0].revision,
  })
  await api(page, 'PUT', `/accounts/${account.id}/custom-theme`, {
    base: 'ink', primary_color: '#2F5D62', font_size: 16, line_height: 1.8,
    paragraph_gap: 18, heading_style: 'underline', quote_style: 'bar',
  })
  current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { theme: 'custom', base_revision: current.revision })

  await page.goto(`/works/${work.id}/preview`)
  // 自定义主题档案异步加载：等真实内容渲染完成再取样，避免抓到加载中的空帧。
  await expect(page.getByTestId('wechat-rendered-html')).toContainText('手机预览标题')
  const sourceHtml = await page.getByTestId('wechat-rendered-html').innerHTML()
  const normalizeHtml = (html: string) => page.evaluate((value) => {
    const template = document.createElement('template')
    template.innerHTML = value
    return template.innerHTML
  }, html)
  const createButton = page.getByRole('button', { name: '生成手机扫码预览', exact: true })
  const failMessage = 'QA26 分享服务暂不可用'
  let injectFailure = true
  await page.route(`**/api/v1/works/${work.id}/preview-link`, async (route) => {
    if (route.request().method() === 'POST' && injectFailure) {
      injectFailure = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'qa26_preview_unavailable', message: failMessage } }),
      })
    } else await route.continue()
  })
  const failedCreate = page.waitForResponse(response => response.url().endsWith(`/works/${work.id}/preview-link`) && response.request().method() === 'POST')
  await createButton.click()
  expect((await failedCreate).status()).toBe(503)
  await expect(page.getByText(failMessage, { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '手机扫码预览二维码' })).toHaveCount(0)
  await page.unroute(`**/api/v1/works/${work.id}/preview-link`)

  const clickLatencies: number[] = []
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now()
    const created = page.waitForResponse(response => response.url().endsWith(`/works/${work.id}/preview-link`) && response.request().method() === 'POST')
    await createButton.click()
    expect((await created).status()).toBe(200)
    await expect(createButton).toBeEnabled()
    await expect(page.getByRole('img', { name: '手机扫码预览二维码' })).toBeVisible()
    await expect(page.getByRole('link', { name: '打开手机预览', exact: true })).toBeVisible()
    await expect(page.getByText(/24 小时后过期/)).toBeVisible()
    clickLatencies.push(performance.now() - started)
  }
  const sortedLatencies = [...clickLatencies].sort((a, b) => a - b)
  const percentile = (p: number) => sortedLatencies[Math.ceil(p * sortedLatencies.length) - 1]
  console.log('QA26 G1-04 Web share clicks', JSON.stringify({
    count: clickLatencies.length,
    p50_ms: Number(percentile(0.5).toFixed(2)),
    p95_ms: Number(percentile(0.95).toFixed(2)),
    failures: 0,
    samples_ms: clickLatencies.map(value => Number(value.toFixed(2))),
  }))
  const link = await page.getByRole('link', { name: '打开手机预览' }).getAttribute('href')
  expect(new URL(link!).pathname).toMatch(/^\/preview\/[A-Za-z0-9_.-]+$/)

  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    expect((await anonymous.request.get('/api/v1/auth/me')).status()).toBe(401)
    const anonymousCreate = await anonymous.request.post(`/api/v1/works/${work.id}/preview-link`, { data: {} })
    expect(anonymousCreate.status()).toBe(401)
  } finally {
    await anonymous.close()
  }

  await page.context().clearCookies()
  await page.goto(link!)
  await expect(page.getByRole('heading', { name: 'OPT37 手机预览验收' })).toBeVisible()
  await expect(page.getByText('浏览器验收号')).toBeVisible()
  const publicHtml = await page.getByTestId('wechat-rendered-html').innerHTML()
  expect(await normalizeHtml(publicHtml)).toBe(await normalizeHtml(sourceHtml))
  expect(await page.getByTestId('wechat-rendered-html').locator('h2').evaluate(el => getComputedStyle(el).borderBottomColor)).toBe('rgb(47, 93, 98)')
  await expect(page.getByRole('button')).toHaveCount(0)
  console.log('QA26 G1-04 Web journey', JSON.stringify({ duration_ms: Number((performance.now() - journeyStarted).toFixed(2)) }))
})
