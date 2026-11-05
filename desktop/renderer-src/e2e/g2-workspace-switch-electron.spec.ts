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

test('DEV-QA26 G2-05 editor 与 viewer 只能切换已加入的工作区', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(180_000)

  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const ownerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-role-owner-'))
  const memberProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-role-member-'))
  let ownerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let memberApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    ownerApp = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${ownerProfile}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const ownerPage = await ownerApp.firstWindow()
    await ownerPage.goto(`${origin}/register`)
    await ownerPage.getByLabel('用户名', { exact: true }).fill(`qa26-g2-role-owner-${Date.now()}`)
    await ownerPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await ownerPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => ownerPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const originalMe = await api(ownerPage, 'GET', '/auth/me') as { workspace: { id: string; name: string } }
    const secondWorkspace = await api(ownerPage, 'POST', '/workspaces', { name: `QA26 editor-viewer 目标 ${Date.now()}`, switch: false }) as { id: string; name: string }
    const outsiderWorkspace = await api(ownerPage, 'POST', '/workspaces', { name: `QA26 editor-viewer 未授权 ${Date.now()}`, switch: false }) as { id: string; name: string }
    const originalAccount = await api(ownerPage, 'POST', '/accounts', {
      platform: 'xhs', name: 'QA26 editor 工作区账号', content_format: 'image_note',
    }) as { id: string }
    const originalWork = await api(ownerPage, 'POST', `/accounts/${originalAccount.id}/works`, { title: 'editor 工作区作品' }) as { id: string }
    const editorInvite = await api(ownerPage, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 }) as { code: string }

    await api(ownerPage, 'POST', `/workspaces/${secondWorkspace.id}/switch`, {})
    const secondAccount = await api(ownerPage, 'POST', '/accounts', {
      platform: 'wechat_mp', name: 'QA26 viewer 工作区账号', content_format: 'long_article',
    }) as { id: string }
    const secondWork = await api(ownerPage, 'POST', `/accounts/${secondAccount.id}/works`, { title: 'viewer 工作区作品' }) as { id: string }
    const viewerInvite = await api(ownerPage, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }

    memberApp = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${memberProfile}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: origin },
      timeout: 60_000,
    })
    const memberPage = await memberApp.firstWindow()
    const memberUsername = `qa26-g2-role-member-${Date.now()}`
    await memberPage.goto(`${origin}/register`)
    await memberPage.getByLabel('用户名', { exact: true }).fill(memberUsername)
    await memberPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await memberPage.getByLabel('邀请码（可选）').fill(editorInvite.code)
    await memberPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => memberPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    let memberMe = await api(memberPage, 'GET', '/auth/me') as { role: string; workspace: { id: string } }
    expect(memberMe.workspace.id).toBe(originalMe.workspace.id)
    expect(memberMe.role).toBe('editor')
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).toContain(originalAccount.id)
    expect(await apiStatus(memberPage, `/works/${secondWork.id}`)).toBe(404)

    await memberPage.goto(`${origin}/settings/members`)
    await memberPage.getByPlaceholder('邀请码', { exact: true }).fill(viewerInvite.code)
    const joinResponse = memberPage.waitForResponse((response) => response.url().endsWith('/api/v1/workspaces/join') && response.request().method() === 'POST')
    const joinNavigation = memberPage.waitForNavigation()
    await memberPage.getByRole('button', { name: '加入并切换', exact: true }).click()
    const [joined] = await Promise.all([joinResponse, joinNavigation])
    expect(joined.status()).toBe(200)
    await expect.poll(async () => (await api(memberPage, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(secondWorkspace.id)
    memberMe = await api(memberPage, 'GET', '/auth/me') as typeof memberMe
    expect(memberMe.role).toBe('viewer')
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).toContain(secondAccount.id)
    expect(await apiStatus(memberPage, `/works/${originalWork.id}`)).toBe(404)
    await memberPage.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(memberPage.getByTestId('desktop-settings-window')).toBeHidden()

    await openDesktopAccountSwitcher(memberPage)
    const viewerMenu = memberPage.getByTestId('desktop-context-menu')
    await expect(viewerMenu.getByRole('button', { name: originalMe.workspace.name, exact: true })).toBeEnabled()
    await expect(viewerMenu.getByRole('button', { name: outsiderWorkspace.name, exact: true })).toHaveCount(0)
    await memberPage.keyboard.press('Escape')

    await memberPage.keyboard.press('Control+k')
    const palette = memberPage.getByRole('dialog', { name: '命令面板', exact: true })
    await expect(palette).toBeVisible()
    const workspaceCommand = `切换工作区：${originalMe.workspace.name}`
    await palette.getByRole('textbox').fill(workspaceCommand)
    const paletteSwitch = memberPage.waitForResponse((response) => response.url().endsWith(`/api/v1/workspaces/${originalMe.workspace.id}/switch`) && response.request().method() === 'POST')
    const paletteNavigation = memberPage.waitForNavigation()
    await palette.getByRole('button', { name: workspaceCommand, exact: true }).click()
    const [paletteResponse] = await Promise.all([paletteSwitch, paletteNavigation])
    expect(paletteResponse.status()).toBe(200)
    await expect(memberPage.getByTestId('desktop-statusbar').locator('.desktop-statusbar-context')).toContainText(originalMe.workspace.name)
    await expect(memberPage).toHaveURL(/\/settings\/accounts$/)
    await expect.poll(async () => (await api(memberPage, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(originalMe.workspace.id)
    expect((await api(memberPage, 'GET', '/auth/me') as { role: string }).role).toBe('editor')
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).toContain(originalAccount.id)
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).not.toContain(secondAccount.id)
    await memberPage.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(memberPage.getByTestId('desktop-settings-window')).toBeHidden()

    await openDesktopAccountSwitcher(memberPage)
    const editorMenu = memberPage.getByTestId('desktop-context-menu')
    await expect(editorMenu.getByRole('button', { name: secondWorkspace.name, exact: true })).toBeEnabled()
    const topbarSwitch = memberPage.waitForResponse((response) => response.url().endsWith(`/api/v1/workspaces/${secondWorkspace.id}/switch`) && response.request().method() === 'POST')
    await editorMenu.getByRole('button', { name: secondWorkspace.name, exact: true }).click()
    expect((await topbarSwitch).status()).toBe(200)
    await expect(memberPage.getByTestId('desktop-statusbar').locator('.desktop-statusbar-context')).toContainText(secondWorkspace.name)
    await expect.poll(async () => (await api(memberPage, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(secondWorkspace.id)
    expect((await api(memberPage, 'GET', '/auth/me') as { role: string }).role).toBe('viewer')
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).toContain(secondAccount.id)
    expect((await api(memberPage, 'GET', '/accounts') as Array<{ id: string }>).map((account) => account.id)).not.toContain(originalAccount.id)

    const unauthorizedSwitch = await memberPage.evaluate(async (workspaceId) => {
      const me = await (await fetch('/api/v1/auth/me', { credentials: 'include' })).json()
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/switch`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: '{}',
      })
      return response.status
    }, outsiderWorkspace.id)
    expect([403, 404]).toContain(unauthorizedSwitch)
    expect((await api(memberPage, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(secondWorkspace.id)
  } finally {
    await memberApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await memberApp?.close().catch(() => undefined)
    await ownerApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await ownerApp?.close().catch(() => undefined)
    for (const [profile, prefix] of [[ownerProfile, 'ops-qa26-g2-role-owner-'], [memberProfile, 'ops-qa26-g2-role-member-']] as const) {
      if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !basename(profile).startsWith(prefix)) {
        throw new Error('拒绝清理测试目录之外路径')
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})

test('DEV-QA26 G2-05 真实 Electron 单工作区空列表、创建取消与读取失败重试', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟 API')
  test.setTimeout(180_000)

  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-g2-workspace-empty-'))
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
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-workspace-empty-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const me = await api(page, 'GET', '/auth/me') as { workspace: { id: string; name: string }; workspaces: Array<{ id: string }> }
    expect(me.workspaces.map((workspace) => workspace.id)).toEqual([me.workspace.id])
    const account = await api(page, 'POST', '/accounts', {
      platform: 'xhs', name: 'QA26 单工作区账号', content_format: 'image_note',
    }) as { id: string }
    await page.goto(`${origin}/a/${account.id}`)

    const workspaceWrites: string[] = []
    const recordWorkspaceWrite = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.pathname.startsWith('/api/v1/workspaces')) workspaceWrites.push(url.pathname)
    }
    page.on('request', recordWorkspaceWrite)

    const cancelSamples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      await openDesktopAccountSwitcher(page)
      const switcher = page.getByTestId('desktop-context-menu')
      await expect(switcher.getByText('其他工作区', { exact: true })).toHaveCount(0)
      await expect(switcher.getByRole('button', { name: /^切换到 / })).toHaveCount(0)
      const createButton = switcher.getByRole('button', { name: '创建工作区', exact: true })
      await expect(createButton).toBeEnabled()
      await createButton.click()

      const dialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: '创建新工作区并切换？', exact: true }),
      })
      await expect(dialog).toBeVisible()
      const started = performance.now()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toBeHidden()
      cancelSamples.push(performance.now() - started)
    }
    page.off('request', recordWorkspaceWrite)
    expect(workspaceWrites).toEqual([])
    expect((await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(me.workspace.id)

    const sorted = [...cancelSamples].sort((a, b) => a - b)
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log('QA26 G2-05 create workspace cancel', JSON.stringify({
      count: cancelSamples.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
      samples_ms: cancelSamples.map((value) => Number(value.toFixed(2))),
    }))

    const failMe = async (route: import('@playwright/test').Route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'qa26_workspace_list_unavailable', message: 'QA26 注入的工作区清单读取失败' } }),
    })
    await page.route('**/api/v1/auth/me', failMe)
    await page.reload()
    const authError = page.getByRole('alert')
    await expect(authError).toContainText('无法确认登录状态')
    await expect(authError).toContainText('QA26 注入的工作区清单读取失败')
    await page.unroute('**/api/v1/auth/me', failMe)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
    expect((await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace.id).toBe(me.workspace.id)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-g2-workspace-empty-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
