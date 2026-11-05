import { _electron, expect, test, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount } from './support'

type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>
type NotificationList = { items: Array<{ id: string; title: string; read_at: string | null }>; unread: number }

async function joinWorkspaceAsViewer(page: Page, browser: Browser, baseURL: string, username: string) {
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
  const context = await browser.newContext({ baseURL: new URL(baseURL).origin })
  try {
    const joined = await context.request.post('/api/v1/auth/register', {
      data: { username, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok(), '观察者通过本地邀请码加入工作区').toBeTruthy()
  } finally {
    await context.close()
  }
}

async function openNotificationPanel(page: Page) {
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: /通知与 AI 任务/ }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  return panel
}

async function loginElectron(baseURL: string, username: string, stubDeniedPermission = true) {
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-notifications-'))
  let app: ElectronApp | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    if (stubDeniedPermission) {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'Notification', {
          configurable: true,
          value: class {
            static permission = 'denied'
            static requestPermission = async () => 'denied'
          },
        })
      })
    }
    await page.goto(`${baseURL}/login`)
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    return { app, page, profile }
  } catch (error) {
    await closeElectron(app, profile)
    throw error
  }
}

async function closeElectron(app: ElectronApp | undefined, profile: string) {
  if (app) {
    try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本用例启动的客户端。 */ }
    await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
  }
  const resolved = resolve(profile)
  if (!resolved.startsWith(resolve(tmpdir()) + sep) || !profile.includes('ops-qa26-g8-notifications-')) throw new Error('拒绝清理测试目录之外路径')
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('DEV-QA26 G8 真实 Electron 非空通知、SSE、逐条/全部已读与系统拒绝态', async ({ page, browser, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地 E2E API')
  test.setTimeout(210_000)

  const ownerUsername = `qa26-g8-notification-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', ownerUsername)
  const owner = await loginElectron(baseURL!, ownerUsername)
  await owner.page.evaluate(async (accountId) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
  }, account.id)
  await owner.page.goto(`${baseURL}/a/${account.id}`)
  await expect(owner.page.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()
  let notificationFetches = 0
  owner.page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/v1/notifications' && !url.searchParams.has('cursor')) notificationFetches++
  })

  try {
    const stream = owner.page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith('/api/v1/notifications/stream'))
    await owner.page.reload()
    await stream
    await expect.poll(() => notificationFetches).toBeGreaterThan(0)
    const panel = await openNotificationPanel(owner.page)
    let stored = await api(page, 'GET', '/notifications') as NotificationList
    if (stored.unread > 0) {
      await panel.getByRole('button', { name: '全部标为已读', exact: true }).click()
      await expect.poll(async () => (await api(page, 'GET', '/notifications') as NotificationList).unread).toBe(0)
      stored = await api(page, 'GET', '/notifications') as NotificationList
    }
    await expect(panel.getByRole('button', { name: '系统通知已阻止', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '系统通知已阻止', exact: true }).click()
    await expect(owner.page.getByText('系统已阻止通知，请到应用权限设置中开启。', { exact: true })).toBeVisible()

    let beforeRefresh = notificationFetches
    const firstMember = `qa26-g8-notice-one-${Date.now()}`
    await joinWorkspaceAsViewer(page, browser, baseURL!, firstMember)
    await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)
    await expect(panel.getByRole('button', { name: new RegExp(firstMember) })).toBeVisible()
    stored = await api(page, 'GET', '/notifications') as NotificationList
    expect(stored.unread).toBe(1)
    const firstNotification = stored.items.find((item) => item.title === `${firstMember} 通过邀请码加入了工作区`)
    expect(firstNotification).toMatchObject({ read_at: null })

    const firstRead = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/notifications/${firstNotification!.id}/read`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: new RegExp(firstMember) }).click()
    expect((await firstRead).ok()).toBeTruthy()
    await expect(owner.page).toHaveURL(/\/settings\/members$/)
    await expect.poll(async () => {
      const list = await api(page, 'GET', '/notifications') as NotificationList
      return list.items.find((item) => item.id === firstNotification!.id)?.read_at ?? null
    }).not.toBeNull()
    await owner.page.goto(`${baseURL}/a/${account.id}`)
    await expect(owner.page.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()

    beforeRefresh = notificationFetches
    const secondMember = `qa26-g8-notice-two-${Date.now()}`
    await joinWorkspaceAsViewer(page, browser, baseURL!, secondMember)
    await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)
    const thirdMember = `qa26-g8-notice-three-${Date.now()}`
    beforeRefresh = notificationFetches
    await joinWorkspaceAsViewer(page, browser, baseURL!, thirdMember)
    await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)

    await openNotificationPanel(owner.page)
    stored = await api(page, 'GET', '/notifications') as NotificationList
    expect(stored.unread).toBe(2)
    expect(stored.items.filter((item) => !item.read_at)).toHaveLength(2)
    const allRead = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/notifications/read-all') && response.request().method() === 'POST')
    await owner.page.getByRole('button', { name: '全部标为已读', exact: true }).click()
    expect((await allRead).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', '/notifications') as NotificationList).unread).toBe(0)
    stored = await api(page, 'GET', '/notifications') as NotificationList
    expect(stored.items.every((item) => item.read_at !== null)).toBe(true)
  } finally {
    await closeElectron(owner.app, owner.profile)
  }
})

test('DEV-QA26 G8 真实 Electron 用户可启用并保留桌面通知选择', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地 E2E API')
  test.setTimeout(120_000)

  const username = `qa26-g8-native-optin-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const owner = await loginElectron(baseURL!, username, false)
  try {
    await owner.page.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await owner.page.goto(`${baseURL}/a/${account.id}`)
    await expect(owner.page.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: /通知与 AI 任务/ }).click()
    const panel = owner.page.locator('.notification-panel')
    await expect(panel).toBeVisible()

    const permission = await owner.page.evaluate(() => Notification.permission)
    expect(permission, '新建 Electron profile 不应被主进程无条件拒绝通知权限').not.toBe('denied')
    await panel.getByRole('button', { name: '开启桌面提示', exact: true }).click()
    await expect(panel.getByRole('button', { name: '关闭桌面提示', exact: true })).toBeVisible()
    const setting = await owner.page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      return localStorage.getItem(`ops.agent-native-notifications.v1:${me.user_id ?? me.username}:${me.workspace.id}`)
    })
    expect(setting).toBe('1')

    await owner.page.reload()
    await expect.poll(() => owner.page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await openNotificationPanel(owner.page)
    await expect(owner.page.locator('.notification-panel').getByRole('button', { name: '关闭桌面提示', exact: true })).toBeVisible()
  } finally {
    await closeElectron(owner.app, owner.profile)
  }
})
