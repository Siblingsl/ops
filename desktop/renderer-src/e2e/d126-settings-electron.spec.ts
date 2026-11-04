import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electronLocalSettingsEvaluate, electronLocalSettingsWaitIdle, electronLocalSettingsWaitPanel, selectDesktopSetting } from './support'

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

test('DEV-QA26 G7 智能体设置、桌面 AI 策略与提示词模板真实 Electron 验收', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', 'Windows 客户端验收')
  test.setTimeout(240_000)
  const appUrl = baseURL ?? 'http://127.0.0.1:5287'
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-agent-settings-'))
  const userName = `qa26-agent-settings-${Date.now()}`
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let originalAgentPick: boolean | undefined
  let template: { task_type: string; content: string } | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: appUrl },
      timeout: 60_000,
    })
    let page = await app.firstWindow()
    await page.goto(`${appUrl}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(userName)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch('/api/v1/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: JSON.stringify({ platform: 'xhs', name: 'DEV-QA26 本机 AI 设置验收号', content_format: 'image_note', type_note: '' }),
      })
      if (!response.ok) throw new Error(`创建验收账号失败：${response.status}`)
      return response.json() as Promise<{ id: string }>
    })

    await page.goto(`${appUrl}/settings/agent`)
    await expect(page.getByRole('heading', { name: '智能体设置', exact: true })).toBeVisible()
    const agentSetting = page.getByRole('switch', { name: '允许成员自选模型', exact: true })
    const initialAgent = await page.evaluate(async () => (await (await fetch('/api/v1/agent/settings')).json()) as { allow_model_pick: boolean })
    originalAgentPick = initialAgent.allow_model_pick
    const changedAgent = page.waitForResponse((response) => response.url().endsWith('/api/v1/agent/settings') && response.request().method() === 'PUT')
    await agentSetting.click()
    expect((await changedAgent).ok()).toBeTruthy()
    await expect.poll(() => page.evaluate(async () => ((await (await fetch('/api/v1/agent/settings')).json()) as { allow_model_pick: boolean }).allow_model_pick)).toBe(!initialAgent.allow_model_pick)
    await page.reload()
    await expect(agentSetting).toHaveAttribute('aria-checked', String(!initialAgent.allow_model_pick))
    await agentSetting.click()
    await expect.poll(() => page.evaluate(async () => ((await (await fetch('/api/v1/agent/settings')).json()) as { allow_model_pick: boolean }).allow_model_pick)).toBe(initialAgent.allow_model_pick)
    originalAgentPick = undefined

    await page.goto(`${appUrl}/settings/desktop-ai`)
    await expect(page.getByRole('heading', { name: '工作区桌面 AI 策略' })).toBeVisible()
    const policy = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    await expect(page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true }))
      .toHaveAttribute('aria-checked', String(policy.policy.enabled))
    await expect(page.getByRole('switch', { name: '允许 editor 使用各自的桌面 AI 端点', exact: true }))
      .toHaveAttribute('aria-checked', String(policy.policy.allow_member_endpoints))
    await expect(page.getByText(`授权版本 ${policy.policy.authorization_revision}`, { exact: true })).toBeVisible()
    if (!policy.global_enabled) {
      await expect(page.getByText('服务端尚未全局启用桌面 AI；工作区开关当前不会生效。', { exact: true })).toBeVisible()
      await expect(page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })).toBeDisabled()
    }
    // 本用例不打开工作区桌面 AI 或成员端点授权；下面验证策略关闭时本机模型保存会被拒绝。
    expect(policy.global_enabled).toBe(true)
    expect(policy.policy.enabled).toBe(false)

    await page.goto(`${appUrl}/settings/prompts`)
    const templates = await page.evaluate(async () => (await (await fetch('/api/v1/prompt-templates')).json()) as { task_type: string; content: string }[])
    template = templates[0]
    expect(template).toBeTruthy()
    const updatedContent = `${template.content}\n\nDEV-QA26 Electron 保存后重载 ${Date.now()}`
    const openTemplate = async (content: string) => {
      const row = page.locator('li').filter({ hasText: template!.task_type }).first()
      await row.getByRole('button', { name: '编辑', exact: true }).click()
      const editor = page.getByLabel('任务指令')
      await expect(editor).toHaveValue(content)
      return editor
    }
    let editor = await openTemplate(template.content)
    await editor.fill(updatedContent)
    const savedTemplate = page.waitForResponse((response) => response.url().endsWith(`/api/v1/prompt-templates/${template!.task_type}`) && response.request().method() === 'PUT')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect((await savedTemplate).ok()).toBeTruthy()
    await expect(page.getByText('已保存新版本（系统规则不可改）', { exact: true })).toBeVisible()
    await page.reload()
    editor = await openTemplate(updatedContent)
    await editor.fill(template.content)
    const restoredTemplate = page.waitForResponse((response) => response.url().endsWith(`/api/v1/prompt-templates/${template!.task_type}`) && response.request().method() === 'PUT')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect((await restoredTemplate).ok()).toBeTruthy()
    await expect.poll(() => page.evaluate(async (taskType) => {
      const current = (await (await fetch('/api/v1/prompt-templates')).json() as { task_type: string; content: string }[]).find((item) => item.task_type === taskType)
      return current?.content
    }, template.task_type)).toBe(template.content)
    template = undefined

    // 尝试保存无密钥的回环配置；工作区策略关闭时应由服务端拒绝，且不会连接端点或做模型自检。
    await page.goto(`${appUrl}/a/${account.id}`)
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settings = page.getByTestId('desktop-settings-window')
    await expect(settings).toBeVisible()
    await selectDesktopSetting(page, '本机 AI 配置')
    await electronLocalSettingsWaitPanel(app, 'ai')
    await electronLocalSettingsEvaluate(app,
      `(()=>{const input=document.getElementById('password');input.value='local-e2e-password-123';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('reauth').click();return true})()`)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!, `document.getElementById('action-status').textContent`))
      .toBe('账号已重新认证，有效期 5 分钟。')
    const localModelName = `QA26 无调用 ${Date.now()}`
    await electronLocalSettingsEvaluate(app,
      `(()=>{const fields={'model-name':${JSON.stringify(localModelName)},'base-url':'http://127.0.0.1:9/v1/','model-names':'qa26-no-call'};for(const [id,value] of Object.entries(fields)){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))}document.getElementById('save-model').click();return true})()`)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!, `document.getElementById('action-status').textContent`), { timeout: 30_000 })
      .toBe('当前工作区尚未启用桌面 AI')
    const rejectedLocalModel = await electronLocalSettingsEvaluate<{ options: string[]; name: string; baseUrl: string; models: string; key: string }>(app,
      `(()=>({options:Array.from(document.getElementById('model-select').options).map(option=>option.value),name:document.getElementById('model-name').value,baseUrl:document.getElementById('base-url').value,models:document.getElementById('model-names').value,key:document.getElementById('api-key').value}))()`)
    expect(rejectedLocalModel).toEqual({ options: [''], name: localModelName, baseUrl: 'http://127.0.0.1:9/v1/', models: 'qa26-no-call', key: '' })
    await electronLocalSettingsEvaluate(app, `document.getElementById('refresh-models').click();true`)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!, `document.getElementById('action-status').textContent`))
      .toBe('本机配置已刷新。')
    expect(await electronLocalSettingsEvaluate<string[]>(app,
      `Array.from(document.getElementById('model-select').options).map(option=>option.value)`)).toEqual([''])
    const policyAfterAttempt = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(policyAfterAttempt).toEqual(policy)

    // 只在本测试新建的 E2E 工作区打开 owner 本机 AI；成员自选端点保持关闭。
    // 先改回原值确认未保存的草稿不会写入，再经设置页保存开启状态。
    await electronLocalSettingsWaitIdle(app)
    await selectDesktopSetting(page, '桌面 AI 策略')
    const discardLocalDraft = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discardLocalDraft).toBeVisible()
    await discardLocalDraft.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(page.getByRole('heading', { name: '工作区桌面 AI 策略', exact: true })).toBeVisible()
    await expect(settings.locator('footer')).toHaveText('配置按各项说明保存；独立工具在主窗口打开')
    const workspaceAI = page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })
    const savePolicyButton = page.getByRole('button', { name: '保存工作区策略', exact: true })
    await workspaceAI.click()
    await expect(savePolicyButton).toBeEnabled()
    await workspaceAI.click()
    await expect(savePolicyButton).toBeDisabled()
    const policyBeforeSave = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(policyBeforeSave.policy.enabled).toBe(false)

    const saveWorkspacePolicy = async () => {
      const currentSaveButton = page.getByRole('button', { name: '保存工作区策略', exact: true })
      let saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/desktop/policy') && response.request().method() === 'PUT')
      await currentSaveButton.click()
      let response = await saved
      if (response.status() === 403 && (await response.json()).error?.code === 'reauth_required') {
        const reauth = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认是你本人', exact: true }) })
        await expect(reauth).toBeVisible()
        await reauth.getByPlaceholder('登录密码').fill('local-e2e-password-123')
        saved = page.waitForResponse((item) => item.url().endsWith('/api/v1/desktop/policy') && item.request().method() === 'PUT')
        await reauth.getByRole('button', { name: '确认', exact: true }).click()
        response = await saved
      }
      expect(response.ok(), `保存工作区策略失败：${response.status()}`).toBeTruthy()
      await expect(currentSaveButton).toBeDisabled()
    }

    await workspaceAI.click()
    await saveWorkspacePolicy()
    const enabledPolicy = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(enabledPolicy).toMatchObject({ global_enabled: true, policy: { enabled: true, allow_member_endpoints: false } })
    await expect(workspaceAI).toHaveAttribute('aria-checked', 'true')

    // 仅写入本机临时 profile 和本地 mock manifest；不做自检、连接或模型调用。
    const mockBaseUrl = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'
    const mockHost = new URL(mockBaseUrl).hostname
    expect(['127.0.0.1', 'localhost', '::1']).toContain(mockHost)
    await expect(settings.locator('footer')).toHaveText('配置按各项说明保存；独立工具在主窗口打开')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(settings).toBeHidden()
    await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(page, '本机 AI 配置')
    await electronLocalSettingsWaitPanel(app, 'ai')
    const savedMockModelName = `QA26 本地 mock ${Date.now()}`
    await electronLocalSettingsEvaluate(app,
      `(()=>{const fields={'model-name':${JSON.stringify(savedMockModelName)},'base-url':${JSON.stringify(mockBaseUrl)},'model-names':'mock-writer'};for(const [id,value] of Object.entries(fields)){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))}document.getElementById('save-model').click();return true})()`)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!, `document.getElementById('action-status').textContent`), { timeout: 30_000 })
      .toBe('配置已保存。密钥未返回页面。')
    const localModelBeforeRestart = await electronLocalSettingsEvaluate<{ value: string; label: string }>(app,
      `(()=>{const select=document.getElementById('model-select');const option=select.selectedOptions[0];return {value:select.value,label:option?.textContent??''}})()`)
    expect(localModelBeforeRestart.value).toBeTruthy()
    expect(localModelBeforeRestart.label).toContain(savedMockModelName)

    try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 仅结束本测试的 Electron 进程树。 */ }
    await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: appUrl },
      timeout: 60_000,
    })
    page = await app.firstWindow()
    await page.goto(`${appUrl}/login`)
    await page.getByLabel('用户名', { exact: true }).fill(userName)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await page.goto(`${appUrl}/a/${account.id}`)
    await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(page, '桌面 AI 策略')
    await expect(page.getByRole('heading', { name: '工作区桌面 AI 策略', exact: true })).toBeVisible()
    const policyAfterRestart = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(policyAfterRestart.policy).toMatchObject({ enabled: true, allow_member_endpoints: false })
    await expect(page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })).toHaveAttribute('aria-checked', 'true')

    await page.goto(`${appUrl}/a/${account.id}`)
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(page, '本机 AI 配置')
    await electronLocalSettingsWaitPanel(app, 'ai')
    await electronLocalSettingsEvaluate(app, `document.getElementById('refresh-models').click();true`)
    await expect.poll(() => electronLocalSettingsEvaluate<string>(app!, `document.getElementById('action-status').textContent`))
      .toBe('本机配置已刷新。')
    const localModelsAfterRestart = await electronLocalSettingsEvaluate<Array<{ value: string; label: string }>>(app,
      `Array.from(document.getElementById('model-select').options).map(option=>({value:option.value,label:option.textContent??''}))`)
    expect(localModelsAfterRestart.some((model) => model.value && model.label.includes(savedMockModelName))).toBe(true)

    await selectDesktopSetting(page, '桌面 AI 策略')
    await page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true }).click()
    await saveWorkspacePolicy()
    const restoredPolicy = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(restoredPolicy.policy).toMatchObject({ enabled: false, allow_member_endpoints: false })
  } finally {
    if (app) {
      const page = await app.firstWindow().catch(() => undefined)
      if (page && originalAgentPick !== undefined) {
        await page.evaluate(async (value) => {
          const me = await (await fetch('/api/v1/auth/me')).json() as { csrf_token: string }
          await fetch('/api/v1/agent/settings', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
            body: JSON.stringify({ allow_model_pick: value }),
          })
        }, originalAgentPick).catch(() => undefined)
      }
      if (page && template) {
        await page.evaluate(async (value) => {
          const me = await (await fetch('/api/v1/auth/me')).json() as { csrf_token: string }
          await fetch(`/api/v1/prompt-templates/${encodeURIComponent(value.task_type)}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
            body: JSON.stringify({ content: value.content }),
          })
        }, template).catch(() => undefined)
      }
    }
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 只清理本测试创建的进程。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    expect(profile.startsWith(join(tmpdir(), 'ops-qa26-agent-settings-'))).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7 全局桌面 AI 关闭时策略入口保持禁用', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', 'Windows 客户端验收')
  test.skip(process.env.OPS_DESKTOP_AI_ENABLED !== 'false', '仅在隔离 E2E 服务显式关闭全局桌面 AI 时运行')
  const appUrl = baseURL ?? 'http://127.0.0.1:5287'
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-agent-global-off-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: appUrl },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${appUrl}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-global-off-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await page.goto(`${appUrl}/settings/desktop-ai`)

    const policy = await page.evaluate(async () => (await (await fetch('/api/v1/desktop/policy')).json()) as {
      global_enabled: boolean
      policy: { enabled: boolean; allow_member_endpoints: boolean; authorization_revision: number }
    })
    expect(policy.global_enabled).toBe(false)
    await expect(page.getByText('服务端尚未全局启用桌面 AI；工作区开关当前不会生效。', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })).toBeDisabled()
    await expect(page.getByRole('switch', { name: '允许 editor 使用各自的桌面 AI 端点', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '保存工作区策略', exact: true })).toBeDisabled()

    let policyWrites = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/desktop/policy') && request.method() === 'PUT') policyWrites++
    })
    await page.reload()
    await expect(page.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })).toBeDisabled()
    expect(policyWrites).toBe(0)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 仅结束本测试创建的 Electron 进程树。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
