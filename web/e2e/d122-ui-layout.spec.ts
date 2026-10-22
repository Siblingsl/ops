import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

async function enableElectronPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

async function expectNoHorizontalOverflow(page: Page) {
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>('*')).map((element) => {
      const rect = element.getBoundingClientRect()
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', text: element.innerText?.slice(0, 70), x: Math.round(rect.x), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
    }).filter((element) => element.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 2).sort((a, b) => b.right - a.right).slice(0, 12),
  }))
  if (width.document > width.viewport + 1) console.log('Horizontal overflow elements:', JSON.stringify(width.offenders))
  expect(width.document, `document width ${width.document}px exceeds viewport ${width.viewport}px`).toBeLessThanOrEqual(width.viewport + 1)
}

async function fillShortDraft(page: Page, id: string) {
  let work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: '先把要解决的问题说清楚，再选择一个今天能完成的小步骤。记录过程有助于持续改进。',
      base_revision: section.revision,
    })
  }
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '布局验收作品', base_revision: work.revision })
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d9e8ee'; context.fillRect(0, 0, 100, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const uploaded = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'local-layout-fixture.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') } },
  })
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy()
}

test('CL-01 Electron 版本恢复预览在桌面窄窗内完整显示', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  work = await api(page, 'PATCH', `/works/${id}`, { title: '历史版本标题', base_revision: work.revision })
  await api(page, 'POST', `/works/${id}/versions`)
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '当前版本标题', base_revision: work.revision })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/works/${id}`)
  await page.getByRole('button', { name: '版本', exact: true }).click()
  await expect(page.getByRole('heading', { name: '版本历史', exact: true })).toBeVisible()
  await page.getByRole('button').filter({ hasText: '历史版本标题' }).first().click()
  await expect(page.getByRole('button', { name: '返回列表', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复这个版本', exact: true })).toBeVisible()
  await expect(page.getByText(/与当前稿不同：/)).toBeVisible()
  await page.setViewportSize({ width: 1024, height: 768 })
  const panel = page.locator('.desktop-drawer-overlay > div')
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1025)
  await expectNoHorizontalOverflow(page)
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy()
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  expect(account.id).toBeTruthy()
})

test('CL-02 小红书发布包桌面双栏不重叠', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const id = await createOutline(page)
  await fillShortDraft(page, id)
  let work = await api(page, 'GET', `/works/${id}`)
  work = await api(page, 'PATCH', `/works/${id}`, { title: '发布包布局验收', topics: ['日常记录'], base_revision: work.revision })
  await finishChecks(page, id)
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'POST', `/works/${id}/xhs/pack`, { basis_revision: work.revision })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/works/${id}/pack`)
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  await expect(page.getByText('发布步骤', { exact: true })).toBeVisible()
  const columns = page.locator('main .grid').filter({ has: page.getByText('发布步骤', { exact: true }) })
  const left = await columns.locator(':scope > div').first().boundingBox()
  const right = await columns.locator(':scope > aside').boundingBox()
  expect(left).not.toBeNull()
  expect(right).not.toBeNull()
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1)
  await expectNoHorizontalOverflow(page)

  await page.setViewportSize({ width: 1024, height: 768 })
  await expectNoHorizontalOverflow(page)
  const narrowLeft = await columns.locator(':scope > div').first().boundingBox()
  const narrowRight = await columns.locator(':scope > aside').boundingBox()
  expect(narrowLeft).not.toBeNull()
  expect(narrowRight).not.toBeNull()
  expect(narrowLeft!.y + narrowLeft!.height).toBeLessThanOrEqual(narrowRight!.y + 1)
  expect(account.id).toBeTruthy()
})

test('CL-02 Web 手机发布包单栏内容不横向溢出', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  await fillShortDraft(page, id)
  let work = await api(page, 'GET', `/works/${id}`)
  work = await api(page, 'PATCH', `/works/${id}`, { title: '手机发布包布局验收', topics: ['日常记录'], base_revision: work.revision })
  await finishChecks(page, id)
  work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'POST', `/works/${id}/xhs/pack`, { basis_revision: work.revision })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/works/${id}/pack`)
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  for (const label of ['系统分享 / 复制', '复制伴侣深链', '下载图片 zip']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  expect(account.id).toBeTruthy()
})

test('CL-03 Electron 已发布更正表单和影响预览桌面窄窗内可读', async ({ page }) => {
  test.setTimeout(45_000)
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const id = await createOutline(page)
  await fillShortDraft(page, id)
  await finishChecks(page, id)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'POST', `/works/${id}/xhs/pack`, { basis_revision: work.revision })
  const publishedAt = new Date(Date.now() - 8 * 86_400_000)
  await api(page, 'POST', `/works/${id}/published`, {
    url: 'https://www.xiaohongshu.com/explore/original-note', published_at: publishedAt.toISOString(),
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/works/${id}/pack`)
  await expect(page.getByText('更正发布记录', { exact: true })).toBeVisible()
  await expect(page.getByLabel('更正后的作品链接')).toBeVisible()
  await expect(page.getByLabel('更正后的发布时间')).toBeVisible()
  await expect(page.getByLabel('更正原因')).toBeVisible()
  await page.getByLabel('更正后的作品链接').fill('https://www.xiaohongshu.com/explore/corrected-note')
  const correctedAt = new Date(Date.now() - 6 * 86_400_000)
  const dateInput = await page.evaluate((value) => {
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }, correctedAt.toISOString())
  await page.getByLabel('更正后的发布时间').fill(dateInput)
  await page.getByLabel('更正原因').fill('核对平台原文后修正链接和发布时间')
  const wideUrlInputBounds = await page.getByLabel('更正后的作品链接').boundingBox()
  expect(wideUrlInputBounds).not.toBeNull()
  expect(wideUrlInputBounds!.width).toBeGreaterThan(220)
  await expectNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1024, height: 768 })
  const previewButton = page.getByRole('button', { name: '预览更正影响', exact: true })
  await previewButton.scrollIntoViewIfNeeded()
  await expect(previewButton).toBeInViewport()
  await expect(previewButton).toBeEnabled()
  const urlInputBounds = await page.getByLabel('更正后的作品链接').boundingBox()
  expect(urlInputBounds).not.toBeNull()
  expect(urlInputBounds!.width).toBeGreaterThan(300)
  const previewResponse = page.waitForResponse((response) => response.url().includes(`/works/${id}/published?preview=true`))
  await previewButton.click()
  expect((await previewResponse).ok()).toBeTruthy()
  await expect(page.getByText('更正预览', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认更正', exact: true })).toBeEnabled()
  await expectNoHorizontalOverflow(page)

  expect(account.id).toBeTruthy()
})

test('CL-03 Web 手机更正表单和影响预览不横向溢出', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  await fillShortDraft(page, id)
  await finishChecks(page, id)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'POST', `/works/${id}/xhs/pack`, { basis_revision: work.revision })
  const publishedAt = new Date(Date.now() - 8 * 86_400_000)
  await api(page, 'POST', `/works/${id}/published`, {
    url: 'https://www.xiaohongshu.com/explore/original-note', published_at: publishedAt.toISOString(),
  })
  const correctedAt = new Date(Date.now() - 6 * 86_400_000)
  const dateInput = await page.evaluate((value) => {
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }, correctedAt.toISOString())

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/works/${id}/pack`)
  await page.getByLabel('更正后的作品链接').fill('https://www.xiaohongshu.com/explore/corrected-note')
  await page.getByLabel('更正后的发布时间').fill(dateInput)
  await page.getByLabel('更正原因').fill('核对平台原文后修正链接和发布时间')
  const previewButton = page.getByRole('button', { name: '预览更正影响', exact: true })
  await page.locator('main').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(previewButton).toBeInViewport()
  await previewButton.click()
  await expect(page.getByText('更正预览', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  expect(account.id).toBeTruthy()
})

test('CL-06 素材变化与不可用提示在 Electron 检查页内完整显示', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const id = await createOutline(page)
  await fillShortDraft(page, id)
  const material = await api(page, 'POST', '/materials', {
    account_id: account.id, kind: 'experience', content: '作者亲身经历：先拆小任务再逐项完成。', source: '作者记录',
  })
  let work = await api(page, 'GET', `/works/${id}`)
  work = await api(page, 'PATCH', `/works/${id}`, { material_ids: [material.id], base_revision: work.revision })
  await api(page, 'PUT', `/sections/${work.sections[0].id}/materials`, { material_ids: [material.id] })
  await finishChecks(page, id)
  await api(page, 'PATCH', `/materials/${material.id}`, {
    account_id: account.id, kind: 'experience', content: '作者补充记录：先拆小任务并记录每项耗时。', source: '更新后的作者记录',
  })
  const staleState = await api(page, 'GET', `/works/${id}/checks/latest`)
  expect(staleState.run.material_basis_stale).toBeTruthy()
  await page.route(`**/api/v1/works/${id}/checks`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试中保持旧检查状态' }) })
    : route.continue())

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(`/works/${id}/check`)
  const stale = page.getByText(/素材正文、来源、有效期、归属范围或引用关系已变化/)
  await expect(stale).toBeVisible()
  await expect(stale).toContainText('重新检查')
  await expectNoHorizontalOverflow(page)

  await api(page, 'DELETE', `/materials/${material.id}`)
  const unavailableState = await api(page, 'GET', `/works/${id}/checks/latest`)
  expect(unavailableState.run.material_basis_unavailable).toBeGreaterThan(0)
  await page.reload()
  await expect(page.getByText(/个素材引用已删除或不在当前作品可见范围内/)).toBeVisible()
  await expect(page.getByText(/素材正文、来源、有效期、归属范围或引用关系已变化/)).toBeVisible()
  await expectNoHorizontalOverflow(page)
})
