import { test, expect } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT10 摘要列表按需查看编辑全文，标签与插入保留全文，作品打开不预取', async ({ page }) => {
  const account = await registerAccount(page)
  const original = '素材正文完整事实。'.repeat(50) + '超出摘要的完整尾标'
  const material = await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: original })
  let details = 0
  let lists = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() !== 'GET') return
    if (url.pathname === `/api/v1/materials/${material.id}`) details++
    if (url.pathname === '/api/v1/materials') lists++
  })
  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByRole('button', { name: '查看全文', exact: true })).toBeVisible()
  expect(details).toBe(0)
  const list = await api(page, 'GET', `/materials?account_id=${account.id}`)
  expect(list[0].content).toBe(original.slice(0, 120))
  await page.getByRole('button', { name: '查看全文', exact: true }).click()
  await expect(page.getByRole('heading', { name: '素材全文', exact: true })).toBeVisible()
  await expect(page.getByText(original, { exact: true })).toBeVisible()
  expect(details).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '素材全文', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editing = page.getByRole('dialog').filter({ hasText: '编辑素材' })
  const content = editing.getByPlaceholder('写下具体的事实、经历或观点。AI 起草时只会引用你选中的素材。')
  await expect(content).toHaveValue(original)
  const updated = original + '编辑后的尾标'
  await content.fill(updated)
  await editing.getByRole('button', { name: '保存', exact: true }).click()
  expect((await api(page, 'GET', `/materials/${material.id}`)).content).toBe(updated)
  let suggested = ''
  await page.route('**/api/v1/materials/tag-suggest', async route => {
    suggested = route.request().postDataJSON().content
    await route.fulfill({ json: { kind: 'experience', tags: ['验收标签'], reason: '本地建议' } })
  })
  await page.getByRole('button', { name: '多选', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择这条素材' }).check()
  await page.getByRole('button', { name: '为选中的建议标签', exact: true }).click()
  const tagging = page.getByRole('heading', { name: '为 1 条素材建议标签', exact: true }).locator('..').locator('..').locator('..')
  await expect(tagging.getByRole('button', { name: '接受', exact: true })).toBeVisible()
  expect(suggested).toBe(updated)
  await tagging.getByRole('button', { name: '接受', exact: true }).click()
  await expect(tagging.getByText('已应用', { exact: true })).toBeVisible()
  expect((await api(page, 'GET', `/materials/${material.id}`)).content).toBe(updated)
  await page.keyboard.press('Escape')
  await page.goto(`/a/${account.id}`)
  const id = await createOutline(page)
  await api(page, 'PATCH', `/works/${id}`, { material_ids: [material.id] })
  await page.evaluate(() => localStorage.setItem('ops.editor.sidebar', '0'))
  lists = 0; details = 0
  await page.goto(`/works/${id}`)
  await expect(page.getByText('已关联 1 条素材，打开素材选择框可查看。', { exact: true })).toBeVisible()
  expect(lists).toBe(0)
  expect(details).toBe(0)
  const request = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/materials')
  await page.getByTitle('打开助手侧栏：素材推荐、副驾驶、体检、待核实、批注、动态').click()
  expect((await (await request).json())[0].content.length).toBe(120)
  await page.getByRole('button', { name: '选择素材', exact: true }).click()
  const picker = page.getByRole('dialog').filter({ hasText: '选择参考素材' })
  const tail = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === '超出摘要的完整尾标')
  await picker.getByPlaceholder('搜索素材内容、来源或类型…').fill('超出摘要的完整尾标')
  expect((await (await tail).json())[0].id).toBe(material.id)
  await expect(picker.getByText(updated.slice(0, 120), { exact: true })).toBeVisible()
  const kind = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === '经历')
  await picker.getByPlaceholder('搜索素材内容、来源或类型…').fill('经历')
  await kind
  await expect(picker.getByText(updated.slice(0, 120), { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.route(`**/api/v1/accounts/${account.id}/retrieve`, route => route.fulfill({ json: {
    items: [{ id: material.id, type: 'material', content: '截短的检索预览', reason: '本地验收' }], mode: 'text',
  } }))
  const work = await api(page, 'GET', `/works/${id}`)
  const section = work.sections[0]
  await page.locator(`#sec-${section.id} textarea`).first().focus()
  await expect(page.getByText('截短的检索预览', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '插入引用', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).sections[0].content_md).toContain(updated)
  expect(details).toBeGreaterThan(0)
})
