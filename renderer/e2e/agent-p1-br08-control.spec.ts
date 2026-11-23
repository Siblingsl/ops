import { _electron, chromium, expect, test, type Page } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// BR-08：真实 Electron + 真实 Chromium 扩展 + 真实 mock 模型指令。
// 模型先请求选标签（A30 弹窗），用户授权后模型导航到慢页面；控制条在工具运行期间
// 出现，接管撤销真实 30 秒租约，交回重建租约，停止取消真实 run。

function playwrightChromium(): string | null {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!existsSync(base)) return null
  const candidates = readdirSync(base).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()
  for (const name of candidates) {
    const exe = join(base, name, 'chrome-win64', 'chrome.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('br08-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await page.evaluate(async ({ baseURL }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
    const provider = await (await fetch('/api/v1/model-providers', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'BR08 本地 mock', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'] }),
    })).json()
    await fetch(`/api/v1/model-providers/${provider.id}/selftest`, { method: 'POST', headers, body: '{}' })
    await fetch('/api/v1/model-routes', {
      method: 'PUT', headers,
      body: JSON.stringify([{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }]),
    })
    void baseURL
  }, { baseURL })
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
}

async function send(page: Page, text: string) {
  await page.locator('textarea').fill(text)
  const accepted = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/(messages|inputs)$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await accepted
}

async function openChromePanel(page: Page) {
  await page.locator('.desktop-agent-panel-button').first().waitFor({ state: 'attached', timeout: 15_000 })
  // Chrome 启动后 Electron 窗口可能被系统遮挡，鼠标命中不稳定；DOM 点击仍走产品事件链。
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.desktop-agent-panel-button')
    if (button && button.getAttribute('aria-expanded') !== 'true') button.click()
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => document.querySelector<HTMLElement>('#agent-panel-tab-browser')?.click())
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const chrome = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Chrome 协作')
    if (chrome && chrome.getAttribute('aria-pressed') !== 'true') chrome.click()
  })
  await page.waitForTimeout(1_000)
  return page.getByRole('complementary', { name: '任务面板' })
}

test('BR-08 浏览器控制条：运行可见、接管撤销租约、交回重建、停止取消 run', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const chromePath = playwrightChromium()
  test.skip(!chromePath, '缺少 Playwright Chromium（无法加载 OPS 扩展）')
  const fixture = createServer((request, response) => {
    const slow = (request.url ?? '').startsWith('/slow')
    const send = () => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>BR08 控制条夹具</title></head><body><h1>BR08 控制条夹具</h1><p>${slow ? '慢页面已返回' : '普通页面'}</p></body></html>`)
    }
    if (slow) setTimeout(send, 12_000)
    else send()
  })
  await new Promise<void>((resolveListen) => fixture.listen(0, '127.0.0.1', resolveListen))
  const port = (fixture.address() as { port: number }).port
  const fixtureURL = `http://127.0.0.1:${port}/`
  const slowURL = `http://127.0.0.1:${port}/slow`
  const userData = await mkdtemp(join(tmpdir(), 'ops-br08-electron-'))
  const chromeProfile = await mkdtemp(join(tmpdir(), 'ops-br08-chrome-'))
  const extensionDir = resolve(process.cwd(), '../desktop/chrome-extension')
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let chrome: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined

  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      cwd: resolve(process.cwd(), '../desktop'),
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL!, OPS_DESKTOP_BRIDGE_AUTO_PAIR: '1', OPS_DESKTOP_BRIDGE_PORT: '18765' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    await openChromePanel(page)

    chrome = await chromium.launchPersistentContext(chromeProfile, {
      executablePath: chromePath!,
      headless: false,
      env: { ...process.env, OPS_DESKTOP_BRIDGE_PORT: '18765' } as Record<string, string>,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
    })
    const worker = await (async () => {
      for (let index = 0; index < 60; index += 1) {
        const found = chrome!.serviceWorkers()[0]
        if (found) return found
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('OPS 扩展 service worker 未启动')
    })()
    await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('extension_instance_id')).extension_instance_id as string),
      { timeout: 30_000 }).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const extensionInstanceID = await worker.evaluate(async () => (await chrome.storage.local.get('extension_instance_id')).extension_instance_id as string)

    await expect.poll(async () => {
      const result = await page.evaluate(async () => (window as unknown as { opsDesktopUI?: { getBrowserPairingState?: () => Promise<{ ok: boolean; snapshot?: { state: string } }> } }).opsDesktopUI?.getBrowserPairingState?.())
      return result?.ok ? result.snapshot?.state : 'ipc-missing'
    }, { timeout: 45_000 }).toBe('paired')

    await page.evaluate(async (extensionInstanceID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const pairing = await (await fetch('/api/v1/agent/browser/pairings', { method: 'POST', headers, body: JSON.stringify({ request_id: crypto.randomUUID() }) })).json()
      const confirmed = await fetch(`/api/v1/agent/browser/pairings/${pairing.id}/confirm`, {
        method: 'POST', headers,
        body: JSON.stringify({ expected_revision: pairing.revision, extension_instance_id: extensionInstanceID, device_id: crypto.randomUUID(), connection_name: 'BR08 工作 Chrome', browser_kind: 'chrome', protocol_range: '1' }),
      })
      if (!confirmed.ok) throw new Error(`binding confirm ${confirmed.status}: ${await confirmed.text()}`)
    }, extensionInstanceID)

    await expect.poll(async () => {
      const result = await page.evaluate(async () => (await (await fetch('/api/v1/agent/browser/bindings')).json()) as { bindings: unknown[] })
      return result.bindings.length
    }, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(3_000)
    await openChromePanel(page)
    // 与 BR-01/BR-05 同一真实连接路径：先看到“已连接无标签”，再开夹具页。
    await expect(page.getByTestId('desktop-agent-browser-tabs-empty')).toBeVisible({ timeout: 30_000 })
    const fixturePage = await chrome.newPage()
    await fixturePage.goto(fixtureURL)
    await expect.poll(async () => page.evaluate(async () => {
      const result = await (window as unknown as { opsDesktopUI?: { listBrowserTabs?: () => Promise<{ ok: boolean; tabs: unknown[] }> } }).opsDesktopUI?.listBrowserTabs?.()
      return result?.ok ? result.tabs.length : 0
    }), { timeout: 30_000 }).toBeGreaterThan(0)
    const tabID = await page.evaluate(async (fixtureOrigin) => {
      const result = await (window as unknown as { opsDesktopUI?: { listBrowserTabs?: () => Promise<{ ok: boolean; tabs: { tab_id: number; origin: string }[] }> } }).opsDesktopUI?.listBrowserTabs?.()
      const tab = result?.tabs?.find((item) => (item.origin ?? '').includes(fixtureOrigin))
      return tab?.tab_id ?? result?.tabs?.[0]?.tab_id ?? 0
    }, `127.0.0.1:${port}`)
    expect(tabID).toBeGreaterThan(0)

    const fixtureOrigin = `http://127.0.0.1:${port}`
    // 真实 run + 真实租约：模型先加载 browser 领域，之后每轮重复导航到慢页面。
    // 首轮无租约会被服务端 409 拒绝；测试在真实活动 run 上经公开 API 签发 30 秒租约，
    // 下一轮导航成功并在慢页面运行期间显示控制条。
    await send(page, `#tool load_tool_domain {"domain":"browser"}\n#repeat browser_navigate {"tab_id": ${tabID}, "url": "${slowURL}"}`)
    let granted = false
    await expect.poll(async () => {
      if (granted) return true
      const result = await page.evaluate(async ({ tabID, origin }) => {
        const id = location.pathname.split('/').pop()
        const detail = await (await fetch(`/api/v1/agent/conversations/${id}`)).json() as { active_run?: { id?: string } }
        const runID = detail.active_run?.id
        if (!runID) return { ok: false, reason: 'no-active-run' }
        const bindings = await (await fetch('/api/v1/agent/browser/bindings')).json() as { bindings?: { id: string; state: string }[] }
        const binding = (bindings.bindings ?? []).find((item) => item.state === 'ready')
        if (!binding) return { ok: false, reason: 'no-ready-binding' }
        const me = await (await fetch('/api/v1/auth/me')).json() as { csrf_token: string }
        const response = await fetch(`/api/v1/agent/conversations/${id}/browser-grants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
          body: JSON.stringify({
            binding_id: binding.id, run_id: runID, tab_handle: String(tabID), origins: [origin],
            actions: ['observe', 'navigate', 'click', 'type', 'extract', 'screenshot'], policy_version: '1',
          }),
        })
        return response.ok ? { ok: true } : { ok: false, reason: `grant ${response.status}` }
      }, { tabID, origin: fixtureOrigin })
      granted = result.ok
      return result.ok
    }, { timeout: 5_000, intervals: [100] }).toBe(true)

    const bar = page.getByTestId('browser-control-bar')
    await expect(bar).toBeVisible({ timeout: 30_000 })
    await expect(bar).toContainText('Agent 控制中')
    await expect(bar).toContainText('打开网页')
    const barHeight = await bar.evaluate((element) => getComputedStyle(element).height)
    expect(barHeight).toBe('36px')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br08-control.png') })

    // 接管：真实撤销 30 秒租约，控制条转为“你已接管”。
    const handoffResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/browser-handoff$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.getByTestId('browser-control-takeover').click()
    const handoff = await handoffResponse
    expect(handoff.ok()).toBe(true)
    expect((await handoff.json()) as { state: string; device_ack_pending: boolean }).toMatchObject({ state: 'revoked', device_ack_pending: true })
    await expect(bar).toContainText('你已接管', { timeout: 15_000 })
    await expect(page.getByTestId('browser-control-handback')).toBeVisible()
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br08-takeover.png') })

    // 交回：服务端为当前活动 run 重建同一标签租约，控制权回到 Agent。
    const handbackResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/browser-handback$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.getByTestId('browser-control-handback').click()
    const handback = await handbackResponse
    expect(handback.ok()).toBe(true)
    expect((await handback.json()) as { state: string; tab_handle: string }).toMatchObject({ state: 'active', tab_handle: String(tabID) })
    await expect(bar).toContainText('Agent 控制中', { timeout: 15_000 })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-br08-handback.png') })

    // 停止：取消真实 run，控制条消失。
    await page.getByTestId('browser-control-stop').click()
    await expect(bar).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(async () => page.evaluate(async () => {
      const id = location.pathname.split('/').pop()
      const detail = await (await fetch(`/api/v1/agent/conversations/${id}`)).json() as { active_run?: { status?: string } }
      return detail.active_run?.status ?? 'none'
    }), { timeout: 15_000 }).not.toBe('running')
  } finally {
    await chrome?.close().catch(() => {})
    await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()))
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
    await rm(chromeProfile, { recursive: true, force: true }).catch(() => {})
  }
})
