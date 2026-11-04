import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

const password = 'local-e2e-password-123'

function localDate(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

async function makeNoPermissionPresentation(page: Page, accountID: string) {
  await page.route('**/api/v1/accounts*', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/accounts') return route.continue()
    const response = await route.fetch()
    const accounts = await response.json() as Array<{ id: string; datacube_state?: string }>
    const account = accounts.find((row) => row.id === accountID)
    if (!account) throw new Error('E2E 账号未出现在账号列表中')
    account.datacube_state = 'no_permission'
    await route.fulfill({ response, json: accounts })
  })
  await page.route(`**/api/v1/accounts/${accountID}/followers*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const followers = await response.json() as { api: boolean }
    followers.api = false
    await route.fulfill({ response, json: followers })
  })
}

test('DEV-QA26 G6 真实 Electron 粉丝同步、权限提示与手动回退', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API')
  test.setTimeout(360_000)

  const username = `qa26-g6-followers-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username) as { id: string }
  const accountPath = `/accounts/${account.id}`
  await api(page, 'PUT', `${accountPath}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-wechat-secret' })
  const capability = await api(page, 'POST', `${accountPath}/wechat-credential/test`) as { ok: boolean; datacube_state: string }
  expect(capability).toMatchObject({ ok: true, datacube_state: 'ok' })

  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g6-followers-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    native.setDefaultTimeout(15_000)
    native.setDefaultNavigationTimeout(30_000)
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const accountSettings = native.getByTestId('desktop-settings-window')
    await expect(accountSettings.getByText('请先在头像菜单选择账号', { exact: true })).toBeVisible()
    await accountSettings.getByRole('button', { name: '返回并选择账号', exact: true }).click()
    const picker = native.getByTestId('desktop-context-menu')
    await picker.getByRole('tab', { name: /公众号/ }).click()
    await picker.getByRole('button', { name: '浏览器验收号', exact: true }).click()
    await expect(native.locator('.desktop-statusbar-context')).toContainText('浏览器验收号')
    await expect(accountSettings).toHaveCount(0)
    await native.getByRole('link', { name: '复盘', exact: true }).click()
    await expect(native.getByRole('heading', { name: '数据复盘', exact: true })).toBeVisible()

    let syncRequests = 0
    native.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes(`${accountPath}/metrics/sync-wechat`)) syncRequests++
    })
    const syncResponse = native.waitForResponse((response) => response.url().includes(`${accountPath}/metrics/sync-wechat`) && response.request().method() === 'POST')
    await native.getByRole('button', { name: '同步公众号数据', exact: true }).click()
    const response = await syncResponse
    expect(response.ok()).toBeTruthy()
    const result = await response.json() as { result: { days: number; follower_days: number }; message: string }
    expect(result.result).toMatchObject({ days: 7, follower_days: 7 })
    expect(result.message).toContain('账号粉丝数据 7 天')

    const followers = await api(page, 'GET', `${accountPath}/followers?days=30`) as { api: boolean; days: Array<{ date: string; source: string }> }
    expect(followers.api).toBe(true)
    expect(followers.days).toHaveLength(7)
    expect(followers.days.every((row) => row.source === 'wechat_api')).toBe(true)
    const section = native.locator('#desktop-review-followers')
    await native.getByRole('button', { name: '粉丝记录', exact: true }).click()
    await expect(section.getByRole('heading', { name: /账号粉丝变化/ })).toBeVisible()
    await expect(section.getByText('公众号接口', { exact: true })).toHaveCount(7)

    // 只覆盖界面权限分支；底层 no_permission/403 与部分粉丝失败由 DR03/DR09 Go 集成测试验证。
    await makeNoPermissionPresentation(native, account.id)
    await native.reload()
    await expect(native.getByText(/当前公众号没有数据统计接口权限/).first()).toBeVisible()
    await expect(native.getByRole('button', { name: '同步公众号数据', exact: true })).toHaveCount(0)
    const requestsBeforeRestrictedClick = syncRequests
    await native.getByRole('button', { name: '同步与匹配', exact: true }).click()
    await native.waitForTimeout(300)
    expect(syncRequests).toBe(requestsBeforeRestrictedClick)

    await native.getByRole('button', { name: '粉丝记录', exact: true }).click()
    const restrictedSection = native.locator('#desktop-review-followers')
    await restrictedSection.getByRole('button', { name: '补录一天', exact: true }).click()
    await expect(restrictedSection.getByText('当前公众号没有数据统计接口权限，可以从后台抄录每天的关注数据')).toBeVisible()
    const enteredDate = new Date()
    enteredDate.setDate(enteredDate.getDate() - 20)
    const manualDate = localDate(enteredDate)
    await restrictedSection.getByLabel('日期').fill(manualDate)
    await restrictedSection.getByLabel('新增关注').fill('3')
    await restrictedSection.getByLabel('取消关注').fill('1')
    await restrictedSection.getByLabel('粉丝总数').fill('100')
    const manualSave = native.waitForResponse((r) => r.url().includes(`${accountPath}/followers`) && r.request().method() === 'POST')
    await restrictedSection.getByRole('button', { name: '保存', exact: true }).click()
    expect((await manualSave).ok()).toBeTruthy()
    const persisted = await api(page, 'GET', `${accountPath}/followers?days=30`) as { days: Array<{ date: string; source: string; new_follow: number | null }> }
    expect(persisted.days).toHaveLength(8)
    expect(persisted.days.find((row) => row.date === manualDate)).toMatchObject({ source: 'manual', new_follow: 3 })
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g6-followers-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
