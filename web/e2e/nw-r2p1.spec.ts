import { expect, test } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

test('DB-02/DB-03 待回填与待办列给"查看全部"，不再静默截断', async ({ page }) => {
  const account = await registerAccount(page)
  // 造 4 篇作品（drafting），验证"全部作品待办"分组在超过 6 条时给"查看全部（N）"。
  for (let i = 0; i < 7; i++) await api(page, 'POST', `/accounts/${account.id}/works`, { title: `作品${i}` })
  await page.goto(`/a/${account.id}`)
  const allTodos = page.getByRole('heading', { name: '全部作品待办' })
  await expect(allTodos).toBeVisible()
  // "进行中"分组有 7 条，超过 6 条必须给可点的"查看全部（N）"。
  const viewAll = page.getByRole('link', { name: /查看全部（\d+）/ })
  await expect(viewAll.first()).toBeVisible()
  await expect(viewAll.first()).toHaveAttribute('href', /\/works\?status=/)

  // 待回填区块：没有待回填时不出现"查看全部待回填"，也不显示三级路径文案。
  await expect(page.getByText('展开「更多工作台信息')).toHaveCount(0)
})

test('WL-01 可发布状态的行点击进入发布页，而不是编辑器', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '可发布的作品', base_revision: work.revision })
  work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这一段写清楚了结论和理由。', base_revision: section.revision })
  }
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600; canvas.height = 600
    canvas.getContext('2d')!.fillStyle = '#f4e3c1'; canvas.getContext('2d')!.fillRect(0, 0, 600, 600)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'wl01.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  await finishChecks(page, id)
  expect((await api(page, 'GET', `/works/${id}`)).status).toBe('ready')

  await page.goto(`/a/${account.id}/works`)
  // 只取作品列表里的行（侧栏"最近打开"也链到同一篇）。
  const row = page.getByTestId('work-row-link').filter({ hasText: '可发布的作品' }).first()
  await expect(row).toHaveAttribute('href', new RegExp(`/works/${id}/pack$`))
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/pack$`))
})

test('ED-04 预览页按状态给下一步，不再固定"发布前检查"', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  await page.goto(`/works/${id}`)
  await page.goto(`/works/${id}/preview`)
  // drafting：给"去检查"。
  await expect(page.getByRole('button', { name: '去检查' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步：发布前检查' })).toHaveCount(0)
})
