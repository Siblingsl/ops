import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 P3-A5（桌面形态）：真实 Electron 窗口里逐字段显示回读期望/实际，
// 不一致时可改为手动/重新填写；一致后停人工，不自动提交。

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
  await page.goto(`${origin}/login`)
  const registered = await page.evaluate(async ({ username, password }) => {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: await response.text() }
  }, { username: `p3-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面回读验收号', content_format: 'image_note', type_note: '',
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
      rows[p] = (x * 3 + y * 8) % 255
      rows[p + 1] = 150
      rows[p + 2] = (x * 8 + y * 3) % 255
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
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
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

function readback(screenshotAssetId: string, ok: boolean) {
  return {
    checked_at: new Date().toISOString(),
    adapter_version: 'xhs-fill-v1',
    ok,
    fields: {
      title: { expected_hash: 'title-expected', actual_hash: ok ? 'title-expected' : 'title-actual', ok },
      body: { expected_len: 800, actual_len: ok ? 800 : 798, ok },
      tags: { expected_count: 3, actual_count: 3, first: '#账号名', ok: true },
      cover: { expected_present: true, present: true, expected_ratio: '0.75', actual_ratio: '0.75', ok: true },
      schedule: { expected: null, actual: null, ok: true },
    },
    screenshot_asset_id: screenshotAssetId,
    tab_ref: 'tab-p3-desktop',
  }
}

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面回读不一致时停人工。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`)
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是桌面 P3 回读核对正文，用于验证字段差异与改为手动入口。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await upload(page, origin, work.id)
  await api(page, origin, 'PATCH', `/works/${work.id}`, { title, cover_asset_id: asset.id, tags: ['账号名'] })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return { work, asset }
}

test('REF41 P3 双端（桌面）回读核对：字段差异、改手动、重新填写至一致', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p3-readback-'))
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

    const { work, asset } = await prepareWork(page, baseURL!, account.id, 'P3桌面回读作品')
    const created = await api(page, baseURL!, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
    expect(created.created.length, JSON.stringify(created)).toBe(1)
    const task = created.tasks[0]
    await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
    const filling = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'desktop-e2e' },
    })
    expect(filling.state).toBe('filling')
    const failed = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'failed', expected_version: 3, idempotency_key: randomUUID(),
      error_code: 'readback_mismatch', error_message: '回读不一致，禁止提交',
      evidence: { readback: readback(asset.id, false) },
    })
    expect(failed.state).toBe('failed')

    await page.goto(`${baseURL}/works/${work.id}`)
    const panel = page.getByTestId('publish-readback-panel-xhs')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('publish-readback-status-xhs')).toContainText('不一致')
    await expect(page.getByTestId('publish-readback-field-xhs-title')).toContainText('期望')
    await expect(page.getByTestId('publish-readback-field-xhs-body')).toContainText('期望 800 字')
    await expect(page.getByTestId('publish-readback-field-xhs-body')).toContainText('实际 798 字')
    await expect(page.getByTestId('publish-readback-field-xhs-tags')).toContainText('首项 #账号名')
    await expect(page.getByTestId('publish-readback-field-xhs-cover')).toContainText('0.75')
    const shotLink = panel.getByRole('link', { name: '查看回读截图' })
    await expect(shotLink).toHaveAttribute('href', `/api/v1/assets/${asset.id}/file`)
    await expect(page.getByTestId('publish-readback-shot-xhs')).toBeVisible()
    await expect(page.getByTestId('publish-readback-shot-xhs')).toHaveAttribute('src', `/api/v1/assets/${asset.id}/file?variant=512`)
    await expect(panel.getByRole('button', { name: '重新填写' })).toBeVisible()
    await expect(panel.getByRole('button', { name: '改为手动' })).toBeVisible()

    await panel.getByRole('button', { name: '改为手动' }).click()
    await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('失败')
    await expect.poll(async () => (await api(page, baseURL!, 'GET', `/works/${work.id}/publish-tasks`))[0].mode).toBe('manual')

    await page.reload()
    await page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '重新填写' }).click()
    await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('待排队')
    const queued = await api(page, baseURL!, 'GET', `/works/${work.id}/publish-tasks`)
    expect(queued[0].state).toBe('queued')

    await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filling', expected_version: queued[0].state_version, idempotency_key: randomUUID(),
      evidence: { device_id: 'desktop-e2e' },
    })
    const filled = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filled', expected_version: queued[0].state_version + 1, idempotency_key: randomUUID(),
      evidence: { readback: readback(asset.id, true), readback_ok: true },
    })
    expect(filled.state).toBe('filled')
    const awaiting = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'awaiting_user', expected_version: queued[0].state_version + 2, idempotency_key: randomUUID(),
      evidence: { screenshot_asset_id: asset.id, readback: readback(asset.id, true) },
    })
    expect(awaiting.state).toBe('awaiting_user')

    await page.reload()
    await expect(page.getByTestId('publish-readback-status-xhs')).toContainText('一致')
    await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('待你点发布')
    await expect(page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '重新填写' })).toHaveCount(0)
    await expect(page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '改为手动' })).toHaveCount(0)

    await page.screenshot({ path: '../output/playwright/p3-publish-readback-desktop.png', timeout: 30_000 })
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ } }
    try {
      const profileArg = profile.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profileArg}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' })
    } catch { /* best effort */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
})
