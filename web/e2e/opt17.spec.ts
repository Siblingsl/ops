import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

async function wechatDraft(page: Page) {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 's3cret-value-for-test' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)
  await page.goto(`/a/${account.id}`)
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  const humanText = '先明确要解决的问题，再把任务拆成能够完成的一小步。记录自己的过程，比追求复杂的方法更容易持续。'
  for (const section of work.sections) {
    const block = page.locator(`#sec-${section.id}`)
    await block.getByRole('button', { name: '起草本段', exact: true }).click()
    await expect(block.locator('.tiptap')).not.toBeEmpty()
    await block.locator('.tiptap').fill(humanText)
    await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections.find((s: any) => s.id === section.id).content_md.trim()).toBe(humanText)
  }
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900; canvas.height = 500
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f4e3c1'; ctx.fillRect(0, 0, 900, 500)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'local-cover.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  const image = await upload.json()
  const current = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, {
    title: '公众号主链路浏览器验收', summary: '这是本地模拟运营流程的测试摘要。', base_revision: current.revision,
    cover_asset_id: image.id, cover_crops: { '2.35_1': { x1: 0, y1: 0.2, x2: 1, y2: 0.6 }, '1_1': { x1: 0.2, y1: 0, x2: 0.75, y2: 1 } },
  })
  await finishChecks(page, id)
  await page.goto(`/works/${id}/push`)
  await expect(page.getByText('公众号主链路浏览器验收', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '写入草稿箱', exact: true }).click()
  await expect(page.getByText('已写入公众号草稿箱', { exact: true })).toBeVisible()
  const pushed = await api(page, 'GET', `/works/${id}`)
  expect(pushed.status).toBe('pushed')
  expect(pushed.wechat_draft_media_id).toMatch(/^mock-draft-/)
  expect(pushed.published_at).toBeNull()
  return { id, account }
}

test('OPT17 公众号逐段起草、人工确认检查后单篇写入草稿箱', async ({ page }) => {
  await wechatDraft(page)
})

test('OPT17 人工回填已发布后录入第一天节点数据', async ({ page }) => {
  const { id } = await wechatDraft(page)
  await page.reload()
  const publishedAt = await page.evaluate(() => {
    const d = new Date(Date.now() - 86_400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  await page.getByLabel(/^作品链接（可选）/).fill('https://mp.weixin.qq.com/s/local-opt17-test')
  await page.getByLabel('发布时间', { exact: true }).fill(publishedAt)
  await page.getByRole('button', { name: '标记为已发布', exact: true }).click()
  await expect(page.getByRole('button', { name: '录入数据', exact: true })).toBeVisible()
  const published = await api(page, 'GET', `/works/${id}`)
  expect(published.status).toBe('published')
  expect(published.locked).toBe(true)
  expect(published.published_url).toBe('https://mp.weixin.qq.com/s/local-opt17-test')
  await page.getByRole('button', { name: '录入数据', exact: true }).click()
  const drawer = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: '公众号主链路浏览器验收', exact: true }) })
  await drawer.getByLabel('阅读', { exact: true }).fill('1234')
  await drawer.getByLabel('点赞', { exact: true }).fill('56')
  await drawer.getByLabel('在看', { exact: true }).fill('12')
  await drawer.getByLabel('分享', { exact: true }).fill('8')
  await drawer.getByLabel('留言', { exact: true }).fill('4')
  await drawer.getByLabel('新增关注', { exact: true }).fill('3')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}/metrics`)).length).toBe(1)
  const [metric] = await api(page, 'GET', `/works/${id}/metrics`)
  expect(metric).toMatchObject({ day_offset: 1, reads: 1234, likes: 56, wows: 12, shares: 8, comments: 4, follows_gained: 3, source: 'manual' })
})
