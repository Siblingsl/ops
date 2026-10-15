import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT39 图片库替代文字保存后用于公众号排版和手机预览', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT39 图片库验收' })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '图片说明', key_point: '保存替代文字', material_ids: [] }], confirm: true,
  })
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#e5a34b'
    ctx.fillRect(0, 0, 8, 8)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const uploaded = await page.request.post(`/api/v1/works/${work.id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'opt39-image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy()
  const asset = await uploaded.json()
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: `![旧描述](/api/v1/assets/${asset.id}/file)`, base_revision: current.sections[0].revision,
  })

  await page.goto('/images')
  await page.getByRole('button').filter({ hasText: 'OPT39 图片库验收' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('替代文字').fill('一盏橘色台灯照亮木质书桌')
  await dialog.getByRole('button', { name: '保存替代文字', exact: true }).click()
  await expect(page.getByText('替代文字已保存', { exact: true })).toBeVisible()

  await page.goto(`/works/${work.id}/preview`)
  await expect(page.getByTestId('wechat-rendered-html').locator('img')).toHaveAttribute('alt', '一盏橘色台灯照亮木质书桌')
  await page.getByRole('button', { name: '生成手机扫码预览' }).click()
  const link = await page.getByRole('link', { name: '打开手机预览' }).getAttribute('href')
  await page.context().clearCookies()
  await page.goto(link!)
  await expect(page.getByTestId('wechat-rendered-html').locator('img')).toHaveAttribute('alt', '一盏橘色台灯照亮木质书桌')
})

test('OPT39 小红书文字卡片输出 3:4 图片', async ({ page }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT39 小红书尺寸验收' })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '文字卡片', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '生成文字卡片' }) })
  await dialog.getByLabel('标题').fill('小红书封面尺寸')
  await dialog.getByLabel('正文').fill('生成的文字卡片默认使用竖版比例。')
  const uploaded = page.waitForResponse(r => r.url().endsWith(`/api/v1/works/${work.id}/assets`) && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '导出这张并加入图片', exact: true }).click()
  const asset = await (await uploaded).json()
  expect(asset.width).toBe(1242)
  expect(asset.height).toBe(1656)
})
