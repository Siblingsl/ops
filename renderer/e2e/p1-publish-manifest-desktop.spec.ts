import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Electron 首窗没有 context baseURL，所有 API 都走页面内绝对地址 fetch；页面短暂跳转时重试。
async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
      return await page.evaluate(async ({ url, method, data, csrf }) => {
        const response = await fetch(url, {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        })
        const body = await response.text()
        if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
        return body ? JSON.parse(body) : null
      }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
    } catch (error) {
      lastError = error
      await page.waitForTimeout(500)
    }
  }
  throw lastError
}

async function setupUser(page: Page, origin: string) {
  await page.goto(`${origin}/login`)
  const registered = await page.evaluate(async ({ username, password }) => {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: await response.text() }
  }, { username: `p1-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面验收号', content_format: 'image_note', type_note: '',
  })
}

function crc32(data: Buffer) {
  let c = 0xffffffff
  for (const byte of data) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, 'ascii')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([size, typeBytes, data, checksum])
}

function coverPNG(width: number, height: number) {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1)
    rows[start] = 0
    for (let x = 0; x < width; x++) {
      const p = start + 1 + x * 4
      rows[p] = (x * 9 + y * 2) % 255
      rows[p + 1] = (x * 2 + y * 7) % 255
      rows[p + 2] = 120
      rows[p + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function upload(page: Page, origin: string, workId: string) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const uploaded = await page.evaluate(async ({ url, csrf, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes.buffer], { type: 'image/png' }), 'cover.png')
    const response = await fetch(url, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    })
    return { status: response.status, body: await response.text() }
  }, { url: `${origin}/api/v1/works/${workId}/assets`, csrf: me.csrf_token, base64: coverPNG(900, 1200).toString('base64') })
  expect(uploaded.status, uploaded.body).toBe(200)
  return JSON.parse(uploaded.body)
}

test('REF41 P1 桌面发布分区：生成 → block → 改稿 → 重新生成', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(240_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p1-manifest-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    const account = await setupUser(native, baseURL!)
    console.log('P1 desktop: user ready')
    const longTitle = '这是一条故意超过二十个字的小红书发布标题用于触发长度校验'
    const work = await api(native, baseURL!, 'POST', `/accounts/${account.id}/works`, { title: longTitle })
    await api(native, baseURL!, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面端同样先准备发布字段，再逐项校验。' })
    await api(native, baseURL!, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
    const withSection = await api(native, baseURL!, 'GET', `/works/${work.id}`)
    await api(native, baseURL!, 'PATCH', `/sections/${withSection.sections[0].id}`, {
      content_md: '这是桌面端发布正文，用于验证 manifest 的长度、标签和封面规则。',
      base_revision: withSection.sections[0].revision,
    })
    const asset = await upload(native, baseURL!, work.id)
    await api(native, baseURL!, 'PATCH', `/works/${work.id}`, { title: longTitle, cover_asset_id: asset.id, tags: ['测试'] })
    console.log('P1 desktop: work prepared')

    await native.goto(`${baseURL}/works/${work.id}`)
    console.log('P1 desktop: work page loaded')
    const panel = native.getByTestId('publish-manifest-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    console.log('P1 desktop: panel visible')
    const row = panel.getByTestId('publish-platform-xhs')
    await expect(row.getByTestId('publish-status-xhs')).toHaveText('素材已备好', { timeout: 30_000 })
    console.log('P1 desktop: initial status')
    await row.getByRole('button', { name: '生成', exact: true }).click()
    console.log('P1 desktop: generate clicked')
    await expect(row.getByTestId('publish-status-xhs')).toHaveText('校验未通过', { timeout: 30_000 })
    console.log('P1 desktop: invalid status')
    await row.getByRole('button', { name: /个阻断/ }).click()
    await expect(row.getByTestId('publish-checks-xhs')).toContainText('标题需为 1–20 字')
    console.log('P1 desktop: block checks')

    await native.goto(`${baseURL}/`)
    await api(native, baseURL!, 'PATCH', `/works/${work.id}`, { title: 'P1 桌面短标题' })
    console.log('P1 desktop: title patched')
    await native.goto(`${baseURL}/works/${work.id}`)
    console.log('P1 desktop: reloaded')
    await expect(row.getByTestId('publish-status-xhs')).toHaveText('已过期', { timeout: 30_000 })
    console.log('P1 desktop: stale status')
    const regenerate = row.getByRole('button', { name: '重新生成', exact: true })
    console.log('P1 desktop: regenerate count', await regenerate.count())
    await expect(regenerate).toBeVisible({ timeout: 20_000 })
    console.log('P1 desktop: regenerate visible')
    await regenerate.click({ timeout: 20_000 })
    console.log('P1 desktop: regenerate clicked')
    await expect(row.getByTestId('publish-status-xhs')).toHaveText('素材已备好', { timeout: 30_000 })
    console.log('P1 desktop: regenerated status')
    await expect(row.getByText('block 项已通过', { exact: true })).toBeVisible()
    await expect(row.getByTestId('publish-status-xhs')).not.toHaveText('已发布')
    console.log('P1 desktop: final assertions')
    await native.screenshot({ path: '../output/playwright/p1-publish-manifest-desktop.png', timeout: 30_000 })
    console.log('P1 desktop: screenshot saved')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
