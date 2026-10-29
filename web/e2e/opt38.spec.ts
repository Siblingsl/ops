import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT38 单篇 Markdown 导出保留标题、段落与图片顺序', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'Markdown 导出验收' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '这是本人输入的核心观点：清楚说明每一步，读者才能重复执行。', base_revision: work.revision })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [
      { heading: '第一段', key_point: '先确认顺序', material_ids: [] },
      { heading: '第二段', key_point: '再检查图片', material_ids: [] },
    ],
    confirm: true,
  })
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#456'
    ctx.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const images: { id: string }[] = []
  for (const index of [1, 2]) {
    const response = await page.request.post(`/api/v1/works/${work.id}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token },
      multipart: { file: { name: `opt38-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
    })
    expect(response.ok()).toBeTruthy()
    images.push(await response.json())
  }
  const [firstImage, secondImage] = images
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: `第一段正文。\n\n![第一张图片](/api/v1/assets/${firstImage.id}/file)`,
    base_revision: current.sections[0].revision,
  })
  await api(page, 'PATCH', `/sections/${current.sections[1].id}`, {
    content_md: `第二段正文。\n\n![第二张图片](/api/v1/assets/${secondImage.id}/file)`,
    base_revision: current.sections[1].revision,
  })

  await page.goto(`/works/${work.id}`)
  // 页面上有作品级 + 每段一个「更多」菜单；导出入口在作品级。
  await page.locator('.work-more').getByRole('button').click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出 Markdown', exact: true }).click()
  const file = await downloaded
  expect(file.suggestedFilename()).toBe('Markdown 导出验收.md')
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk)
  const markdown = Buffer.concat(chunks).toString('utf8')
  const firstAssetURL = new URL(`/api/v1/assets/${firstImage.id}/file`, page.url()).href
  const secondAssetURL = new URL(`/api/v1/assets/${secondImage.id}/file`, page.url()).href
  expect(markdown).toContain('# Markdown 导出验收')
  expect(markdown).toContain('第一段正文。')
  expect(markdown).toContain('第二段正文。')
  expect(markdown.indexOf('第一段正文。')).toBeLessThan(markdown.indexOf('第二段正文。'))
  expect(markdown.indexOf('## 第一段')).toBeLessThan(markdown.indexOf('## 第二段'))
  expect(markdown.indexOf(firstAssetURL)).toBeLessThan(markdown.indexOf('## 第二段'))
  expect(markdown.indexOf('## 第二段')).toBeLessThan(markdown.indexOf(secondAssetURL))
})
