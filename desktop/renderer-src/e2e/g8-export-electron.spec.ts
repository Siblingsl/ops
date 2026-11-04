import { _electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount, selectDesktopSetting } from './support'

test('DEV-QA26 G8 真实 Electron 导出并读取 CSV 文件', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const username = `qa26-export-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const title = `QA26导出内容-${Date.now()}`
  await api(page, 'POST', `/accounts/${account.id}/works`, { title, viewpoint: '导出文件必须包含本账号作品' })

  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-export-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
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
    await native.goto(`${baseURL}/a/${account.id}`)
    await expect(native.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()

    const settings = native.getByTestId('desktop-settings-window')
    await native.getByRole('button', { name: /用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(native, '数据导出')
    await expect(settings.getByRole('heading', { name: '数据导出', exact: true })).toBeVisible()

    const savedPath = resolve('../../.playwright-results', `qa26-g8-export-${Date.now()}.csv`)
    await mkdir(resolve('../../.playwright-results'), { recursive: true })
    await app.evaluate(({ session }, filePath) => {
      session.fromPartition('persist:ops-business-development').on('will-download', (_event, item) => item.setSavePath(filePath))
    }, savedPath)
    const exportPromise = native.waitForResponse((response) => response.url().endsWith('/api/v1/exports') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '导出', exact: true }).click()
    let response = await exportPromise
    if (response.status() === 403) {
      const reauth = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认是你本人', exact: true }) })
      await expect(reauth).toBeVisible()
      await reauth.getByPlaceholder('登录密码').fill('local-e2e-password-123')
      const retryExport = native.waitForResponse((item) => item.url().endsWith('/api/v1/exports') && item.request().method() === 'POST')
      await reauth.getByRole('button', { name: '确认', exact: true }).click()
      response = await retryExport
    }
    expect(response.ok()).toBeTruthy()
    await expect.poll(() => readFile(savedPath, 'utf8').catch(() => ''), { timeout: 10_000 }).toContain(title)
    const csv = await readFile(savedPath, 'utf8')
    expect(csv).toContain('账号,标题,状态,形态,观点,发布链接,更新时间,指标快照JSON,平台')
    expect(csv).toContain(title)
    expect(csv).toContain('浏览器验收号')
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g8-export-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
