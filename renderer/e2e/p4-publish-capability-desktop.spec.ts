import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 P4（桌面形态）：真实 Electron 窗口里三平台×三通道能力、禁用原因与四态文案。
// 桌面离线/未校准按缺连接与缺成功校准的真实事实展示，不连接真实平台。

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
  }, { username: `p4-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面能力验收号', content_format: 'image_note', type_note: '',
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
      rows[p] = (x * 4 + y * 6) % 255
      rows[p + 1] = 120
      rows[p + 2] = (x * 6 + y * 4) % 255
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
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form })
    return { status: response.status, body: await response.text() }
  }, { url: `${origin}/api/v1/works/${workId}/assets`, csrf: me.csrf_token, base64: coverPNG(900, 1200).toString('base64') })
  expect(uploaded.status, uploaded.body).toBe(200)
  return JSON.parse(uploaded.body)
}

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面端先看能力与禁用原因，再逐篇人工确认。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`)
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是桌面 P4 发布能力与四态文案验收正文，不触发真实平台发布。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await upload(page, origin, work.id)
  await api(page, origin, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['能力'], summary: 'P4 桌面能力矩阵验收摘要',
  })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return { work, asset }
}

async function finishChecks(page: Page, origin: string, workId: string) {
  await page.goto(`${origin}/works/${workId}/check`)
  const initial = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  else if (initial.run.stale || initial.run.material_basis_stale) {
    const restarted = page.waitForResponse((response) => response.url().endsWith(`/works/${workId}/checks`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重新检查', exact: true }).first().click()
    await restarted
  }
  await expect.poll(async () => {
    const { run } = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  await expect(page.getByText('事实核查', { exact: true }).locator('..')).toContainText('已完成')
  const { run } = await api(page, origin, 'GET', `/works/${workId}/checks/latest`)
  expect(run).toBeTruthy()
  const resolutions: Record<string, string> = {
    sensitive: 'kept', fact: 'verified', stale: 'verified', ai_disclosure: 'acknowledged',
    similarity: 'acknowledged', ad_law: 'acknowledged', rewrite: 'acknowledged',
  }
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      // P4 用例聚焦能力矩阵与四态文案；检查项本身由 P2/P3 的检查页用例覆盖。
      await api(page, origin, 'PATCH', `/check-items/${item.id}`, { resolution: resolutions[item.category] })
    }
  }
  await page.reload()
  await expect(page.getByText('事实核查', { exact: true }).locator('..')).toContainText('已完成')
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, origin, 'GET', `/works/${workId}`)).status, { timeout: 20_000 }).toBe('ready')
}

test('REF41 P4 双端（桌面）能力矩阵、禁用原因与四态文案', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p4-capability-'))
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

    const wechat = await api(page, baseURL!, 'POST', '/accounts', {
      platform: 'wechat_mp', name: 'P4 桌面无凭证公众号', content_format: 'long_article',
    })
    const wechatWork = await api(page, baseURL!, 'POST', `/accounts/${wechat.id}/works`, { title: 'P4 桌面公众号能力' })

    await page.goto(`${baseURL}/works/${wechatWork.id}`)
    for (const platform of ['wechat_mp', 'xhs', 'toutiao']) {
      const panel = page.getByTestId(`publish-capability-panel-${platform}`)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      for (const channel of ['api', 'desktop', 'manual']) {
        await expect(page.getByTestId(`publish-capability-${platform}-${channel}`)).toBeVisible()
      }
    }
    await expect(page.getByTestId('publish-capability-disabled-wechat_mp-api')).toBeDisabled()
    await expect(page.getByTestId('publish-capability-reason-wechat_mp-api')).toContainText('缺少公众号 AppID/Secret')
    await expect(page.getByTestId('publish-capability-available-wechat_mp-manual')).toContainText('可用')
    for (const platform of ['wechat_mp', 'xhs', 'toutiao']) {
      await expect(page.getByTestId(`publish-status-${platform}`)).toContainText('素材已备好')
    }
    await page.screenshot({ path: '../output/playwright/p4-desktop-capability-wechat.png', timeout: 30_000 })

    const { work, asset } = await prepareWork(page, baseURL!, account.id, 'P4 桌面能力与四态作品')
    await finishChecks(page, baseURL!, work.id)
    const readyWork = await api(page, baseURL!, 'GET', `/works/${work.id}`)
    expect(readyWork.status).toBe('ready')
    await api(page, baseURL!, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
    await page.goto(`${baseURL}/works/${work.id}`)
    await expect(page.getByTestId('publish-capability-xhs-desktop')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('publish-capability-disabled-xhs-desktop')).toBeDisabled()
    await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('桌面客户端未连接')
    await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('该账号尚未完成一次成功填写')
    await expect(page.getByTestId('publish-status-xhs')).toContainText('素材已备好')

    const created = await api(page, baseURL!, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
    expect(created.created.length, JSON.stringify(created)).toBe(1)
    const task = created.tasks[0]
    await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
    await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'desktop-e2e-p4' },
    })
    const filled = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filled', expected_version: 3, idempotency_key: randomUUID(),
      evidence: { readback: { ok: true, adapter_version: 'xhs-fill-v1', fields: {} }, readback_ok: true },
    })
    expect(filled.state).toBe('filled')
    await page.reload()
    await expect(page.getByTestId('publish-status-xhs')).toContainText('已填入后台')

    const awaiting = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'awaiting_user', expected_version: 4, idempotency_key: randomUUID(),
      evidence: { screenshot_asset_id: asset.id, readback: { ok: true, screenshot_asset_id: asset.id } },
    })
    expect(awaiting.state).toBe('awaiting_user')
    await page.reload()
    await expect(page.getByTestId('publish-status-xhs')).toContainText('已填入后台（待你点发布）')

    await api(page, baseURL!, 'POST', `/works/${work.id}/publish-state/transition`, {
      base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
      submitted_ref: { handoff_note: '已在平台后台人工点击发布' },
    })
    const submitted = await api(page, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'submitted', expected_version: 5, idempotency_key: randomUUID(),
    })
    expect(submitted.state).toBe('submitted')
    await page.reload()
    await expect(page.getByTestId('publish-status-xhs')).toContainText('已交接')

    const published = await prepareWork(page, baseURL!, account.id, 'P4 桌面已发布作品')
    await finishChecks(page, baseURL!, published.work.id)
    const readyPublished = await api(page, baseURL!, 'GET', `/works/${published.work.id}`)
    expect(readyPublished.status).toBe('ready')
    await api(page, baseURL!, 'POST', `/works/${published.work.id}/xhs/pack`, { basis_revision: readyPublished.revision })
    // 为公众号/头条建任务，使 meta 行真实存在，验证跨平台不显示“已发布”。
    await api(page, baseURL!, 'POST', `/works/${published.work.id}/publish-manifests/wechat_mp`, {})
    await api(page, baseURL!, 'POST', `/works/${published.work.id}/publish-manifests/toutiao`, {})
    await api(page, baseURL!, 'POST', `/works/${published.work.id}/publish-tasks`, { platforms: ['wechat_mp', 'toutiao'], mode: 'desktop' })
    await api(page, baseURL!, 'POST', `/works/${published.work.id}/published`, {})
    await page.goto(`${baseURL}/works/${published.work.id}`)
    await expect(page.getByTestId('publish-status-xhs')).toContainText('已发布', { timeout: 30_000 })
    // 非作品平台：xhs pack 推进 publish_revision 后其 manifest 合法地变为 stale（“已过期”），
    // 但绝不得出现“已发布”。接受 packed/stale 两种真实状态。
    const wechatBadge = page.getByTestId('publish-status-wechat_mp')
    const toutiaoBadge = page.getByTestId('publish-status-toutiao')
    await expect(wechatBadge.filter({ hasNotText: '已发布' })).toBeVisible()
    await expect(toutiaoBadge.filter({ hasNotText: '已发布' })).toBeVisible()
    // meta 行不得出现“已发布”（P4-A3：badge 与 meta 行共用平台守卫；任务已建，meta 行必在）。
    await expect(page.getByTestId('publish-task-meta-wechat_mp')).not.toContainText('已发布')
    await expect(page.getByTestId('publish-task-meta-toutiao')).not.toContainText('已发布')
    await expect(page.getByTestId('publish-capability-xhs-desktop')).toBeVisible()
    await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('桌面客户端未连接')
    await page.screenshot({ path: '../output/playwright/p4-desktop-capability-published.png', timeout: 30_000 })

    const forbidden = page.getByRole('button', { name: /批量发布|全部执行|全部确认|批量确认|一键发布|批量填写|批量提交/ })
    await expect(forbidden).toHaveCount(0)
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
