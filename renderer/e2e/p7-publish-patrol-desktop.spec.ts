import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 P7（桌面形态）：真实 Electron 窗口里任务看板定时列显示“计划/平台”两行；
// 偏差超过 60 秒标红“漂移”。巡检本身只读（Go TestP7 覆盖事件/通知/去重/不改状态）。
// 与 Web 版差异：Electron 启动/profile/清理、看板路由 /a/:id/ops、桌面 finishChecks。

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
  await page.goto(`${origin}/login`, { waitUntil: 'load' })
  const registered = await page.evaluate(async ({ username, password }) => {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: await response.text() }
  }, { username: `p7-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面巡检验收号', content_format: 'image_note', type_note: '',
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

async function uploadCover(page: Page, origin: string, workId: string) {
  const base64 = coverPNG(900, 1200).toString('base64')
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const uploaded = await page.evaluate(async ({ url, csrf, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes.buffer], { type: 'image/png' }), 'cover.png')
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form })
    return { status: response.status, body: await response.text() }
  }, { url: `${origin}/api/v1/works/${workId}/assets`, csrf: me.csrf_token, base64 })
  expect(uploaded.status, uploaded.body).toBe(200)
  return JSON.parse(uploaded.body)
}

async function finishChecksDesktop(page: Page, origin: string, workId: string) {
  await page.goto(`${origin}/works/${workId}/check`, { waitUntil: 'load' })
  const initial = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const { run } = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const { run } = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
  const resolutions: Record<string, string> = {
    sensitive: 'kept', fact: 'verified', stale: 'verified', ai_disclosure: 'acknowledged',
    similarity: 'acknowledged', ad_law: 'acknowledged', rewrite: 'acknowledged',
  }
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) await api(page, origin, 'PATCH', `/check-items/${item.id}`, { resolution: resolutions[item.category] })
  }
  await page.reload()
  await expect(page.getByText('事实核查', { exact: true }).locator('..')).toContainText('已完成')
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, origin, 'GET', `/works/${workId}`)).status, { timeout: 20_000 }).toBe('ready')
}

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面定时漂移只提醒不改平台，巡检只读。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`)
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是桌面 P7 定时漂移看板验收正文，不触发任何真实平台动作。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, origin, work.id)
  await api(page, origin, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['巡检'], summary: 'P7 桌面定时漂移验收摘要',
  })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return work
}

test('REF41 P7 双端（桌面）定时漂移：看板计划/平台两行、漂移标红', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p7-patrol-'))
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
    const origin = baseURL!

    const work = await prepareWork(page, origin, account.id, 'P7桌面漂移看板作品')
    const created = await api(page, origin, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'desktop' })
    const task = created.tasks[0]
    await finishChecksDesktop(page, origin, work.id)
    const readyWork = await api(page, origin, 'GET', `/works/${work.id}`)
    expect(readyWork.status).toBe('ready')
    await api(page, origin, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
    await api(page, origin, 'POST', `/works/${work.id}/publish-state/transition`, {
      base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
      submitted_ref: { handoff_note: '桌面端已在平台后台排期' },
    })

    // 里程碑先推进到 scheduled（投影守卫要求），任务再投影 scheduled。
    const platformAt = new Date(Date.now() + 4 * 3600_000).toISOString()
    await api(page, origin, 'POST', `/works/${work.id}/publish-state/transition`, {
      base_version: 1, idempotency_key: randomUUID(), to: 'scheduled',
      scheduled_at: platformAt, evidence: { backend_url: 'https://creator.xiaohongshu.com/publish/p7-schedule' },
    })
    await api(page, origin, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'scheduled', expected_version: task.state_version, idempotency_key: randomUUID(),
      platform_schedule_at: platformAt, evidence: { backend_url: 'https://creator.xiaohongshu.com/publish/p7-schedule' },
    })

    await page.goto(`${origin}/a/${account.id}/ops`, { waitUntil: 'load' })
    const schedule = page.getByTestId(`publish-task-schedule-${task.id}`)
    await expect(schedule).toBeVisible({ timeout: 30_000 })
    await expect(schedule).toContainText('计划')
    await expect(schedule).toContainText('平台')
    await page.screenshot({ path: '../output/playwright/p7-desktop-schedule.png', timeout: 30_000 })
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
