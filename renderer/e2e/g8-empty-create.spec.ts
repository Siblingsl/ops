import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { registerAccount } from './support'

test('DEV-QA26 G8 真实 Electron 空作品页的空白新建标题保持为空', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const username = `qa26-empty-create-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-empty-create-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}/works`)
    await expect(native.getByRole('heading', { name: '作品', exact: true })).toBeVisible()
    await expect(native.getByText('这里还没有作品', { exact: true })).toBeVisible()

    await native.getByRole('button', { name: '空白新建', exact: true }).click()
    const panel = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '新建作品', exact: true }) })
    const title = panel.getByPlaceholder('未命名作品')
    await expect(panel).toBeVisible()
    await expect(title).toHaveValue('')
    await panel.getByRole('button', { name: '取消', exact: true }).click()
    await expect(panel).toHaveCount(0)
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-empty-create-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G8 真实 Electron 窄屏编辑器头部图标操作有可访问名称', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const username = `qa26-toolbar-names-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-toolbar-names-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.setViewportSize({ width: 375, height: 812 })
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}/works`)
    await expect(native.getByRole('heading', { name: '作品', exact: true })).toBeVisible()
    await native.getByRole('button', { name: '新建作品', exact: true }).click()
    const panel = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '新建作品', exact: true }) })
    await panel.getByPlaceholder('未命名作品').fill('QA26 toolbar names')
    await panel.getByRole('button', { name: '开始创作', exact: true }).click()
    await native.waitForURL(/\/works\/[a-f0-9-]+$/)

    await expect(native.getByRole('button', { name: '打开版本历史', exact: true })).toBeVisible()
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-toolbar-names-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
