import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 I1（桌面形态）：真实 Electron 窗口里对标目标卡监控开关、趋势图与覆盖提示。
// 与 Web 版差异：Electron 启动/profile/清理与桌面 Shell 路由；观测数据由本地
// ops-e2e 专用 DB 夹具补入，读取仍走真实服务端 trend/coverage API。

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
  }, { username: `i1-desktop-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: '桌面监控验收号', content_format: 'image_note', type_note: '',
  })
}

test('REF41 I1 双端（桌面）竞对监控：趋势两点、覆盖不足提示、失败点不连线', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-i1-monitor-'))
  const apiBase = baseURL!.replace(':5287', ':8287')
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

    await page.goto(`${origin}/a/${account.id}/profile?tab=benchmarks`, { waitUntil: 'load' })
    const panel = page.getByTestId('benchmark-tab')
    await expect(panel).toBeVisible({ timeout: 30_000 })

    await panel.getByLabel('名称（1..100 码点）').fill('I1 桌面监控对标')
    await panel.getByRole('button', { name: '添加对标', exact: true }).click()
    const targets = await api(page, origin, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; name: string }> }
    const target = targets.items.find((i) => i.name === 'I1 桌面监控对标')
    expect(target).toBeTruthy()

    const item = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 桌面监控对标' })
    await item.getByTestId(`benchmark-monitor-enable-${target!.id}`).click()
    await expect(item.getByTestId(`benchmark-monitor-${target!.id}`)).toContainText('开启', { timeout: 30_000 })
    await expect(item.getByTestId(`benchmark-monitor-interval-${target!.id}`)).toHaveValue('24')

    const seed = async (points: unknown[]) => {
      const response = await fetch(`${apiBase}/__e2e/benchmark/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: target!.id, points }),
      })
      expect(response.status, await response.text()).toBe(200)
    }

    await seed([{ seq: 1, quality_state: 'ok', values: { likes: 10 } }])
    await page.reload()
    await expect(panel).toBeVisible()
    const reloaded = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 桌面监控对标' })
    await expect(reloaded.getByTestId(`benchmark-coverage-hint-${target!.id}`)).toContainText('覆盖不足：仅 1 次观测')
    await expect(reloaded.getByText('日龄未知')).toBeVisible()

    await seed([
      { seq: 2, quality_state: 'ok', values: { likes: 14 }, published_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      { seq: 3, quality_state: 'failed', values: { likes: 0 } },
      { seq: 4, quality_state: 'partial', values: { likes: 12 } },
    ])
    await page.reload()
    await expect(panel).toBeVisible()
    const finalItem = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 桌面监控对标' })
    await expect(finalItem.getByTestId(`benchmark-coverage-hint-${target!.id}`)).toHaveCount(0)
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 1 次观测')
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 2 次观测')
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 3 次观测')
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 4 次观测')
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('采集失败（不计入 0）')
    await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('部分字段缺失')
    await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`)).toBeVisible()
    await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`).locator('polyline')).toHaveCount(1)
    await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`).locator('circle')).toHaveCount(4)
    await finalItem.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '../output/playwright/i1-desktop-benchmark-monitor.png', timeout: 30_000 })
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
