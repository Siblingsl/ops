import { expect, test, type Browser, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

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
  const toggle = page.getByRole('button', { name: '通知与 AI 任务', exact: true })
  await expect(toggle).toBeVisible()
  await toggle.click()
  const panel = page.locator('body')
  await expect(panel.getByRole('button', { name: /^通知(?:\s+\d+)?$/ })).toBeVisible()
  return panel
}

test('DEV-QA26 G8 Web 非空通知、SSE、逐条和全部已读', async ({ page, browser, baseURL }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地 E2E API')
  test.setTimeout(150_000)

  const ownerUsername = `qa26-g8-web-notification-${Date.now()}`
  await registerAccount(page, '图文笔记', 'xhs', ownerUsername)
  let notificationFetches = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/v1/notifications' && !url.searchParams.has('cursor')) notificationFetches++
  })

  const streamReady = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith('/api/v1/notifications/stream'))
  await page.reload()
  await streamReady
  await expect.poll(() => notificationFetches).toBeGreaterThan(0)
  let panel = await openNotificationPanel(page)
  let stored = await api(page, 'GET', '/notifications') as NotificationList
  if (stored.unread > 0) {
    await panel.getByRole('button', { name: '全部标为已读', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/notifications') as NotificationList).unread).toBe(0)
    stored = await api(page, 'GET', '/notifications') as NotificationList
  }

  let beforeRefresh = notificationFetches
  const firstMember = `qa26-g8-web-notice-one-${Date.now()}`
  await page.getByRole('button', { name: '通知与 AI 任务', exact: true }).click()
  await joinWorkspaceAsViewer(page, browser, baseURL!, firstMember)
  await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)
  stored = await api(page, 'GET', '/notifications') as NotificationList
  expect(stored.unread).toBe(1)
  await expect(page.getByRole('button', { name: '通知与 AI 任务', exact: true })).toBeVisible()
  panel = await openNotificationPanel(page)
  await expect(panel.getByRole('button', { name: new RegExp(firstMember) })).toBeVisible()
  const firstNotification = stored.items.find((item) => item.title === `${firstMember} 通过邀请码加入了工作区`)
  expect(firstNotification).toMatchObject({ read_at: null })

  const firstRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/notifications/${firstNotification!.id}/read`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: new RegExp(firstMember) }).click()
  expect((await firstRead).ok()).toBeTruthy()
  await expect(page).toHaveURL(/\/settings\/members$/)
  await expect.poll(async () => {
    const list = await api(page, 'GET', '/notifications') as NotificationList
    return list.items.find((item) => item.id === firstNotification!.id)?.read_at ?? null
  }).not.toBeNull()

  beforeRefresh = notificationFetches
  const secondMember = `qa26-g8-web-notice-two-${Date.now()}`
  await joinWorkspaceAsViewer(page, browser, baseURL!, secondMember)
  await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)
  const thirdMember = `qa26-g8-web-notice-three-${Date.now()}`
  beforeRefresh = notificationFetches
  await joinWorkspaceAsViewer(page, browser, baseURL!, thirdMember)
  await expect.poll(() => notificationFetches, { timeout: 10_000 }).toBeGreaterThan(beforeRefresh)

  await openNotificationPanel(page)
  stored = await api(page, 'GET', '/notifications') as NotificationList
  expect(stored.unread).toBe(2)
  expect(stored.items.filter((item) => !item.read_at)).toHaveLength(2)
  const allRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/notifications/read-all') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click()
  expect((await allRead).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', '/notifications') as NotificationList).unread).toBe(0)
  stored = await api(page, 'GET', '/notifications') as NotificationList
  expect(stored.items.every((item) => item.read_at !== null)).toBe(true)
})
