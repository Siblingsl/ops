import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function localApi(page: Page, method: string, path: string, body?: unknown) {
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

test('OT-04 工作台埋点真实落库且可观测聚合按工作区返回', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-ot04-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`ot04-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    // 埋点默认关闭；本用例显式开启，验证真实落库，而不是用测试端点伪造计数。
    await localApi(page, 'PUT', '/me/preferences', { ux_events: true })
    await page.goto(`${baseURL}/agent`)
    const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    const bootstrap = await localApi(page, 'GET', '/agent/bootstrap')
    expect(bootstrap.features.workbench_ui).toBe(true)

    const panelToggle = page.locator('.desktop-agent-panel-button')
    if (await panelToggle.getAttribute('aria-expanded') !== 'true') await panelToggle.click()
    const panel = page.getByTestId('desktop-agent-side-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('tab', { name: /^上下文/ }).click()

    // 面板打开、页签切换和浏览器模式均来自真实 UI 操作；服务端按 ux_events 偏好落库。
    await expect.poll(async () => {
      const q = await localApi(page, 'GET', '/quality?days=1')
      return Math.min(
        q.ux_events.agent_panel_open ?? 0,
        q.ux_events.agent_panel_tab ?? 0,
        q.ux_events.agent_browser_mode ?? 0,
      )
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    const quality = await localApi(page, 'GET', '/quality?days=1')
    expect(quality.ux_events.agent_panel_open).toBeGreaterThanOrEqual(1)
    expect(quality.ux_events.agent_panel_tab).toBeGreaterThanOrEqual(1)
    expect(quality.ux_events.agent_browser_mode).toBeGreaterThanOrEqual(1)

    const metrics = await localApi(page, 'GET', '/agent/observability?days=1')
    expect(metrics.window_days).toBe(1)
    expect(metrics).toHaveProperty('run_failure_rate')
    expect(metrics).toHaveProperty('tool_failure_rate')
    expect(metrics).toHaveProperty('avg_run_duration_ms')
    expect(metrics).toHaveProperty('browser_failure_rate')

    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-ot04-panel-events.png') })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-ot04-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
