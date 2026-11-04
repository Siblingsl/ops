import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { openDesktopAccountSwitcher } from './support'

async function api(page: Page, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me', { credentials: 'include' })).json())
  const result = await page.evaluate(async ({ method, path, data, csrf }) => {
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const text = await response.text()
    return { status: response.status, text }
  }, { method, path, data, csrf: me.csrf_token })
  if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${path}: ${result.status} ${result.text}`)
  return result.text ? JSON.parse(result.text) : null
}

async function apiStatus(page: Page, path: string) {
  return page.evaluate(async (url) => (await fetch(url, { credentials: 'include' })).status, `/api/v1${path}`)
}

test('DEV-QA26 G2-05 真实 Electron 创建并切换工作区、保存失败保护与数据隔离', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(180_000)

  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-workspaces-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-workspaces-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const originalMe = await api(page, 'GET', '/auth/me') as { workspace: { id: string; name: string } }
    const firstAccount = await api(page, 'POST', '/accounts', {
      platform: 'xhs', name: 'QA26 原工作区账号', content_format: 'image_note',
    }) as { id: string }
    const firstWork = await api(page, 'POST', `/accounts/${firstAccount.id}/works`, { title: '原工作区私有作品' }) as { id: string }
    await page.goto(`${origin}/a/${firstAccount.id}`)

    await openDesktopAccountSwitcher(page)
    const switcher = page.getByTestId('desktop-context-menu')
    await switcher.getByRole('button', { name: '创建工作区', exact: true }).click()
    const createDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '创建新工作区并切换？', exact: true }) })
    await expect(createDialog).toBeVisible()
    const createResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/workspaces') && response.request().method() === 'POST')
    await createDialog.getByRole('button', { name: '创建并切换', exact: true }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.ok()).toBe(true)
    await page.waitForURL((url) => url.pathname === '/')
    await expect.poll(async () => (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id)
      .not.toBe(originalMe.workspace.id)

    const secondMe = await api(page, 'GET', '/auth/me') as { workspace: { id: string; name: string }; workspaces: Array<{ id: string; name: string }> }
    const secondWorkspace = secondMe.workspace
    expect(secondMe.workspaces.map((workspace) => workspace.id)).toContain(originalMe.workspace.id)
    expect(secondWorkspace.id).not.toBe(originalMe.workspace.id)
    const secondAccount = await api(page, 'POST', '/accounts', {
      platform: 'wechat_mp', name: 'QA26 新工作区账号', content_format: 'long_article',
    }) as { id: string }
    const secondWork = await api(page, 'POST', `/accounts/${secondAccount.id}/works`, { title: '新工作区原始标题' }) as { id: string }
    await page.goto(`${origin}/works/${secondWork.id}`)
    const title = page.locator('#step-title').getByRole('textbox').first()
    await expect(title).toBeVisible()

    const invalidTitle = '这是一条超过三十二个字的公众号标题用来验证切换前必须先保存成功的分支'
    await title.fill(invalidTitle)
    await title.blur()
    const failedSwitchRequests: string[] = []
    const trackFailedSwitch = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/workspaces/${originalMe.workspace.id}/switch`) {
        failedSwitchRequests.push(request.url())
      }
    }
    page.on('request', trackFailedSwitch)
    await openDesktopAccountSwitcher(page)
    await page.getByTestId('desktop-context-menu').getByRole('button', { name: originalMe.workspace.name, exact: true }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: '保存未完成，已取消离开' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/works/${secondWork.id}$`))
    expect((await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(secondWorkspace.id)
    expect(failedSwitchRequests).toHaveLength(0)
    await expect(title).toHaveValue(invalidTitle)
    expect((await api(page, 'GET', `/works/${secondWork.id}`) as { title: string }).title).toBe('新工作区原始标题')
    page.off('request', trackFailedSwitch)

    const validTitle = '切换前成功保存的公众号标题'
    const requestOrder: string[] = []
    const trackSuccessfulSwitch = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'PATCH' && path === `/api/v1/works/${secondWork.id}`) requestOrder.push('flush')
      if (request.method() === 'POST' && path === `/api/v1/workspaces/${originalMe.workspace.id}/switch`) requestOrder.push('switch')
    }
    page.on('request', trackSuccessfulSwitch)
    await title.fill(validTitle)
    await title.blur()
    await openDesktopAccountSwitcher(page)
    const toOriginalWorkspace = page.waitForResponse((response) => response.url().endsWith(`/api/v1/workspaces/${originalMe.workspace.id}/switch`) && response.request().method() === 'POST')
    const firstSwitchStarted = performance.now()
    await page.getByTestId('desktop-context-menu').getByRole('button', { name: originalMe.workspace.name, exact: true }).click()
    expect((await toOriginalWorkspace).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id)
      .toBe(originalMe.workspace.id)
    const firstSwitchLatency = performance.now() - firstSwitchStarted
    const flushIndex = requestOrder.indexOf('flush')
    const switchIndex = requestOrder.indexOf('switch')
    expect(flushIndex).toBeGreaterThanOrEqual(0)
    expect(switchIndex).toBeGreaterThan(flushIndex)
    await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
    await expect(page.locator(`a[href="/works/${secondWork.id}"]`)).toHaveCount(0)

    const accountsInOriginal = await api(page, 'GET', '/accounts') as Array<{ id: string }>
    expect(accountsInOriginal.map((account) => account.id)).toContain(firstAccount.id)
    expect(accountsInOriginal.map((account) => account.id)).not.toContain(secondAccount.id)
    expect(await apiStatus(page, `/works/${firstWork.id}`)).toBe(200)
    expect(await apiStatus(page, `/works/${secondWork.id}`)).toBe(404)

    const samples = [firstSwitchLatency]
    for (let index = 1; index < 20; index += 1) {
      const currentWorkspaceId = (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id
      expect([originalMe.workspace.id, secondWorkspace.id]).toContain(currentWorkspaceId)
      const currentWorkspaceName = currentWorkspaceId === originalMe.workspace.id ? originalMe.workspace.name : secondWorkspace.name
      const target = currentWorkspaceId === originalMe.workspace.id ? secondWorkspace : originalMe.workspace
      await openDesktopAccountSwitcher(page)
      await expect(page.getByTestId('desktop-statusbar').locator('.desktop-statusbar-context')).toContainText(currentWorkspaceName)
      const item = page.getByTestId('desktop-context-menu').getByRole('button', { name: target.name, exact: true })
      await expect(item).toBeVisible()
      await expect(item).toBeEnabled()
      const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/workspaces/${target.id}/switch`) && response.request().method() === 'POST', { timeout: 15_000 })
      const started = performance.now()
      await item.click()
      expect((await responsePromise).status()).toBe(200)
      await expect.poll(async () => (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(target.id)
      if (target.id === secondWorkspace.id) {
        await expect(page.locator(`a.recent-tile[href="/works/${secondWork.id}"]`)).toBeVisible()
      } else {
        await expect(page.locator(`a[href="/works/${secondWork.id}"]`)).toHaveCount(0)
      }
      samples.push(performance.now() - started)
    }
    page.off('request', trackSuccessfulSwitch)

    const sorted = [...samples].sort((a, b) => a - b)
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log('QA26 G2-05 workspace switches', JSON.stringify({
      count: samples.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
      samples_ms: samples.map((value) => Number(value.toFixed(2))),
    }))

    const accountsInSecond = await api(page, 'GET', '/accounts') as Array<{ id: string }>
    expect(accountsInSecond.map((account) => account.id)).toContain(secondAccount.id)
    expect(accountsInSecond.map((account) => account.id)).not.toContain(firstAccount.id)
    expect(await apiStatus(page, `/works/${secondWork.id}`)).toBe(200)
    expect(await apiStatus(page, `/works/${firstWork.id}`)).toBe(404)
    expect((await api(page, 'GET', `/works/${secondWork.id}`) as { title: string }).title).toBe(validTitle)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-g2-workspaces-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
