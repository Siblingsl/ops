import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { api, registerAccount } from './support'

test('OPT39 图片库替代文字保存后用于公众号排版和手机预览', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT39 图片库验收' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '这是本人输入的核心观点：清楚说明每一步，读者才能重复执行。', base_revision: work.revision })
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

test('DEV-QA26 G2-09 Web 编辑器进入完整图片库并复用到目标作品', async ({ page, browser }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const sourceA = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '图库来源作品甲' })
  const sourceB = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '图库来源作品乙' })
  const target = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '图库复用目标作品' })
  await page.goto('/images')
  await expect(page.getByText('图片库还是空的', { exact: true })).toBeVisible()
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const context = canvas.getContext('2d')!
    context.fillStyle = '#4f86d8'
    context.fillRect(0, 0, 96, 96)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = async (workId: string, name: string) => {
    const response = await page.request.post(`/api/v1/works/${workId}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token },
      multipart: { file: { name, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json() as Promise<{ id: string }>
  }
  const [asset, secondAsset, otherAsset] = await Promise.all([
    upload(sourceA.id, 'g2-library-a.png'), upload(sourceA.id, 'g2-library-b.png'), upload(sourceB.id, 'g2-library-c.png'),
  ])

  await page.goto(`/works/${target.id}`)
  const journeyStarted = performance.now()
  await page.getByRole('button', { name: '从图片库选择', exact: true }).click()
  const editorLibrary = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '从图片库选择', exact: true }) })
  await expect(editorLibrary.getByRole('button', { name: /图库来源作品甲/ })).toHaveCount(2)
  await editorLibrary.getByRole('button', { name: '打开完整图片库', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/images\\?target_work=${target.id}$`))

  const cards = page.locator('main button').filter({ hasText: /图库来源作品[甲乙]/ })
  await expect(cards).toHaveCount(3)
  const workFilter = page.getByLabel('按作品筛选')
  const latencies: number[] = []
  for (let index = 0; index < 20; index += 1) {
    const firstWork = index % 2 === 0
    const started = performance.now()
    await workFilter.selectOption(firstWork ? sourceA.id : sourceB.id)
    await expect(page.locator('main button').filter({ hasText: firstWork ? '图库来源作品甲' : '图库来源作品乙' })).toHaveCount(firstWork ? 2 : 1)
    latencies.push(performance.now() - started)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
  console.log('QA26 G2-09 Web filter interactions', JSON.stringify({
    count: latencies.length,
    p50_ms: Number(percentile(0.5).toFixed(2)),
    p95_ms: Number(percentile(0.95).toFixed(2)),
    failures: 0,
    samples_ms: latencies.map((value) => Number(value.toFixed(2))),
  }))

  await workFilter.selectOption('')
  await expect(cards).toHaveCount(3)
  await cards.filter({ has: page.locator(`img[src*="${asset.id}"]`) }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('image-source')).toContainText('图库来源作品甲')
  await expect(page.getByTestId('image-reuse-into-work')).toBeVisible()
  const saveRoute = (url: URL) => url.pathname === `/api/v1/assets/${asset.id}`
  let rejectNextSave = true
  await page.route(saveRoute, async (route) => {
    if (route.request().method() === 'PATCH' && rejectNextSave) {
      rejectNextSave = false
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '模拟图库保存失败' } }) })
    } else {
      await route.continue()
    }
  })
  const saveAltButton = dialog.getByRole('button', { name: '保存替代文字', exact: true })
  await dialog.getByLabel('替代文字').fill('蓝色方形图片说明')
  const failedSave = page.waitForResponse((response) => response.url().includes(`/assets/${asset.id}`) && response.request().method() === 'PATCH')
  await saveAltButton.click()
  expect((await failedSave).status()).toBe(503)
  expect(rejectNextSave).toBe(false)
  const saveError = page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: '模拟图库保存失败' })
  await expect(saveError).toBeVisible()
  await expect(dialog.getByLabel('替代文字')).toHaveValue('蓝色方形图片说明')
  expect((await api(page, 'GET', `/assets?account_id=${account.id}`)).find((item: { id: string }) => item.id === asset.id).alt_text).toBe('')
  await expect(saveError).toBeHidden({ timeout: 15_000 })
  await expect(saveAltButton).toBeEnabled()
  const saved = page.waitForResponse((response) => response.url().includes(`/assets/${asset.id}`) && response.request().method() === 'PATCH')
  await saveAltButton.click()
  expect((await saved).status()).toBe(200)
  expect((await api(page, 'GET', `/assets?account_id=${account.id}`)).find((item: { id: string }) => item.id === asset.id).alt_text).toBe('蓝色方形图片说明')

  const reuse = page.waitForResponse((response) => response.url().includes(`/works/${target.id}/assets/reuse`) && response.request().method() === 'POST')
  await page.getByTestId('image-reuse-into-work').click()
  const reuseResponse = await reuse
  expect(reuseResponse.status()).toBe(200)
  const reusedAsset = await reuseResponse.json() as { id: string; work_id: string; alt_text: string }
  expect(reusedAsset).toMatchObject({ work_id: target.id, alt_text: '蓝色方形图片说明' })
  expect(reusedAsset.id).not.toBe(asset.id)
  const targetAfterReuse = await api(page, 'GET', `/works/${target.id}`)
  expect(targetAfterReuse.assets.map((item: { id: string }) => item.id)).toContain(reusedAsset.id)
  expect(targetAfterReuse.assets.map((item: { id: string }) => item.id)).not.toContain(secondAsset.id)
  expect(targetAfterReuse.assets.map((item: { id: string }) => item.id)).not.toContain(otherAsset.id)
  console.log('QA26 G2-09 Web journey', JSON.stringify({ duration_ms: Number((performance.now() - journeyStarted).toFixed(2)) }))

  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 }) as { code: string }
  const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: `qa26-images-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    const viewerPage = await viewerContext.newPage()
    await viewerPage.goto('/images')
    const viewerCard = viewerPage.locator('main button').filter({ has: viewerPage.locator(`img[src*="${asset.id}"]`) })
    await expect(viewerCard).toBeVisible()
    await viewerCard.click()
    const viewerDialog = viewerPage.getByRole('dialog')
    await expect(viewerDialog.getByText('蓝色方形图片说明', { exact: true })).toBeVisible()
    await expect(viewerDialog.getByRole('textbox')).toHaveCount(0)
    await expect(viewerDialog.getByRole('button', { name: '保存替代文字', exact: true })).toHaveCount(0)
    const viewerMe = await api(viewerPage, 'GET', '/auth/me')
    const denied = await viewerContext.request.patch(`/api/v1/assets/${asset.id}`, {
      data: { alt_text: 'viewer 越权修改' }, headers: { 'X-CSRF-Token': viewerMe.csrf_token },
    })
    expect(denied.status()).toBe(403)
    expect((await api(page, 'GET', `/assets?account_id=${account.id}`)).find((item: { id: string }) => item.id === asset.id).alt_text).toBe('蓝色方形图片说明')
  } finally {
    await viewerContext.close()
  }
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
