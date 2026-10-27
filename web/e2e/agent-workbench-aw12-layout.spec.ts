import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('aw12-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW12 窗口验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW12 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  expect((await api(page, 'GET', '/agent/bootstrap')).features.workbench_ui).toBe(true)
}

test('DEV-AW12 Web 1366/1440/1920 保留既有页面样式', async ({ page, baseURL }) => {
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await prepare(page, baseURL!)
  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.desktop-agent-workbench')).toHaveCount(0)
    await expect(page.getByPlaceholder(/发送消息/)).toBeVisible()
    await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/agent-workbench-aw12-web-${width}.png`) })
  }
})

test('DEV-AW12 Electron 主题、窗口宽度及缩放场景', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw12-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    const scenarios = [
      { width: 1366, height: 768, zoom: 1, theme: 'light' },
      { width: 1366, height: 768, zoom: 1.25, theme: 'dark' },
      { width: 1440, height: 900, zoom: 1, theme: 'dark' },
      { width: 1440, height: 900, zoom: 1.5, theme: 'light' },
      { width: 1920, height: 1080, zoom: 1.25, theme: 'light' },
      { width: 1920, height: 1080, zoom: 2, theme: 'dark' },
    ] as const
    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    for (const scenario of scenarios) {
      await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setContentSize(width, height)
        window.webContents.setZoomFactor(zoom)
      }, scenario)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(600)
      const themeButton = page.getByRole('button', { name: /^切换到(深色|浅色)主题$/ })
      const theme = await page.locator('html').getAttribute('data-theme')
      if (theme !== scenario.theme) {
        await themeButton.click()
        await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(scenario.theme)
      }
      const panel = page.getByRole('button', { name: '任务面板', exact: true })
      if (await panel.getAttribute('aria-expanded') !== 'true') await panel.click()
      await expect(page.getByTestId('desktop-agent-side-panel')).toBeVisible()
      const input = page.getByRole('textbox', { name: '发送消息', exact: true })
      await expect(input).toBeVisible()
      const geometry = await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>('[aria-label="发送消息"]')!
        const box = input.getBoundingClientRect()
        const workbench = document.querySelector<HTMLElement>('.desktop-agent-workbench')!
        const list = document.querySelector<HTMLElement>('.desktop-agent-list')!
        const panel = document.querySelector<HTMLElement>('.desktop-agent-side-panel')!
        return { viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          inputRight: box.right, inputWidth: box.width, workbenchWidth: workbench.clientWidth,
          chatWidth: document.querySelector<HTMLElement>('.desktop-agent-workbench-main')!.getBoundingClientRect().width,
          listDisplay: getComputedStyle(list).display, panelPosition: getComputedStyle(panel).position }
      })
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.inputRight).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.inputWidth).toBeGreaterThan(240)
      expect(geometry.chatWidth).toBeGreaterThan(0)
      if (geometry.workbenchWidth >= 1320) expect(geometry.chatWidth).toBeGreaterThanOrEqual(560)
      if (geometry.workbenchWidth < 1320) expect(geometry.listDisplay).toBe('none')
      if (geometry.workbenchWidth < 1000) expect(geometry.panelPosition).toBe('absolute')
      if (geometry.workbenchWidth >= 1000 && geometry.workbenchWidth < 1320) expect(geometry.panelPosition).not.toBe('absolute')
      expect(await page.locator('html').getAttribute('data-theme')).toBe(scenario.theme)
      await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/agent-workbench-aw12-electron-${scenario.width}-${scenario.zoom}-${scenario.theme}.png`) })
    }
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw12-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
