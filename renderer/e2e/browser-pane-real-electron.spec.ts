import { _electron, chromium, expect, test, type Page } from '@playwright/test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// BR-01 / BR-05：真实 Electron + 真实 Chromium 扩展 + 真实 Native Messaging 宿主。
// 桌面桥 autoPair 后由服务端登记 binding，工作台 Chrome 分段经 desktop IPC
// browser:list-tabs 读取真实标签；同时验证未连接引导与“已连接无标签”出口。
// 不使用假标签或页面内 mock 桥。

function playwrightChromium(): string | null {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!existsSync(base)) return null
  const candidates = readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()
  for (const name of candidates) {
    const exe = join(base, name, 'chrome-win64', 'chrome.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

async function prepare(page: Page, baseURL: string) {
  const username = 'br01-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7)
  await page.goto(baseURL + '/register')
  const registered = await page.evaluate(async ({ origin, name }) => {
    const response = await fetch(origin + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'local-e2e-password-123' }),
    })
    return { status: response.status, text: await response.text() }
  }, { origin: baseURL, name: username })
  expect(registered.status, `注册失败: ${registered.text}`).toBe(200)
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  const features = await page.evaluate(async () => {
    const response = await fetch('/api/v1/agent/bootstrap')
    return (await response.json()) as { features: Record<string, boolean> }
  })
  expect(features.features.workbench_ui).toBe(true)
}

async function openBrowserPane(page: Page) {
  const panel = page.getByRole('complementary', { name: '任务面板' })
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.desktop-agent-panel-button').first().click()
  }
  await expect(panel).toBeVisible()
  await panel.getByRole('tab', { name: /^浏览器/ }).click()
  return panel
}

async function ensureChromePanel(page: Page) {
  const panel = await openBrowserPane(page)
  const chromeSegment = panel.getByRole('button', { name: 'Chrome 协作', exact: true })
  if ((await chromeSegment.getAttribute('aria-pressed')) !== 'true') await chromeSegment.click()
  return panel
}

// 外部 Chrome 抢到前台后，Electron 窗口可能被系统遮挡，鼠标命中测试不稳定；
// 用真实 DOM 点击（仍是产品事件链）打开面板与 Chrome 分段，截图则由主进程 capturePage 取窗口。
async function openBrowserPaneByDom(page: Page) {
  await page.locator('.desktop-agent-panel-button').first().waitFor({ state: 'attached', timeout: 15_000 })
  const opened = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.desktop-agent-panel-button')
    if (!button) return false
    if (button.getAttribute('aria-expanded') !== 'true') button.click()
    return true
  })
  if (!opened) throw new Error('任务面板按钮不存在')
  await page.waitForTimeout(200)
  await page.evaluate(() => document.querySelector<HTMLElement>('#agent-panel-tab-browser')?.click())
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const chrome = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Chrome 协作')
    if (chrome && chrome.getAttribute('aria-pressed') !== 'true') chrome.click()
  })
  await page.waitForTimeout(1_000)
}

async function ensureChromePanelByForce(page: Page) {
  const panel = page.getByTestId('desktop-agent-side-panel')
  if ((await panel.count()) === 0) {
    await page.locator('.desktop-agent-panel-button').first().click({ force: true })
  }
  await page.waitForTimeout(250)
  const browserTab = page.locator('#agent-panel-tab-browser')
  if (await browserTab.count()) await browserTab.click({ force: true })
  await page.waitForTimeout(250)
  const chrome = page.getByRole('button', { name: 'Chrome 协作', exact: true })
  if ((await chrome.count()) > 0 && (await chrome.getAttribute('aria-pressed')) !== 'true') {
    await chrome.click({ force: true })
  }
  await page.waitForTimeout(400)
}

async function dismissTransientDialog(page: Page) {
  const overlay = page.locator('.fixed.inset-0.z-50')
  if ((await overlay.count()) === 0) return
  const acknowledge = page.getByRole('button', { name: '我知道了', exact: true })
  if (await acknowledge.isVisible().catch(() => false)) await acknowledge.click()
  else await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0, { timeout: 5_000 }).catch(() => {})
}

async function captureAppWindow(app: Awaited<ReturnType<typeof _electron.launch>>, target: string) {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/agent'))
      ?? BrowserWindow.getAllWindows()[0]
    const image = await window.capturePage()
    return image.toPNG().toString('base64')
  })
  writeFileSync(target, Buffer.from(base64, 'base64'))
}

test('BR-01/BR-05 真实 Chrome 扩展连接、无标签与真实标签列表', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const chromePath = playwrightChromium()
  test.skip(!chromePath, '缺少 Playwright Chromium（无法加载 OPS 扩展）')
  const userData = await mkdtemp(join(tmpdir(), 'ops-br01-electron-'))
  const chromeProfile = await mkdtemp(join(tmpdir(), 'ops-br01-chrome-'))
  const extensionDir = resolve(process.cwd(), '../desktop/chrome-extension')
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let chrome: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>BR01 夹具标签</title></head><body><h1>BR01 标签</h1></body></html>')
  })
  await new Promise<void>((resolveListen) => fixture.listen(0, '127.0.0.1', resolveListen))
  const fixturePort = (fixture.address() as { port: number }).port
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      // 桥的 CommandLedger 落在 process.cwd()/.tmp；必须让 Electron 以 desktop/ 为
      // 工作目录，否则 ledger 写进 renderer/.tmp 会被 Vite 监听到并触发整页 reload。
      cwd: resolve(process.cwd(), '../desktop'),
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL!, OPS_DESKTOP_BRIDGE_AUTO_PAIR: '1', OPS_DESKTOP_BRIDGE_PORT: '18765' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let panel = await openBrowserPane(page)

    // BR-01 默认态：应用内优先、分段 28px、说明 12px，且不在顶部压一层“未开启”。
    const modeGroup = panel.getByRole('group', { name: '浏览方式' })
    await expect(modeGroup.getByRole('button', { name: '应用内', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(modeGroup.getByRole('button', { name: 'Chrome 协作', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const segmentedHeight = await modeGroup.evaluate((element) => getComputedStyle(element).height)
    expect(segmentedHeight).toBe('28px')
    const inappNote = panel.locator('.desktop-agent-browser-note')
    await expect(inappNote).toHaveText('你自己浏览，Agent 不会操作这里')
    expect(await inappNote.evaluate((element) => getComputedStyle(element).fontSize)).toBe('12px')
    expect(await inappNote.evaluate((element) => getComputedStyle(element).lineHeight)).toBe('18px')
    await expect(page.getByRole('button', { name: /接管/ })).toHaveCount(0)
    await expect(page.getByText('浏览器协作未开启', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br01-default-inapp.png') })

    // BR-05 未连接：只在该分段显示安装/检测引导，不压顶，不伪造标签。
    await panel.getByRole('button', { name: 'Chrome 协作', exact: true }).click()
    await expect(panel.getByTestId('desktop-agent-browser-status')).toHaveAttribute('data-state', 'unpaired')
    await expect(panel.getByTestId('pairing-not-installed')).toBeVisible()
    await expect(panel.getByText('未检测到 Chrome 扩展连接', { exact: false })).toBeVisible()
    await expect(panel.getByRole('button', { name: '检测连接', exact: true })).toBeVisible()
    await expect(page.getByText('浏览器协作未开启', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-br05-unpaired.png') })

    // 启动真实 Chromium + OPS 扩展；桌面桥 autoPair。
    chrome = await chromium.launchPersistentContext(chromeProfile, {
      executablePath: chromePath!,
      headless: false,
      env: { ...process.env, OPS_DESKTOP_BRIDGE_PORT: '18765' } as Record<string, string>,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run', '--no-default-browser-check',
      ],
    })
    const worker = await (async () => {
      for (let index = 0; index < 60; index += 1) {
        const found = chrome!.serviceWorkers()[0]
        if (found) return found
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('OPS 扩展 service worker 未启动')
    })()
    await expect.poll(async () => worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extension_instance_id')
      return stored.extension_instance_id as string | undefined
    }), { timeout: 30_000 }).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const extensionInstanceID = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extension_instance_id')
      return stored.extension_instance_id as string
    })

    // 桌面桥真实配对完成（snapshot 由本机 IPC 返回）。
    await expect.poll(async () => {
      const result = await page.evaluate(async () => (window as unknown as { opsDesktopUI?: { getBrowserPairingState?: () => Promise<{ ok: boolean; snapshot?: { state: string } }> } }).opsDesktopUI?.getBrowserPairingState?.())
      return result?.ok ? result.snapshot?.state : 'ipc-missing'
    }, { timeout: 45_000 }).toBe('paired')

    // 服务端登记真实 binding（扩展实例 ID 来自真实 service worker）。
    await page.evaluate(async (extensionInstanceID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const pairing = await (await fetch('/api/v1/agent/browser/pairings', { method: 'POST', headers, body: JSON.stringify({ request_id: crypto.randomUUID() }) })).json()
      const confirmed = await fetch(`/api/v1/agent/browser/pairings/${pairing.id}/confirm`, {
        method: 'POST', headers,
        body: JSON.stringify({
          expected_revision: pairing.revision,
          extension_instance_id: extensionInstanceID,
          device_id: crypto.randomUUID(),
          connection_name: 'BR01 工作 Chrome',
          browser_kind: 'chrome',
          protocol_range: '1',
        }),
      })
      if (!confirmed.ok) throw new Error(`binding confirm ${confirmed.status}: ${await confirmed.text()}`)
    }, extensionInstanceID)

    // BR-05 已连接无标签：Chrome 仅剩内部页（about:blank），扩展只枚举 http/https，
    // 因此页面上出现“已连接但无标签”的明确出口，而不是伪造一个不可操作标签。
    for (const openPage of chrome.pages()) await openPage.goto('about:blank').catch(() => {})
    if (chrome.pages().length === 0) await (await chrome.newPage()).goto('about:blank')
    await expect.poll(async () => {
      const result = await page.evaluate(async () => (await (await fetch('/api/v1/agent/browser/bindings')).json()) as { bindings: unknown[] })
      return result.bindings.length
    }, { timeout: 20_000 }).toBeGreaterThan(0)
    // Chrome 启动会让 OPS 窗口失焦；DOM 仍可操作，截图改用主进程 capturePage。
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await expect(page.getByRole('main')).toContainText('AI 对话', { timeout: 15_000 })
    const realTabsBeforeFixture = await page.evaluate(async () => {
      const api = (window as unknown as { opsDesktopUI?: { listBrowserTabs?: () => Promise<unknown> } }).opsDesktopUI
      return api?.listBrowserTabs?.()
    })
    expect(realTabsBeforeFixture).toEqual({ ok: true, tabs: [] })
    // 页面刚完成一次启动时，布局偏好 effect 会用 localStorage 重置面板开关；先等页面稳定。
    await page.waitForTimeout(8_000)
    await page.evaluate(() => {
      const state: { statuses: string[]; empty: boolean; openTimer?: number; tickTimer?: number } = { statuses: [], empty: false }
      ;(window as unknown as { __br01: typeof state }).__br01 = state
      const open = () => {
        const button = document.querySelector<HTMLButtonElement>('.desktop-agent-panel-button')
        if (button && !document.querySelector('[data-testid="desktop-agent-side-panel"]')) button.click()
        document.querySelector<HTMLElement>('#agent-panel-tab-browser')?.click()
        const chrome = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((item) => item.textContent?.trim() === 'Chrome 协作')
        if (chrome && chrome.getAttribute('aria-pressed') !== 'true') chrome.click()
      }
      const tick = () => {
        const status = document.querySelector('[data-testid="desktop-agent-browser-status"]')
        const value = status?.getAttribute('data-state') ?? ''
        if (value && !state.statuses.includes(value)) state.statuses.push(value)
        const empty = document.querySelector('[data-testid="desktop-agent-browser-tabs-empty"]')
        if (empty) {
          const rect = empty.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) state.empty = true
        }
      }
      state.openTimer = window.setInterval(open, 250)
      state.tickTimer = window.setInterval(tick, 100)
      open()
      tick()
    })
    await expect.poll(async () => {
      const state = await page.evaluate(() =>
        (window as unknown as { __br01?: { statuses: string[]; empty: boolean } }).__br01)
      if (!state) return 'observer-missing'
      return state.statuses.includes('paired') && state.empty ? 'ready' : JSON.stringify(state)
    }, { timeout: 30_000, intervals: [500] }).toBe('ready')
    await page.evaluate(() => {
      const state = (window as unknown as { __br01?: { openTimer?: number; tickTimer?: number } }).__br01
      if (state?.openTimer) window.clearInterval(state.openTimer)
      if (state?.tickTimer) window.clearInterval(state.tickTimer)
    })
    await page.waitForTimeout(250)
    await expect(page.getByTestId('desktop-agent-browser-tabs-empty')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: '刷新标签', exact: true })).toBeVisible()
    await captureAppWindow(app, resolve(process.cwd(), '../.playwright-results/agent-p0-br05-connected-empty.png'))

    // BR-01 已连接看到真实标签：打开夹具页后由 browser:list-tabs 自动读取。
    const activePage = await chrome.newPage()
    await activePage.goto(`http://127.0.0.1:${fixturePort}/`)
    await expect.poll(async () => {
      const result = await page.evaluate(async () => (await (await fetch('/api/v1/agent/browser/bindings')).json()) as { bindings: unknown[] })
      return result.bindings.length
    }, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await openBrowserPaneByDom(page)
    await dismissTransientDialog(page)
    const refreshTabs = page.getByRole('button', { name: '刷新标签', exact: true })
    await expect(refreshTabs).toBeVisible({ timeout: 20_000 })
    await refreshTabs.click()
    const tab = page.locator('[data-testid^="desktop-agent-browser-tab-"]').filter({ hasText: 'BR01 夹具标签' })
    await expect(tab).toBeVisible({ timeout: 20_000 })
    await expect(tab).toContainText(`127.0.0.1:${fixturePort}`)
    await expect(page.getByTestId('desktop-agent-browser-agent-activity')).toHaveCount(0)
    await captureAppWindow(app, resolve(process.cwd(), '../.playwright-results/agent-p0-br01-chrome-tabs.png'))
  } finally {
    await chrome?.close().catch(() => {})
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()))
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
    await rm(chromeProfile, { recursive: true, force: true }).catch(() => {})
  }
})

test('BR-05 扩展已安装未连接：真实扩展已检测到，配对前显示未连接', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const chromePath = playwrightChromium()
  test.skip(!chromePath, '缺少 Playwright Chromium（无法加载 OPS 扩展）')
  const userData = await mkdtemp(join(tmpdir(), 'ops-br05-electron-'))
  const chromeProfile = await mkdtemp(join(tmpdir(), 'ops-br05-chrome-'))
  const extensionDir = resolve(process.cwd(), '../desktop/chrome-extension')
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let chrome: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      cwd: resolve(process.cwd(), '../desktop'),
      // 不自动配对：真实扩展 hello 后桥进入 pairing（有短码），正是“未连接”状态。
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL!, OPS_DESKTOP_BRIDGE_PORT: '18766' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    const panel = await openBrowserPane(page)
    await panel.getByRole('button', { name: 'Chrome 协作', exact: true }).click()

    chrome = await chromium.launchPersistentContext(chromeProfile, {
      executablePath: chromePath!,
      headless: false,
      env: { ...process.env, OPS_DESKTOP_BRIDGE_PORT: '18766' } as Record<string, string>,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run', '--no-default-browser-check',
      ],
    })
    await expect.poll(async () => (await chrome!.serviceWorkers()).length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(panel.getByTestId('pairing-not-connected')).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByTestId('pairing-code')).not.toHaveText('------')
    await captureAppWindow(app, resolve(process.cwd(), '../.playwright-results/agent-p0-br05-not-connected.png'))
  } finally {
    await chrome?.close().catch(() => {})
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
    await rm(chromeProfile, { recursive: true, force: true }).catch(() => {})
  }
})
