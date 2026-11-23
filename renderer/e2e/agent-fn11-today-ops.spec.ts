import { _electron, expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// FN-11 行为门：真实 Electron 窗口、真实 Go server/DB。
// 入口只复用 Agent 内“+”菜单与空态摘要，不新增 Shell 一级导航或全局面板。

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
  }, { username: `fn11-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: 'FN11 今日运营验收号', content_format: 'image_note', type_note: '',
  }) as Promise<{ id: string; name: string }>
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
      rows[p] = (x * 7 + y * 2) % 255
      rows[p + 1] = (x * 2 + y * 5) % 255
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

async function upload(page: Page, origin: string, workID: string) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const uploaded = await page.evaluate(async ({ url, csrf, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes.buffer], { type: 'image/png' }), 'cover.png')
    const response = await fetch(url, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    })
    return { status: response.status, body: await response.text() }
  }, { url: `${origin}/api/v1/works/${workID}/assets`, csrf: me.csrf_token, base64: coverPNG(900, 1200).toString('base64') })
  expect(uploaded.status, uploaded.body).toBe(200)
  return JSON.parse(uploaded.body)
}

async function prepareWork(page: Page, origin: string, accountID: string, title: string) {
  const work = await api(page, origin, 'POST', `/accounts/${accountID}/works`, { title }) as { id: string }
  await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '今日运营只汇总，不代替逐条处理。' })
  await api(page, origin, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, origin, 'GET', `/works/${work.id}`) as { sections: { id: string; revision: number }[] }
  await api(page, origin, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 FN-11 今日运营真实发布任务正文，只用于只读聚合验收。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await upload(page, origin, work.id) as { id: string }
  await api(page, origin, 'PATCH', `/works/${work.id}`, { title, cover_asset_id: asset.id, tags: ['今日运营'] })
  const manifest = await api(page, origin, 'POST', `/works/${work.id}/publish-manifests/xhs`) as { validation_state: string }
  expect(manifest.validation_state).toBe('valid')
  return work
}

test('FN-11 今日运营：真实 Electron 六块只读摘要与真实跳转', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-fn11-'))
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
    const provider = await api(native, baseURL!, 'POST', '/model-providers', {
      name: 'FN11 真实 Electron 验收模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL || 'http://127.0.0.1:8297/v1',
      api_key: 'local-e2e-key', models: ['mock-agent-tested'],
    }) as { id: string }
    await api(native, baseURL!, 'POST', `/model-providers/${provider.id}/selftest`, {})
    await api(native, baseURL!, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
    const me = await api(native, baseURL!, 'GET', '/auth/me') as { user_id?: string; username: string; workspace: { id: string } }
    await native.evaluate(({ key, id }) => localStorage.setItem(key, id), {
      key: `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`,
      id: account.id,
    })
    await native.waitForTimeout(500)

    const publishingWork = await prepareWork(native, baseURL!, account.id, 'FN11 待发布作品')
    const riskWork = await prepareWork(native, baseURL!, account.id, 'FN11 发布失败作品')
    await api(native, baseURL!, 'POST', `/works/${publishingWork.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
    const failedTask = await api(native, baseURL!, 'POST', `/works/${riskWork.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' }) as { tasks: { id: string }[] }
    await api(native, baseURL!, 'POST', `/publish-tasks/${failedTask.tasks[0].id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
    await api(native, baseURL!, 'POST', `/publish-tasks/${failedTask.tasks[0].id}/transition`, {
      to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'fn11-electron' },
    })
    await api(native, baseURL!, 'POST', `/publish-tasks/${failedTask.tasks[0].id}/transition`, {
      to: 'failed', expected_version: 3, idempotency_key: randomUUID(),
      error_code: 'fn11_platform_error', error_message: '平台返回失败，请检查发布详情',
    })

    await native.goto(`${baseURL}/agent`)
    const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await privacy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(privacy).toHaveCount(0)

    // 入口 1：Agent 内 “+” 菜单；不改 Shell 导航。
    await native.getByTestId('desktop-agent-add-menu-trigger').click()
    await expect(native.getByRole('menuitem', { name: /今日运营/ })).toBeVisible()
    await native.keyboard.press('Escape')

    // 入口 2：空态一行摘要可点开只读全屏面板。
    const entry = native.getByTestId('today-ops-welcome-entry')
    await expect(entry).toContainText('查看今日运营', { timeout: 30_000 })
    await entry.click()

    const panel = native.getByTestId('today-ops-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: '今日运营', exact: true })).toBeVisible()
    for (const key of ['pending', 'publishing', 'today', 'comments', 'routines', 'risks']) {
      await expect(panel.getByTestId(`today-ops-block-${key}`)).toBeVisible()
    }
    await expect(panel.getByTestId('today-ops-block-publishing')).toContainText('FN11 待发布作品')
    await expect(panel.getByTestId('today-ops-block-risks')).toContainText('FN11 发布失败作品')
    await expect(panel.getByTestId('today-ops-block-risks')).toContainText('平台返回失败')

    // 每块最多 3 条；所有条目必须是真实路由，不能出现批量/写操作。
    for (const key of ['pending', 'publishing', 'today', 'comments', 'routines', 'risks']) {
      const block = panel.getByTestId(`today-ops-block-${key}`)
      expect(await block.getByTestId('today-ops-item').count()).toBeLessThanOrEqual(3)
    }
    const hrefs = await panel.locator('a[data-testid="today-ops-item"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') || ''))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href).toMatch(/^\/(works\/|agent\/c\/|a\/|agent\?panel=routine)/)
    await expect(panel.getByRole('button', { name: /批量|全部执行|全部确认|全部处理|一键/ })).toHaveCount(0)

    await native.setViewportSize({ width: 1440, height: 1000 })
    await native.screenshot({ path: '../output/playwright/fn11-today-ops-electron-1440.png', timeout: 30_000 })
    await native.setViewportSize({ width: 1024, height: 900 })
    await native.screenshot({ path: '../output/playwright/fn11-today-ops-electron-1024.png', timeout: 30_000 })
    await native.setViewportSize({ width: 1440, height: 1000 })

    // 条目点击进入真实作品路由，面板随导航关闭，不留下死链。
    await panel.getByTestId('today-ops-block-publishing').getByTestId('today-ops-item').first().click()
    await expect(native).toHaveURL(new RegExp(`/works/${publishingWork.id}$`), { timeout: 20_000 })
    await expect(panel).toHaveCount(0)

    // 待发布只在 ready 状态；失败任务只进入风险，不重复混入待发布。
    await native.goto(`${baseURL}/agent`)
    await native.getByTestId('today-ops-welcome-entry').click()
    await expect(native.getByTestId('today-ops-block-publishing')).toContainText('1 条')
    await expect(native.getByTestId('today-ops-block-risks')).toContainText('1 项')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
