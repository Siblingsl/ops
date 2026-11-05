import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { registerAccount } from './support'

test('Web 工作区与账号菜单保留原有管理入口', async ({ page }) => {
  const account = await registerAccount(page)
  const accountTrigger = page.getByRole('button').filter({ hasText: account.name })
  await accountTrigger.click()
  const menu = page.getByTestId('workspace-account-menu')
  await expect(menu).toBeVisible()
  // 面板只放平台账号与创建入口；「成员与邀请」一直在右键菜单里（拆分前即如此）。
  await expect(menu.getByText('成员与邀请', { exact: true })).toHaveCount(0)
  await expect(menu.getByText('管理平台账号', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await accountTrigger.click({ button: 'right' })
  const contextMenu = page.getByRole('menu')
  await expect(contextMenu.getByRole('menuitem', { name: '成员与邀请', exact: true })).toBeVisible()
  await expect(contextMenu.getByRole('menuitem', { name: '管理平台账号', exact: true })).toBeVisible()
})

test('DEV-QA26 G2-05 Web 单工作区空列表、创建取消与读取失败重试', async ({ page }) => {
  const account = await registerAccount(page)
  const me = await (await page.request.get('/api/v1/auth/me')).json() as {
    workspace: { id: string }
    workspaces: Array<{ id: string }>
  }
  expect(me.workspaces.map((workspace) => workspace.id)).toEqual([me.workspace.id])

  const accountTrigger = page.getByRole('button').filter({ hasText: account.name })
  const workspaceWrites: string[] = []
  const recordWorkspaceWrite = (request: import('@playwright/test').Request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.startsWith('/api/v1/workspaces')) workspaceWrites.push(url.pathname)
  }
  page.on('request', recordWorkspaceWrite)

  const cancelSamples: number[] = []
  for (let index = 0; index < 20; index += 1) {
    await accountTrigger.click()
    const menu = page.getByTestId('workspace-account-menu')
    await expect(menu.getByText('其他工作区', { exact: true })).toHaveCount(0)
    await expect(menu.getByRole('button', { name: /^切换到 / })).toHaveCount(0)
    const createButton = menu.getByRole('button', { name: '创建工作区', exact: true })
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
  expect((await (await page.request.get('/api/v1/auth/me')).json()).workspace.id).toBe(me.workspace.id)

  const sorted = [...cancelSamples].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
  console.log('QA26 G2-05 Web create workspace cancel', JSON.stringify({
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
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  expect((await (await page.request.get('/api/v1/auth/me')).json()).workspace.id).toBe(me.workspace.id)
})

