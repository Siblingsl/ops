import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT37 扫码预览公开展示与当前公众号主题相同的只读排版', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT37 手机预览验收' })
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
  const sourceHtml = await page.getByTestId('wechat-rendered-html').innerHTML()
  const normalizeHtml = (html: string) => page.evaluate((value) => {
    const template = document.createElement('template')
    template.innerHTML = value
    return template.innerHTML
  }, html)
  await page.getByRole('button', { name: '生成手机扫码预览' }).click()
  await expect(page.getByRole('img', { name: '手机扫码预览二维码' })).toBeVisible()
  await expect(page.getByText(/24 小时后过期/)).toBeVisible()
  const link = await page.getByRole('link', { name: '打开手机预览' }).getAttribute('href')
  expect(new URL(link!).pathname).toMatch(/^\/preview\/[A-Za-z0-9_.-]+$/)

  await page.context().clearCookies()
  await page.goto(link!)
  await expect(page.getByRole('heading', { name: 'OPT37 手机预览验收' })).toBeVisible()
  await expect(page.getByText('浏览器验收号')).toBeVisible()
  const publicHtml = await page.getByTestId('wechat-rendered-html').innerHTML()
  expect(await normalizeHtml(publicHtml)).toBe(await normalizeHtml(sourceHtml))
  expect(await page.getByTestId('wechat-rendered-html').locator('h2').evaluate(el => getComputedStyle(el).borderBottomColor)).toBe('rgb(47, 93, 98)')
  await expect(page.getByRole('button')).toHaveCount(0)
})
