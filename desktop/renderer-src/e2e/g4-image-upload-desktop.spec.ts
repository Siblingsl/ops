import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// DEV-QA26（26 台账 G4-09）：编辑器「上传图片」按钮的 file chooser 路径此前只有
// 粘贴（cx11）与 Agent 附件覆盖；这里用真实文件选择路径补齐：多张入库、非法类型拒绝、删除确认。

/** Electron 窗口的 page.request 没有 context baseURL，与 cx11 相同走页面内 fetch。 */
async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

type Launched = { app: Awaited<ReturnType<typeof _electron.launch>>; page: Page }

async function launch(baseURL: string | undefined, tag: string): Promise<Launched & { origin: string }> {
  const userData = await mkdtemp(join(tmpdir(), `ops-g4-upload-${tag}-`))
  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const app = await _electron.launch({
    executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  // Electron 首窗是 about:blank 且没有 context baseURL，相对路径 goto 会报 invalid URL；
  // 注册与后续导航都走绝对 URL（与 cx11-paste 的 launch 相同口径）。
  await page.goto(`${origin}/register`)
  const username = `g4-upload-${tag}-${Date.now()}`
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  ;(page as unknown as { __userData?: string }).__userData = userData
  return { app, page, origin }
}

async function shutdown(app: Awaited<ReturnType<typeof _electron.launch>> | undefined, page: Page) {
  // Electron 在 Windows 上偶发不响应 close 握手，先 exit 再 close，避免 worker teardown 超时。
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app?.close().catch(() => {})
  const userData = (page as unknown as { __userData?: string }).__userData
  if (userData) await rm(userData, { recursive: true, force: true })
}

/** 在页面里用 canvas 生成一张 96×96 真实 PNG（服务端会解码校验像素，1×1 占位 PNG 会被 422 拒绝）。 */
async function pngBase64(page: Page, color: string): Promise<string> {
  return page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, 96, 96)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }, color)
}

async function xhsWorkWithSection(page: Page, origin: string, accountID: string, title: string) {
  let work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { content_format: 'image_note' })
  work = await api(page, origin, 'PATCH', `/works/${work.id}`, { title, viewpoint: '上传走查：图片是配图不是观点。', base_revision: work.revision })
  work = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
    items: [{ heading: '第一段', key_point: '上传走查', material_ids: [] }],
    confirm: true, base_revision: work.revision,
  })
  await api(page, origin, 'PATCH', `/sections/${work.sections[0].id}`, { content_md: '先写正文，再补图。', base_revision: work.sections[0].revision })
  return work as { id: string }
}

test('DEV-QA26 桌面上传图片走文件选择路径：非法类型拒绝、多张入库、删除确认', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(150_000)
  const { app, page, origin } = await launch(baseURL, 'main')
  try {
    // 注册即建工作区；平台账号用 API 建（添加账号对话框的 UI 已由 DEV-QA26 批次 A 走查覆盖）。
    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'xhs', name: 'QA26 上传走查号', content_format: 'image_note',
    }) as { id: string }
    const work = await xhsWorkWithSection(page, origin, account.id, '桌面上传图片走查')
    const dir = await mkdtemp(join(tmpdir(), 'ops-g4-upload-files-'))
    const pngA = join(dir, 'a.png')
    const pngB = join(dir, 'b.png')
    const txt = join(dir, 'not-image.txt')
    await writeFile(pngA, Buffer.from(await pngBase64(page, '#2f6fed'), 'base64'))
    await writeFile(pngB, Buffer.from(await pngBase64(page, '#f5a524'), 'base64'))
    await writeFile(txt, '这不是图片')

    await page.goto(`${origin}/works/${work.id}`)
    // 图片区（editor-images）的 input 带 multiple；段落内联上传（section-block）没有，用 multiple 区分。
    const picker = page.locator('input[type="file"][accept="image/*"][multiple]')
    await expect(picker).toBeAttached()

    // 1) 非法类型走客户端拒绝路径：不产生上传请求，失败区出现提示。
    await picker.setInputFiles([txt])
    await expect(page.getByTestId('upload-failures')).toBeVisible()
    let workNow = await api(page, origin, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
    expect(workNow.assets).toHaveLength(0)

    // 2) 一次选择两张合法图片：逐张 POST 入库，界面显示「已选 2 张」。
    const first = page.waitForResponse((r) => r.url().includes(`/works/${work.id}/assets`) && r.request().method() === 'POST')
    const second = page.waitForResponse((r) => r.url().includes(`/works/${work.id}/assets`) && r.request().method() === 'POST')
    await picker.setInputFiles([pngA, pngB])
    expect([await first, await second].map((r) => r.status())).toEqual([200, 200])
    workNow = await api(page, origin, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
    expect(workNow.assets).toHaveLength(2)
    await expect(page.getByText(/已选 2 张/)).toBeVisible()
    await expect(page.getByText('第一张作为封面')).toBeVisible()

    // 3) 删除第一张：确认对话框保护，取消不删、确认后服务端与界面同步。
    const del = page.locator('button[title="删除"]').first()
    await del.click()
    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '取消' }).click()
    workNow = await api(page, origin, 'GET', `/works/${work.id}`) as { assets: Array<{ id: string }> }
    expect(workNow.assets).toHaveLength(2)
    await del.click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(async () => ((await api(page, origin, 'GET', `/works/${work.id}`)) as { assets: unknown[] }).assets.length).toBe(1)
    await expect(page.getByText(/已选 1 张/)).toBeVisible()
    await rm(dir, { recursive: true, force: true })
  } finally {
    await shutdown(app, page)
  }
})
