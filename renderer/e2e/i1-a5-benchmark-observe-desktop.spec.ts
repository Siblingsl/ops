import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// REF41 I1-A5（桌面形态）：真实 Electron 主进程 claim → 无登录态隐藏窗口读取
// 公开主页 → 发现作品链接 → 读取公开作品页 → benchmark.observe.result。
// 页面样本由 ops-e2e 本地服务提供（只读、无 Cookie、无登录），不是把观测直接
// seed 进数据库；断言 observations 的 source 必须为 desktop。

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
  }, { username: `i1-a5-${Date.now()}`, password: 'local-e2e-password-123' })
  expect(registered.status, registered.body).toBe(200)
  await page.goto(`${origin}/`)
  return api(page, origin, 'POST', '/accounts', {
    platform: 'xhs', name: 'I1-A5 公开页只读验收号', content_format: 'image_note', type_note: '',
  })
}

test('REF41 I1-A5 桌面：claim 后真实读取公开主页/作品页并提交 desktop 观测', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-i1-a5-'))
  const apiBase = baseURL!.replace(':5287', ':8287')
  const publicProfile = `${apiBase}/__e2e/benchmark/public/profile`
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: {
        ...process.env,
        OPS_DESKTOP_DEV_URL: baseURL!,
        OPS_BENCHMARK_ALLOW_LOCAL: '1',
        OPS_BENCHMARK_OBSERVE_INTERVAL_MS: '2000',
      },
      timeout: 90_000,
    })
    const page = await app.firstWindow()
    const account = await setupUser(page, baseURL!)
    // 平台采集是工作区级开关；只在本测试工作区打开，避免影响其他 E2E。
    const policyBody = await api(page, baseURL!, 'GET', '/platform-collection/policy') as {
      policy: { enabled: boolean; authorization_revision: number }
    }
    if (!policyBody.policy.enabled) {
      await api(page, baseURL!, 'PUT', '/platform-collection/policy', {
        enabled: true,
        allow_member_connections: true,
        authorization_revision: policyBody.policy.authorization_revision,
      })
    }
    const created = await api(page, baseURL!, 'POST', `/accounts/${account.id}/benchmarks`, {
      platform: 'xhs', name: 'I1-A5 公开页只读对标', url: publicProfile,
    }) as { id: string }
    expect(created.id).toBeTruthy()
    // 趋势列表只在监控开启后渲染；这里开启真实监控，任务仍由上方 queue 显式触发。
    await api(page, baseURL!, 'PATCH', `/benchmark/targets/${created.id}/monitor`, {
      enabled: true, interval_hours: 24,
    })

    const queue = async () => {
      const response = await fetch(`${apiBase}/__e2e/benchmark/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: created.id }),
      })
      expect(response.status, await response.text()).toBe(200)
    }
    // 第一条任务由桌面 worker 真实 claim；第一条观测落库后再 queue 第二条，
    // 验证同一 external_id 的第二次观测形成 seq=2。
    await queue()

    const observations = async () => {
      const body = await api(page, baseURL!, 'GET', `/benchmark/targets/${created.id}/observations`) as {
        observations?: Array<{ seq: number; source: string; quality_state: string; values: Record<string, number> }>
      }
      return body.observations ?? []
    }
    let items: Awaited<ReturnType<typeof observations>> = []
    let deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      items = await observations()
      if (items.length >= 1) break
      await page.waitForTimeout(1000)
    }
    expect(items.length, JSON.stringify(items)).toBeGreaterThanOrEqual(1)
    await queue()
    deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      items = await observations()
      if (items.length >= 2) break
      await page.waitForTimeout(1000)
    }
    expect(items.length, JSON.stringify(items)).toBeGreaterThanOrEqual(2)
    expect(items[0].source).toBe('desktop')
    expect(items[0].quality_state).toBe('ok')
    expect(items[0].values).toMatchObject({ likes: 21, comments: 3, favorites: 8, shares: 1, views: 120 })
    expect(items[1].seq).toBe(2)
    expect(items[1].source).toBe('desktop')

    const trend = await api(page, baseURL!, 'GET', `/benchmark/targets/${created.id}/trend`) as {
      points?: Array<{ seq: number; published_at?: string | null; age_days?: number | null }>
    }
    expect(trend.points?.length).toBeGreaterThanOrEqual(2)
    expect(trend.points?.[0].published_at).toBeTruthy()
    expect(typeof trend.points?.[0].age_days).toBe('number')

    await page.goto(`${baseURL}/a/${account.id}/profile?tab=benchmarks`, { waitUntil: 'load' })
    const panel = page.getByTestId('benchmark-tab')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    const item = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1-A5 公开页只读对标' })
    await expect(item.getByTestId(`benchmark-trend-${created.id}`)).toContainText('第 1 次观测')
    await expect(item.getByTestId(`benchmark-trend-${created.id}`)).toContainText('第 2 次观测')
    await item.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '../output/playwright/i1-a5-benchmark-observe.png', timeout: 30_000 })
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
