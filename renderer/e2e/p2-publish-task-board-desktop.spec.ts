import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 P2-A7（桌面形态）：真实 Electron 窗口里看板只展示任务状态与逐条动作，
// 不出现“批量发布/全部执行/全部确认”入口；3 条任务逐条走到 submitted。

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
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return { status: response.status, body: await response.text() }
  }, { username: `p2-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面任务验收号', content_format: 'image_note', type_note: '',
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

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '桌面端同样先建任务，再逐条推进。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`)
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是桌面 P2 发布任务正文，用于验证任务状态机与看板文案。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await upload(page, origin, work.id)
  await api(page, origin, 'PATCH', `/works/${work.id}`, { title, cover_asset_id: asset.id, tags: ['任务'] })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return work
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
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      if (item.category === 'ai_disclosure') {
        const saved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${item.id}`) && response.request().method() === 'PATCH')
        const checkbox = page.getByRole('checkbox', { name: '已知悉，发布时会声明' })
        await checkbox.evaluate((el) => {
          el.scrollIntoView({ block: 'center' })
          ;(el as HTMLInputElement).click()
        })
        expect((await saved).ok()).toBeTruthy()
      } else {
        const saved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${item.id}`) && response.request().method() === 'PATCH')
        await page.locator(`input[name="${item.id}"]`).first().evaluate((el) => {
          el.scrollIntoView({ block: 'center' })
          ;(el as HTMLInputElement).click()
        })
        expect((await saved).ok()).toBeTruthy()
      }
    }
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, origin, 'GET', `/works/${workId}`)).status, { timeout: 20_000 }).toBe('ready')
}

async function assertNoBatchEntries(page: Page) {  await expect(page.getByRole('button', { name: /批量发布|全部执行|全部确认|批量确认|全部起草|一键发布|批量填写|批量提交/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /批量发布|全部执行|全部确认|批量确认|一键发布/ })).toHaveCount(0)
}

test('REF41 P2 双端（桌面）发布任务看板：3 条任务逐条推进，无批量发布入口', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-p2-task-'))
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
    await native.waitForLoadState('domcontentloaded').catch(() => undefined)
    await native.waitForTimeout(500)
    console.log('P2 desktop: user ready')

    const works = [] as Awaited<ReturnType<typeof prepareWork>>[]
    for (let i = 1; i <= 3; i++) works.push(await prepareWork(native, baseURL!, account.id, `P2桌面任务${i}`))
    console.log('P2 desktop: works ready')

    const tasks = [] as { id: string }[]
    for (const work of works) {
      const created = await api(native, baseURL!, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
      expect(created.created.length, JSON.stringify(created)).toBe(1)
      tasks.push(created.tasks[0])
    }

    await native.goto(`${baseURL}/a/${account.id}/ops`)
    const board = native.getByTestId('publish-task-board')
    await expect(board).toBeVisible({ timeout: 30_000 })
    await expect(board.getByTestId('publish-task-column-waiting')).toContainText('3', { timeout: 20_000 })
    for (const task of tasks) await expect(board.getByTestId(`publish-task-${task.id}`)).toBeVisible()
    await assertNoBatchEntries(native)
    console.log('P2 desktop: board ready')

    for (const task of tasks) {
      const queued = await api(native, baseURL!, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
      expect(queued.state).toBe('queued')
      const filling = await api(native, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
        to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'desktop-e2e' },
      })
      expect(filling.state).toBe('filling')
      const filled = await api(native, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
        to: 'filled', expected_version: 3, idempotency_key: randomUUID(), evidence: { readback: { ok: true }, readback_ok: true },
      })
      expect(filled.state).toBe('filled')
      const awaiting = await api(native, baseURL!, 'POST', `/publish-tasks/${task.id}/transition`, {
        to: 'awaiting_user', expected_version: 4, idempotency_key: randomUUID(), evidence: { screenshot_asset_id: randomUUID() },
      })
      expect(awaiting.state).toBe('awaiting_user')
    }

    await native.reload()
    await expect(board.getByTestId('publish-task-column-filled')).toContainText('3', { timeout: 20_000 })
    await assertNoBatchEntries(native)

    for (let i = 0; i < tasks.length; i++) {
      const work = works[i]
      await finishChecks(native, baseURL!, work.id)
      const readyWork = await api(native, baseURL!, 'GET', `/works/${work.id}`)
      expect(readyWork.status).toBe('ready')
      await api(native, baseURL!, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
      await api(native, baseURL!, 'POST', `/works/${work.id}/publish-state/transition`, {
        base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
        submitted_ref: { handoff_note: '已在平台后台点击发布并回填公开链接' },
      })
      const submitted = await api(native, baseURL!, 'POST', `/publish-tasks/${tasks[i].id}/transition`, {
        to: 'submitted', expected_version: 5, idempotency_key: randomUUID(),
      })
      expect(submitted.state).toBe('submitted')
    }
    await native.goto(`${baseURL}/a/${account.id}/ops`)
    await expect(board.getByTestId('publish-task-column-submitted')).toContainText('3', { timeout: 20_000 })
    await expect(board.getByTestId('publish-task-column-filled')).toContainText('0')
    await assertNoBatchEntries(native)

    await native.goto(`${baseURL}/works/${works[0].id}`)
    const meta = native.getByTestId('publish-task-meta-xhs')
    await expect(meta).toContainText('已提交', { timeout: 30_000 })
    await expect(meta).toContainText('1/2')
    await expect(meta).toContainText('最近事件')
    await assertNoBatchEntries(native)

    await native.goto(`${baseURL}/a/${account.id}/ops`)
    await expect(board).toBeVisible({ timeout: 30_000 })
    await native.screenshot({ path: '../output/playwright/p2-publish-task-board-desktop.png', timeout: 30_000 })
    console.log('P2 desktop: screenshot saved')
  } finally {
    console.log('P2 desktop: teardown start')
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ } }
    try {
      const profileArg = profile.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profileArg}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' })
    } catch { /* best effort */ }
    console.log('P2 desktop: taskkill done')
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    console.log('P2 desktop: rm done')
  }
})
