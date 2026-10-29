import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electronLocalSettingsEvaluate, selectDesktopSetting } from './support'

test('D-126/D-132 真实 Electron 设置、当前账号隔离、窄窗布局与受信任本机窗口', async () => {
  test.skip(process.platform !== 'win32', 'Windows 客户端验收')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-d126-settings-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto('http://127.0.0.1:5287/register')
    await page.getByLabel('用户名', { exact: true }).fill(`d126-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const createdAccounts = await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const create = async (name: string) => {
        const response = await fetch('/api/v1/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
          body: JSON.stringify({ platform: 'xhs', name, content_format: 'image_note', type_note: '' }),
        })
        if (!response.ok) throw new Error(`创建验收账号失败：${response.status}`)
        return response.json()
      }
      return {
        account: await create('真实客户端设置验收号'),
        other: await create('真实 Electron 不应显示的其他账号'),
      }
    }) as { account: { id: string }; other: { id: string; name: string } }
    const { account, other } = createdAccounts
    await page.goto(`http://127.0.0.1:5287/a/${account.id}`)
    const dashboard = page.getByTestId('desktop-dashboard')
    await expect(dashboard).toBeVisible()
    await dashboard.evaluate((element) => element.setAttribute('data-preserved', 'actual-electron'))
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settings = page.getByTestId('desktop-settings-window')
    await expect(settings).toBeVisible()
    await selectDesktopSetting(page, '平台账号与凭证')
    const currentName = settings.getByRole('textbox', { name: '账号名称', exact: true })
    await expect(currentName).toHaveValue('真实客户端设置验收号')
    await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
    await expect(settings.getByPlaceholder('搜索账号名称或平台')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: '添加账号', exact: true })).toHaveCount(0)
    const body = settings.locator('.desktop-settings-body')
    for (const [width, height] of [[1440, 900], [960, 640], [740, 640]]) {
      await page.setViewportSize({ width, height })
      await expect.poll(() => body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy()
      const bounds = await settings.boundingBox()
      expect(bounds).toBeTruthy()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height - 24)
      await page.screenshot({ path: `../../output/playwright/d132-electron-account-${width}x${height}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1024, height: 768 })
    await selectDesktopSetting(page, '每日推荐设置')
    await settings.getByLabel('后台生成小时（北京时间）').fill('9')
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/daily-settings') && response.request().method() === 'PUT')
    await settings.getByRole('button', { name: '保存默认设置', exact: true }).click()
    expect((await saved).ok()).toBeTruthy()
    await expect(settings.getByText('有未保存的修改')).toHaveCount(0)
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.screenshot({ path: '../../output/playwright/d126-electron-settings.png' })
    await selectDesktopSetting(page, '客户端连接')
    await expect(settings.getByRole('heading', { name: '客户端连接', exact: true })).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect.poll(() => app!.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL())))
      .toContain('ops-desktop://settings/embedded/connection')
    await expect.poll(() => electronLocalSettingsEvaluate<{ loading: boolean; outline: string }>(app!,
      `(()=>{const panel=document.querySelector('[data-settings-panel="connection"]');const heading=panel.querySelector(':scope > h2');const fields=['origin','connection-state','version','ai-status'];return {loading:fields.some((id)=>document.getElementById(id)?.textContent==='读取中…'),outline:getComputedStyle(heading).outlineStyle}})()`))
      .toEqual({ loading: false, outline: 'none' })
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!,
      `document.getElementById('origin').textContent`)).toBe('http://127.0.0.1:5287')
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!,
      `document.getElementById('action-status').textContent`)).toBe('')
    const connectionPanel = await electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[]; hasLocalBridge: boolean }>(app,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel),hasLocalBridge:typeof window.opsDesktopSettings==='object'})`)
    expect(connectionPanel).toEqual({ panel: 'connection', visiblePanels: ['connection'], hasLocalBridge: true })
    expect(await page.evaluate(() => typeof (window as any).opsDesktopSettings)).toBe('undefined')

    await selectDesktopSetting(page, '本机 AI 配置')
    await expect.poll(() => electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[] }>(app,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel)})`))
      .toEqual({ panel: 'ai', visiblePanels: ['models', 'selftest', 'routes'] })
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app,
      `document.getElementById('settings-content').inert === false`)).toBeTruthy()
    await electronLocalSettingsEvaluate(app,
      `(()=>{const input=document.querySelector('#model-name');input.value='等待离开保护';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await expect(settings.getByText('有未保存的修改', { exact: true })).toBeVisible()
    await selectDesktopSetting(page, '账号与设备')
    const leavePrompt = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(leavePrompt).toBeVisible()
    await leavePrompt.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/local\/ai$/)
    await expect.poll(() => electronLocalSettingsEvaluate<{ panel: string }>(app,
      `({panel:document.body.dataset.embeddedPanel})`)).toEqual({ panel: 'ai' })
    await selectDesktopSetting(page, '账号与设备')
    await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
      .getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/local\/account-device$/)
    await expect.poll(() => electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[] }>(app,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel)})`))
      .toEqual({ panel: 'account-device', visiblePanels: ['account'] })
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app,
      `document.getElementById('settings-content').inert === false`)).toBeTruthy()
    await expect(settings.getByText('有未保存的修改', { exact: true })).toHaveCount(0)
    await selectDesktopSetting(page, '诊断与关于')
    await expect.poll(() => electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[] }>(app,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel)})`))
      .toEqual({ panel: 'diagnostics', visiblePanels: ['diagnostics'] })
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app,
      `['about-client-version','about-service-version','about-service-mode','about-data-size'].every((id)=>{const value=document.getElementById(id)?.textContent;return Boolean(value)&&value!=='读取中…'})`)).toBeTruthy()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await settings.getByRole('button', { name: '关闭设置' }).click()
    await expect(settings).toHaveCount(0)
    await expect(dashboard).toHaveAttribute('data-preserved', 'actual-electron')
    await expect(page).toHaveURL(`http://127.0.0.1:5287/a/${account.id}`)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 只清理本测试创建的进程。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    expect(profile.startsWith(join(tmpdir(), 'ops-d126-settings-'))).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('本机配置不可读取时连接与诊断信息仍显示明确状态', async () => {
  test.skip(process.platform !== 'win32', 'Windows 客户端验收')
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-settings-state-error-'))
  await writeFile(join(profile, 'desktop-config.json'), '{invalid json', 'utf8')
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto('http://127.0.0.1:5287/register')
    const username = `settings-state-error-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch('/api/v1/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: JSON.stringify({ platform: 'xhs', name: '本机状态读取失败验收号', content_format: 'image_note', type_note: '' }),
      })
      if (!response.ok) throw new Error(`创建验收账号失败：${response.status}`)
      return response.json() as Promise<{ id: string }>
    })
    await page.goto(`http://127.0.0.1:5287/a/${account.id}`)
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settings = page.getByTestId('desktop-settings-window')
    await expect(settings).toBeVisible()
    await selectDesktopSetting(page, '诊断与关于')
    await expect.poll(() => app!.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL())))
      .toContain('ops-desktop://settings/embedded/diagnostics')
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app!,
      `['about-client-version','about-service-version','about-service-mode','about-data-size'].every((id)=>{const value=document.getElementById(id)?.textContent;return Boolean(value)&&value!=='读取中…'})`)).toBeTruthy()
    await selectDesktopSetting(page, '账号与设备')
    await expect.poll(() => app!.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL())))
      .toContain('ops-desktop://settings/embedded/account-device')
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!,
      `document.getElementById('account').textContent`)).toContain(username)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!,
      `document.getElementById('device-state').textContent`)).toBe('本机配置文件无法读取')
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app!,
      `document.getElementById('mode-select').disabled`)).toBe(true)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 只清理本测试创建的进程。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    expect(profile.startsWith(join(tmpdir(), 'ops-settings-state-error-'))).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
