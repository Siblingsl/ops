import { expect, test } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

test('TP-01 收件箱"丢掉"可以撤销', async ({ page }) => {
  const account = await registerAccount(page)
  const item = await api(page, 'POST', '/inbox', { content: '一条打算丢掉的灵感', account_id: account.id })
  await page.goto(`/a/${account.id}/topics?tab=inbox`)
  await expect(page.getByText('一条打算丢掉的灵感')).toBeVisible()

  await page.getByRole('button', { name: '丢掉', exact: true }).first().click()
  await expect(page.getByText('已丢掉「一条打算丢掉的灵感」')).toBeVisible()
  // 丢掉后列表直接消失（回到空状态），这就是"已移除"的可见反馈。
  await expect(page.locator('.inbox-panel-list')).toHaveCount(0)

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByText('已恢复这条灵感')).toBeVisible()
  await expect(page.locator('.inbox-panel-list')).toContainText('一条打算丢掉的灵感')
  expect(item.id).toBeTruthy()
})

test('XC-04 作品页请求失败显示"加载失败"与重试，而不是空状态', async ({ page }) => {
  await registerAccount(page)
  await page.route(`**/api/v1/accounts/*/works?q=*`, (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务暂不可用' } }),
  }))
  await page.goto('/a')
  await page.getByRole('link', { name: '作品' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert.getByText('加载失败')).toBeVisible()
  await expect(alert.getByText('服务暂不可用')).toBeVisible()
  await expect(alert.getByRole('button', { name: '重试' })).toBeVisible()
  // 不能显示成"这里还没有作品"。
  await expect(page.getByText('这里还没有作品')).toHaveCount(0)
})

test('CK-02 检查完成页面底部有下一步按钮', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '底部下一步', base_revision: work.revision })
  work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这一段写清楚了结论和理由。', base_revision: section.revision })
  }
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600; canvas.height = 600
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f4e3c1'; ctx.fillRect(0, 0, 600, 600)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'ck02.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  await finishChecks(page, id)

  await page.goto(`/works/${id}/check`)
  const next = page.getByRole('button', { name: '下一步：生成发布包' })
  await expect(next).toBeVisible()
  await next.click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/pack$`))
})
