import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

/**
 * DEV-CX10 / FR-CX-11：正文编辑器粘贴图片入库（单图）。
 *
 * 断言的是"用户看得见的行为"：同字节在本作品内复用已有图片位、换作品不复用、
 * 上传期间正文被改动就不自动插入、多图进本地待处理队列逐张确认（Q-CX-05，90 D-165）、
 * 图文混排给明确提示。
 * 服务端同口径（转码后字节 sha256）由 `server/internal/app/cx11_asset_dedupe_test.go` 覆盖。
 */

/** 生成一张确定性的 PNG（同一浏览器里每次字节完全一致，跨导航复用 base64）。 */
async function pngBase64(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#2f6fed'
    ctx.fillRect(0, 0, 96, 96)
    ctx.fillStyle = '#f5a524'
    ctx.fillRect(12, 12, 40, 40)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  })
}

async function seedPng(page: Page, base64: string) {
  await page.evaluate((value) => {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    const store = ((window as any).__cx11Png ??= {}) as Record<string, Uint8Array>
    store.a = bytes
  }, base64)
}

/** 在编辑器 DOM 上派发真实 ClipboardEvent；返回 defaultPrevented，用于确认编辑器接住了这次粘贴。 */
async function paste(page: Page, selector: string, opts: { count?: number; text?: string } = {}) {
  return page.evaluate(({ selector, opts }) => {
    const host = document.querySelector(selector) as HTMLElement | null
    if (!host) throw new Error(`找不到编辑器：${selector}`)
    const bytes = ((window as any).__cx11Png ?? {}).a as Uint8Array | undefined
    const data = new DataTransfer()
    if (bytes) for (let i = 0; i < (opts.count ?? 1); i++) data.items.add(new File([bytes], `paste-${i}.png`, { type: 'image/png' }))
    if (opts.text) data.setData('text/plain', opts.text)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    return event.defaultPrevented
  }, { selector, opts })
}

async function wechatWork(page: Page, accountId: string, title: string, heading: string) {
  const work = await api(page, 'POST', `/accounts/${accountId}/works`, { title, content_format: 'long_article' })
  // H-02：确认大纲前必须先写下自己的核心观点，这是人机分工门禁，不能在夹具里绕开。
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '粘贴入库验收：先确认图片属于哪篇作品，再决定是否复用同一张图。', base_revision: work.revision,
  })
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: viewed.revision,
    items: [{ heading, key_point: '粘贴入库验收', material_ids: [] }],
  })
  return outlined as { id: string; sections: { id: string }[] }
}

const dedupeUpload = /\/api\/v1\/works\/[^/]+\/assets\?dedupe=sha256$/

test('CX11 浏览器粘贴图片按本作品 sha256 去重', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await wechatWork(page, account.id, '粘贴入库', '第一段')
  const sectionId = work.sections[0].id
  const png = await pngBase64(page)

  await page.goto(`/works/${work.id}`)
  const selector = `#sec-${sectionId} .ProseMirror`
  const editor = page.locator(selector)
  await expect(editor).toBeVisible()
  await seedPng(page, png)

  const first = page.waitForResponse((r) => dedupeUpload.test(r.url()) && r.request().method() === 'POST')
  expect(await paste(page, selector)).toBeTruthy()
  const firstBody = await (await first).json()
  expect(firstBody.reused).toBe(false)
  await expect(editor.locator('img')).toHaveCount(1)
  let current = await api(page, 'GET', `/works/${work.id}`)
  expect(current.assets).toHaveLength(1)
  const assetId = current.assets[0].id as string
  await expect(editor.locator('img')).toHaveAttribute('src', new RegExp(`/api/v1/assets/${assetId}/file`))

  // 同字节再粘一次：复用已有图片位，作品图片列表不新增。
  const second = page.waitForResponse((r) => dedupeUpload.test(r.url()) && r.request().method() === 'POST')
  expect(await paste(page, selector)).toBeTruthy()
  const secondBody = await (await second).json()
  expect(secondBody.reused).toBe(true)
  expect(secondBody.id).toBe(assetId)
  // 复用的是图片位，不是"忽略这次粘贴"：正文里仍然按用户操作插入第二处引用。
  await expect(editor.locator('img')).toHaveCount(2)
  current = await api(page, 'GET', `/works/${work.id}`)
  expect(current.assets).toHaveLength(1)

  // 换一篇作品粘同一张图：去重只在作品内生效，另一篇作品要有自己的图片位。
  const other = await wechatWork(page, account.id, '另一篇', '另一段')
  await page.goto(`/works/${other.id}`)
  const otherSelector = `#sec-${other.sections[0].id} .ProseMirror`
  await expect(page.locator(otherSelector)).toBeVisible()
  await seedPng(page, png)
  const third = page.waitForResponse((r) => dedupeUpload.test(r.url()) && r.request().method() === 'POST')
  expect(await paste(page, otherSelector)).toBeTruthy()
  const thirdBody = await (await third).json()
  expect(thirdBody.reused).toBe(false)
  expect(thirdBody.id).not.toBe(assetId)
  expect(thirdBody.work_id).toBe(other.id)
  expect((await api(page, 'GET', `/works/${other.id}`)).assets).toHaveLength(1)
})

test('CX11 粘贴图片的锚点保护与多图、图文混排提示', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await wechatWork(page, account.id, '粘贴保护', '第一段')
  const sectionId = work.sections[0].id

  await page.goto(`/works/${work.id}`)
  const selector = `#sec-${sectionId} .ProseMirror`
  const editor = page.locator(selector)
  await expect(editor).toBeVisible()
  await seedPng(page, await pngBase64(page))

  // 1) 上传途中正文被改动：图片照样入库，但不自动插入到旧锚点，并明确告知。
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let markStarted!: () => void
  const uploadStarted = new Promise<void>((resolve) => { markStarted = resolve })
  await page.route(dedupeUpload, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    markStarted()
    await gate
    await route.fulfill({ response: await route.fetch() })
  })
  expect(await paste(page, selector)).toBeTruthy()
  await uploadStarted
  await editor.click()
  await page.keyboard.type('上传途中补写的一句')
  release()
  await expect(page.getByText(/图片已入库但没有自动插入/)).toBeVisible()
  await expect(editor.locator('img')).toHaveCount(0)
  expect((await api(page, 'GET', `/works/${work.id}`)).assets).toHaveLength(1)
  await page.unroute(dedupeUpload)

  // 2) 多图一次粘贴：进入本地待处理队列，逐张确认后才入库（Q-CX-05，90 D-165）。
  let uploads = 0
  page.on('request', (r) => { if (r.method() === 'POST' && dedupeUpload.test(r.url())) uploads++ })
  expect(await paste(page, selector, { count: 3 })).toBeTruthy()
  await expect(page.getByText(/已加入待处理队列（3 张）/)).toBeVisible()
  const queue = page.getByTestId('paste-image-queue')
  await expect(queue).toBeVisible()
  await expect(queue.getByTestId('paste-queue-item')).toHaveCount(3)
  await page.waitForTimeout(600)
  expect(uploads).toBe(0)
  expect((await api(page, 'GET', `/works/${work.id}`)).assets).toHaveLength(1)

  // 移除一项：不入库，队列变 2；逐张确认后同字节复用同一图片位。
  const items = queue.getByTestId('paste-queue-item')
  await items.nth(0).getByRole('button', { name: '移除该图片' }).click()
  await expect(items).toHaveCount(2)
  await items.nth(0).getByRole('button', { name: '确认入库' }).click()
  await expect(items.nth(0).getByText('已入库')).toBeVisible()
  await expect(editor.locator('img')).toHaveCount(1)
  await items.nth(1).getByRole('button', { name: '确认入库' }).click()
  await expect(items.nth(1).getByText('已入库')).toBeVisible()
  await expect(editor.locator('img')).toHaveCount(2)
  expect(uploads).toBe(2)
  expect((await api(page, 'GET', `/works/${work.id}`)).assets).toHaveLength(1)

  // 失败可单项重试：第一次上传被中断 → 队列项标失败 → 重试成功入库。
  let attempts = 0
  await page.route(dedupeUpload, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts += 1
    if (attempts === 1) return route.abort()
    return route.continue()
  })
  expect(await paste(page, selector, { count: 2 })).toBeTruthy()
  await expect(queue.getByTestId('paste-queue-item')).toHaveCount(4)
  const retryItem = items.nth(2)
  await retryItem.getByRole('button', { name: '确认入库' }).click()
  await expect(retryItem.getByText('入库失败')).toBeVisible()
  await expect(editor.locator('img')).toHaveCount(2)
  await retryItem.getByRole('button', { name: '重试' }).click()
  await expect(retryItem.getByText('已入库')).toBeVisible()
  await expect(editor.locator('img')).toHaveCount(3)
  // 前 2 张成功 + 失败重试各发一次（被中断的那次也计入请求数）。
  expect(uploads).toBe(4)
  await page.unroute(dedupeUpload)

  // 3) 图文混排：只粘文字，图片不静默丢弃，也不上传（正文维持前面队列已插入的 3 张）。
  expect(await paste(page, selector, { text: '只粘这段文字' })).toBeTruthy()
  await expect(page.getByText(/剪贴板里同时有文字和图片/)).toBeVisible()
  await expect(editor).toContainText('只粘这段文字')
  await expect(editor.locator('img')).toHaveCount(3)
  await page.waitForTimeout(600)
  expect(uploads).toBe(4)
  expect((await api(page, 'GET', `/works/${work.id}`)).assets).toHaveLength(1)
})

test('DEV-QA26 G4-06 Web 自动保存、图片粘贴与手动版本重载（20次样本）', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await wechatWork(page, account.id, 'G4-06 自动保存与版本', '正文段落')
  const sectionId = work.sections[0].id
  await page.goto(`/works/${work.id}`)
  const selector = `#sec-${sectionId} .ProseMirror`
  const editor = page.locator(selector)
  await expect(editor).toBeVisible()

  const samples: number[] = []
  for (let i = 1; i <= 20; i++) {
    const text = `QA26 自动保存样本 ${String(i).padStart(2, '0')}：本次输入已从 Web 编辑器保存。`
    const started = performance.now()
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/sections/${sectionId}`) && response.request().method() === 'PATCH')
    await editor.fill(text)
    expect((await saved).ok()).toBeTruthy()
    await expect.poll(async () => {
      const current = await api(page, 'GET', `/works/${work.id}`)
      return current.sections.find((section: { id: string; content_md: string }) => section.id === sectionId)?.content_md ?? ''
    }).toContain(text)
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = (sorted[9] + sorted[10]) / 2
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  console.log(`DEV-QA26 G4-06 Web autosave ms: n=${samples.length} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} failures=0`)

  await seedPng(page, await pngBase64(page))
  await editor.click()
  await page.keyboard.press('Control+End')
  const uploaded = page.waitForResponse((response) => dedupeUpload.test(response.url()) && response.request().method() === 'POST')
  expect(await paste(page, selector)).toBeTruthy()
  const uploadResponse = await uploaded
  expect(uploadResponse.ok()).toBeTruthy()
  const asset = await uploadResponse.json() as { id: string }
  await expect(editor.locator('img')).toHaveCount(1)
  const assetPath = `/api/v1/assets/${asset.id}/file`
  await expect.poll(async () => {
    const current = await api(page, 'GET', `/works/${work.id}`)
    return current.sections.find((section: { id: string; content_md: string }) => section.id === sectionId)?.content_md ?? ''
  }).toContain(assetPath)

  await page.locator('.work-history').click()
  await expect(page.getByRole('heading', { name: '版本历史' })).toBeVisible()
  const versionSaved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${work.id}/versions`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '保存当前版本', exact: true }).click()
  expect((await versionSaved).ok()).toBeTruthy()
  await expect(page.getByText('手动保存', { exact: true }).first()).toBeVisible()
  const versions = await api(page, 'GET', `/works/${work.id}/versions`) as Array<{ version_no: number; reason: string }>
  const manual = versions.find((version) => version.reason === 'manual')
  expect(manual).toBeTruthy()
  const detail = await api(page, 'GET', `/works/${work.id}/versions/${manual!.version_no}`) as { snapshot: unknown }
  expect(JSON.stringify(detail.snapshot)).toContain(assetPath)

  await page.reload()
  const reloadedEditor = page.locator(selector)
  await expect(reloadedEditor).toContainText('QA26 自动保存样本 20')
  await expect(reloadedEditor.locator('img')).toHaveCount(1)
  const persisted = await api(page, 'GET', `/works/${work.id}`)
  expect(persisted.sections.find((section: { id: string; content_md: string }) => section.id === sectionId)?.content_md).toContain(assetPath)
  const persistedVersions = await api(page, 'GET', `/works/${work.id}/versions`) as Array<{ version_no: number; reason: string }>
  expect(persistedVersions.some((version) => version.version_no === manual!.version_no && version.reason === 'manual')).toBeTruthy()

  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 }) as { code: string }
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const viewer = await viewerContext.newPage()
    await viewer.goto('/register')
    await viewer.getByLabel('用户名', { exact: true }).fill(`qa26-g406-viewer-${Date.now()}`)
    await viewer.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await viewer.getByLabel('邀请码（可选）').fill(invite.code)
    await viewer.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => viewer.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const viewerMe = await viewer.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { role: string }
    expect(viewerMe.role).toBe('viewer')
    await viewer.goto(`/works/${work.id}`)
    const viewerEditor = viewer.locator(selector)
    await expect(viewerEditor).toBeVisible()
    await expect(viewerEditor).toHaveAttribute('contenteditable', 'false')
    await seedPng(viewer, await pngBase64(viewer))
    let uiUploadRequests = 0
    viewer.on('request', (request) => {
      if (request.method() === 'POST' && dedupeUpload.test(request.url())) uiUploadRequests += 1
    })
    expect(await paste(viewer, selector)).toBeFalsy()
    await viewer.waitForTimeout(600)
    expect(uiUploadRequests).toBe(0)
    const forbiddenStatus = await viewer.evaluate(async (targetWorkId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const bytes = ((window as any).__cx11Png as { a: Uint8Array }).a
      const body = new FormData()
      body.append('file', new File([bytes], 'viewer-forbidden.png', { type: 'image/png' }))
      const response = await fetch(`/api/v1/works/${targetWorkId}/assets?dedupe=sha256`, {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body,
      })
      return response.status
    }, work.id)
    expect(forbiddenStatus).toBe(403)
  } finally {
    await viewerContext.close()
  }

  const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 }) as { code: string }
  const editorContext = await browser.newContext({ baseURL })
  try {
    const editorMember = await editorContext.newPage()
    await editorMember.goto('/register')
    await editorMember.getByLabel('用户名', { exact: true }).fill(`qa26-g406-editor-${Date.now()}`)
    await editorMember.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await editorMember.getByLabel('邀请码（可选）').fill(editorInvite.code)
    await editorMember.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => editorMember.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const editorMe = await editorMember.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { role: string }
    expect(editorMe.role).toBe('editor')
    await editorMember.goto(`/works/${work.id}`)
    const memberEditor = editorMember.locator(selector)
    await expect(memberEditor).toBeVisible()
    await expect(memberEditor).toHaveAttribute('contenteditable', 'true')
    const memberText = 'QA26 editor 邀请成员保存后由服务端读回。'
    const memberSaved = editorMember.waitForResponse((response) => response.url().endsWith(`/api/v1/sections/${sectionId}`) && response.request().method() === 'PATCH')
    await memberEditor.fill(memberText)
    expect((await memberSaved).ok()).toBeTruthy()
    const memberWork = await api(editorMember, 'GET', `/works/${work.id}`)
    expect(memberWork.sections.find((section: { id: string; content_md: string }) => section.id === sectionId)?.content_md).toContain(memberText)
  } finally {
    await editorContext.close()
  }
})
