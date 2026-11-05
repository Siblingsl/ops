import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

test('DEV-QA26 G1-03 真实 Electron 首次 setup、校验、失败重试与 owner 权限', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景必须使用隔离的空白本地数据库')
  test.skip(process.env.OPS_QA26_G103_SETUP !== '1', '一次性 setup 用例只能在专用空白数据库运行')
  test.setTimeout(180_000)

  const origin = baseURL ?? 'http://127.0.0.1:5288'
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g103-electron-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${origin}/setup`)
    await expect(page.getByRole('heading', { name: '设置登录账号', exact: true })).toBeVisible()
    await expect(page.getByText(/忘记密码需联系部署管理员/)).toBeVisible()
    await expect(page.getByText(/系统只有你一个用户/)).toHaveCount(0)

    const initialStatus = await page.evaluate(async () => (await (await fetch('/api/v1/auth/status')).json()))
    expect(initialStatus).toMatchObject({ needs_setup: true, registration_open: true })

    const username = `qa26-g103-electron-${Date.now()}`
    const password = 'local-e2e-password-123'
    const submit = page.getByRole('button', { name: '创建账号并进入', exact: true })
    await expect(submit).toBeDisabled()
    await page.getByLabel('用户名', { exact: true }).fill(username)
    const passwordInput = page.getByLabel(/登录密码/)
    await passwordInput.fill('short')
    await expect(page.getByText('密码至少需要 12 位', { exact: true })).toBeVisible()
    await expect(submit).toBeDisabled()
    await passwordInput.fill(password)
    const confirmation = page.getByLabel(/再输入一次/)
    const samples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now()
      await confirmation.fill(`${password.slice(0, -1)}${index % 2 === 0 ? '4' : '5'}`)
      await expect(submit).toBeDisabled()
      await expect(page.getByText('两次输入不一致', { exact: true })).toBeVisible()
      samples.push(performance.now() - started)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log('QA26 G1-03 Electron mismatch validation', JSON.stringify({
      count: samples.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
      samples_ms: samples.map(value => Number(value.toFixed(2))),
    }))

    await confirmation.fill(password)
    const injectedMessage = 'QA26 首次初始化服务暂不可用'
    const failSetup = (route: import('@playwright/test').Route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'qa26_setup_unavailable', message: injectedMessage } }),
    })
    await page.route('**/api/v1/auth/setup', failSetup)
    const failedRequest = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/setup') && response.request().method() === 'POST')
    await submit.click()
    expect((await failedRequest).status()).toBe(503)
    await expect(page.getByText(injectedMessage, { exact: true })).toBeVisible()
    await page.unroute('**/api/v1/auth/setup', failSetup)

    const setupRequest = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/setup') && response.request().method() === 'POST')
    await submit.click()
    expect((await setupRequest).status()).toBe(200)
    await expect(page).toHaveURL(/\/settings\/accounts(?:\?new=1)?$/)

    const me = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()))
    expect(me).toMatchObject({ username, role: 'owner', is_system_admin: false, admin_override: false })
    expect(me.workspace).toMatchObject({ role: 'owner' })
    expect(me.workspaces.map((workspace: { id: string }) => workspace.id)).toContain(me.workspace.id)
    const members = await page.evaluate(async () => (await (await fetch('/api/v1/workspaces/current/members')).json()))
    expect(members).toEqual([expect.objectContaining({ username, role: 'owner', status: 'active' })])
    expect(await page.evaluate(async () => (await fetch('/api/v1/admin/users')).status)).toBe(403)
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/auth/status')).json()).needs_setup)).toBe(false)

    await page.reload()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const secondSetup = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'qa26-g103-second-owner', password: 'local-e2e-password-456' }),
      })
      return response.status
    })
    expect(secondSetup).toBe(409)
    await page.goto(`${origin}/setup`)
    await expect(page).not.toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: '设置登录账号', exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !basename(profile).startsWith('ops-qa26-g103-electron-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
