import { expect, test } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

async function expectHeaderAction(page: import('@playwright/test').Page, name: string | RegExp) {
  const action = page.locator('header [data-testid="work-next-action"]')
  await expect(action).toBeVisible()
  await expect(action.getByRole('button', { name })).toBeVisible()
}

test('OPT62 公众号四阶段主操作共用页头，检查命令直达且不写入草稿', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await api(page, 'POST', '/auth/reauth', { password: 'local-e2e-password-123' })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx-opt62-mock', app_secret: 'mock-only-secret' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)
  await page.goto(`/a/${account.id}`)
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: 'OPT62 页头动作验收', base_revision: work.revision })
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先把目标拆成一步，再按顺序完成。', base_revision: section.revision })
  }
  work = await api(page, 'GET', `/works/${id}`)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 500
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f4e3c1'
    ctx.fillRect(0, 0, 900, 500)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'opt62-local-cover.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  const cover = await upload.json()
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, {
    cover_asset_id: cover.id,
    cover_crops: { '2.35_1': { x1: 0, y1: 0.2, x2: 1, y2: 0.6 }, '1_1': { x1: 0.2, y1: 0, x2: 0.75, y2: 1 } },
    base_revision: work.revision,
  })

  const pushRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/wechat\/push$|\/xhs\/pack$/.test(new URL(request.url()).pathname)) pushRequests.push(request.url())
  })
  await page.goto(`/works/${id}`)
  await expectHeaderAction(page, '排版并检查')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByPlaceholder(/搜索作品/).fill('检查')
  const goCheck = palette.getByRole('button', { name: '去检查', exact: true })
  await expect(goCheck).toBeVisible()
  await goCheck.click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/check$`))
  await expectHeaderAction(page, '确认完成检查')
  await finishChecks(page, id)
  await expectHeaderAction(page, '去写入草稿箱')

  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  const pushPalette = page.getByRole('dialog', { name: '命令面板' })
  await pushPalette.getByPlaceholder(/搜索作品/).fill('写入草稿')
  await pushPalette.getByRole('button', { name: '去写入草稿箱', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/push$`))
  await expectHeaderAction(page, '写入草稿箱')

  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  const previewPalette = page.getByRole('dialog', { name: '命令面板' })
  await previewPalette.getByPlaceholder(/搜索作品/).fill('排版')
  await previewPalette.getByRole('button', { name: '打开排版预览', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/preview$`))
  await page.goto(`/works/${id}/preview`)
  await expectHeaderAction(page, '下一步：发布前检查')
  await page.goto(`/works/${id}/push`)
  await expectHeaderAction(page, '写入草稿箱')
  await expect(page.getByText('每次只写入这一篇，由你亲自点击。系统不会发表或群发。')).toBeVisible()
  expect(pushRequests).toEqual([])
})

test('OPT62 小红书命令面板打开当前作品发布包与派生，生成入口仍由人工点击', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT62 小红书命令验收' })
  const packRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/xhs/pack')) packRequests.push(request.url())
  })
  await page.goto(`/works/${work.id}`)
  await expect(page.getByRole('button', { name: '搜索 Ctrl K' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByPlaceholder(/搜索作品/).fill('发布包')
  await palette.getByRole('button', { name: '去生成发布包', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}/pack$`))
  await expect(page.getByText('发布前检查还没有全部确认，不能生成发布包。')).toBeVisible()

  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  const derivePalette = page.getByRole('dialog', { name: '命令面板' })
  await derivePalette.getByPlaceholder(/搜索作品/).fill('派生')
  await derivePalette.getByRole('button', { name: '派生到其他账号', exact: true }).click()
  await expect(page.getByRole('heading', { name: '派生到其他平台' })).toBeVisible()

  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.goto(`/a/${account.id}`)
  const readyID = await createOutline(page)
  let readyWork = await api(page, 'GET', `/works/${readyID}`)
  await api(page, 'PATCH', `/works/${readyID}`, { title: 'OPT62 发布包页头验收', base_revision: readyWork.revision })
  for (const section of readyWork.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '先确认每条内容，再生成单篇发布包。', base_revision: section.revision })
  }
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 600
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f4e3c1'
    ctx.fillRect(0, 0, 600, 600)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${readyID}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'opt62-xhs-image.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  await finishChecks(page, readyID)
  await page.goto(`/works/${readyID}/pack`)
  await expectHeaderAction(page, '生成发布包')
  expect(packRequests).toEqual([])
})
