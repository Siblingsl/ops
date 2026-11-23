import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 P5（桌面形态）：真实 Electron 窗口里账号×平台体检状态可见、重新体检入口可用、
// 掉线任务不消耗 attempt。体检结果由 HTTP fixture 语义（Go TestP5 覆盖落账）；
// 桌面 proof 链路在 Go 白名单与平台证明测试覆盖，这里不连接真实平台。

// 全部 API 调用走 page.context().request：与浏览器上下文共享 cookie jar，
// 不依赖页面网络栈就绪；CSRF 从 /auth/me 读取。
async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
      return await page.evaluate(async ({ url, method, data, csrf }) => {
        const response = await fetch(url, {
          method, credentials: 'include',
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
  // Electron 首窗可能是 ops-desktop:// 协议页：相对 fetch 的会话 Cookie 会落在协议域，
  // 导航到 http origin 后丢失。先显式导航到 API 所在的 http origin，再在页面内注册，
  // 让会话 Cookie 落在正确的域上。
  await page.goto(`${origin}/login`, { waitUntil: 'load' })
  const registered = await page.evaluate(async ({ username, password, origin }) => {
    const response = await fetch(`${origin}/api/v1/auth/register`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: await response.text() }
  }, { username: `p5-desktop-${Date.now()}`, password: 'local-e2e-password-123', origin })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面体检验收号', content_format: 'image_note', type_note: '',
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

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function coverPNG(width: number, height: number) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4
      raw[p] = (x * 3 + y * 5) % 255
      raw[p + 1] = (x * 7 + y * 2) % 255
      raw[p + 2] = 110
      raw[p + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function upload(page: Page, origin: string, workId: string) {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const uploaded = await page.evaluate(async ({ url, csrf, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes.buffer], { type: 'image/png' }), 'cover.png')
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form })
    return { status: response.status, body: await response.text() }
  }, { url: `${origin}/api/v1/works/${workId}/assets`, csrf: me.csrf_token, base64: coverPNG(900, 1200).toString('base64') })
  expect(uploaded.status, uploaded.body).toBe(200)
  return JSON.parse(uploaded.body)
}

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面体检只读展示；掉线不消耗填写次数。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`)
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是桌面 P5 发布通道体检验收正文，不触发真实平台动作。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await upload(page, origin, work.id)
  await api(page, origin, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['体检'], summary: 'P5 桌面通道体检摘要',
  })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return { work, asset }
}

test('REF41 P5 双端（桌面）通道体检：状态可见、重新体检可用、掉线不消耗 attempt', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p5-health-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const account = await setupUser(page, baseURL!)
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    await page.waitForTimeout(500)

    // A6：体检块可见，无体检时“未体检”，重新体检入口存在。
    const { work } = await prepareWork(page, baseURL!, account.id, 'P5 桌面体检作品')
    await page.goto(`${baseURL}/works/${work.id}`)
    await expect(page.getByTestId('publish-health-xhs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('publish-health-state-xhs')).toContainText('未体检')
    await page.screenshot({ path: '../output/playwright/p5-desktop-publish-health.png', timeout: 30_000 })

    // A2（HTTP 层）：建任务并排队；体检掉线语义的落账由 Go TestP5 覆盖，
    // 这里验证 queued 任务 attempt=0 且 UI 无“自动补跑消耗次数”入口。
    const created = await api(page, baseURL!, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'desktop' })
    expect(created.created.length, JSON.stringify(created)).toBe(1)
    const task = created.tasks[0]
    await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
    const afterQueue = await api(page, baseURL!, 'GET', `/works/${work.id}/publish-tasks`)
    expect(afterQueue[0].state).toBe('queued')
    expect(afterQueue[0].attempt).toBe(0)
    await page.reload()
    await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('待排队')
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => undefined),
        new Promise((resolveDone) => setTimeout(resolveDone, 5_000)),
      ])
    }
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ } }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
})
