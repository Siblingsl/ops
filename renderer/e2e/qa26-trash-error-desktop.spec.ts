import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount, selectDesktopSetting } from './support'

test('DEV-QA26 G2-13 真实 Electron 回收站读取失败可重试并区分空态', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)

  const username = `qa26-trash-error-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-trash-error-'))
  let app: ElectronApplication | undefined
  let cdp: Awaited<ReturnType<Awaited<ReturnType<typeof _electron.launch>>['context']>['newCDPSession']> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + profile, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(baseURL + '/login')
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(baseURL + '/a/' + account.id)
    await native.getByRole('button', { name: /用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '设置…', exact: true }).click()

    let injectFailure = true
    let injectedFailures = 0
    cdp = await native.context().newCDPSession(native)
    cdp.on('Fetch.requestPaused', async (event) => {
      const requestURL = new URL(event.request.url)
      if (injectFailure && event.request.method === 'GET' && requestURL.pathname === '/api/v1/trash') {
        injectedFailures++
        await cdp!.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 500,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ error: { code: 'internal', message: 'qa26 injected failure' } })).toString('base64'),
        })
        return
      }
      await cdp!.send('Fetch.continueRequest', { requestId: event.requestId })
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/v1/trash*', requestStage: 'Request' }] })

    await selectDesktopSetting(native, '回收站')
    await expect.poll(() => injectedFailures).toBeGreaterThan(0)
    await expect(native.getByRole('alert')).toContainText('加载失败')
    const retry = native.getByRole('button', { name: '重试', exact: true })
    await expect(native.getByText('正在重试…', { exact: true })).not.toBeVisible()
    await expect(retry).toBeEnabled()
    injectFailure = false
    await cdp.send('Fetch.disable')
    await retry.click()
    await expect(native.getByText('回收站是空的', { exact: true })).toBeVisible()
    await expect(native.getByRole('heading', { name: '回收站', exact: true })).toBeVisible()
    expect(await api(page, 'GET', '/trash')).toEqual([])
    await test.info().attach('trash-electron-error-evidence', {
      body: Buffer.from(JSON.stringify({ environment: 'Windows Electron', injectedFailures, alert: '加载失败', retry: '空态', serverTrashCount: 0 }, null, 2)),
      contentType: 'application/json',
    })
  } finally {
    await cdp?.detach().catch(() => undefined)
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只关闭本用例启动的客户端。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    const resolved = resolve(profile)
    if (!resolved.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-trash-error-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
