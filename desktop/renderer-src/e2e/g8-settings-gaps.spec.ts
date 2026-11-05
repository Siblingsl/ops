import { _electron, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, createOutline, finishChecks, openDesktopAccountSwitcher, registerAccount, selectDesktopSetting } from './support'

type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>

type LocalSmtpSink = { port: number; messages: string[]; close: () => Promise<void> }

async function startLocalSmtpSink(rejectGreeting = false): Promise<LocalSmtpSink> {
  const messages: string[] = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 qa26-local-smtp ESMTP\r\n')
    let pending = ''
    let message = ''
    let readingMessage = false
    socket.on('error', () => undefined)
    socket.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const boundary = pending.indexOf('\r\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (readingMessage) {
          if (line === '.') {
            messages.push(message)
            message = ''
            readingMessage = false
            socket.write('250 2.0.0 queued\r\n')
          } else message += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
        } else if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write(rejectGreeting ? '550 qa26 injected SMTP failure\r\n' : '250 qa26-local-smtp\r\n')
        } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) socket.write('250 2.1.0 accepted\r\n')
        else if (/^DATA$/i.test(line)) { readingMessage = true; socket.write('354 end with .\r\n') }
        else if (/^QUIT$/i.test(line)) { socket.write('221 2.0.0 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('SMTP sink did not bind TCP port')); return }
      resolve(address.port)
    })
  })
  return {
    port,
    messages,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function launchElectron(baseURL: string, username: string, tag: string, inviteCode?: string) {
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-' + tag + '-'))
  let app: ElectronApp | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + profile, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(baseURL + '/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    if (inviteCode) await page.getByLabel('邀请码（可选）').fill(inviteCode)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    return { app, page, profile }
  } catch (error) {
    await closeElectron(app, profile, tag)
    throw error
  }
}

async function closeElectron(app: ElectronApp | undefined, profile: string, tag: string) {
  if (app) {
    try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 只关闭本用例启动的客户端。 */ }
    await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
  }
  const resolved = resolve(profile)
  if (!resolved.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g8-' + tag + '-')) {
    throw new Error('拒绝清理测试目录之外路径')
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

async function reloadElectronWindow(app: ElectronApp) {
  await app.evaluate(({ BrowserWindow }) => new Promise<void>((resolve, reject) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) { reject(new Error('Electron 主窗口不存在')); return }
    const timeout = setTimeout(() => reject(new Error('Electron 主窗口重载超时')), 25_000)
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timeout)
      resolve()
    })
    window.webContents.reload()
  }))
}

async function openOwner(page: Page, baseURL: string, tag: string, contentType = '图文笔记') {
  const username = 'qa26-g8-' + tag + '-' + Date.now()
  const account = await registerAccount(page, contentType, 'xhs', username)
  const client = await launchElectron(baseURL, username, tag)
  try {
    await client.page.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem('ops.currentAccount.v2:' + (me.user_id ?? me.username) + ':' + me.workspace.id, accountId)
    }, account.id)
    await client.page.goto(baseURL + '/a/' + account.id)
    await expect(client.page.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()
    await client.page.getByRole('button', { name: /用户菜单/ }).click()
    await client.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    return { ...client, account, username }
  } catch (error) {
    await closeElectron(client.app, client.profile, tag)
    throw error
  }
}

test('DEV-QA26 G1-05 真实 Electron 修改密码拒绝与会话失效', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const owner = await openOwner(page, baseURL!, 'password-change')
  const wrongPasswordSamples: number[] = []
  const nextPassword = 'local-e2e-password-456'
  try {
    await selectDesktopSetting(owner.page, '登录与安全')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const oldPassword = settings.getByLabel('当前密码')
    const newPassword = settings.getByLabel('新密码')
    const confirmPassword = settings.getByLabel('再输入一次')
    const submit = settings.getByRole('button', { name: '修改密码', exact: true })
    await expect(settings.getByRole('heading', { name: '登录与安全', exact: true })).toBeVisible()

    await newPassword.fill(nextPassword)
    await confirmPassword.fill(nextPassword)
    for (let index = 0; index < 20; index += 1) {
      await oldPassword.fill('local-e2e-wrong-password')
      const rejected = owner.page.waitForResponse((response) =>
        response.url().endsWith('/api/v1/auth/password') && response.request().method() === 'PUT')
      const started = performance.now()
      await submit.click()
      const response = await rejected
      wrongPasswordSamples.push(performance.now() - started)
      expect(response.status()).toBe(422)
      await expect(owner.page.getByText(/当前密码不正确/).first()).toBeVisible()
      await expect(submit).toBeEnabled()
    }
    expect((await api(page, 'GET', '/auth/me')).username).toBe(owner.username)

    await oldPassword.fill('local-e2e-password-123')
    const changed = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/password') && response.request().method() === 'PUT')
    await submit.click()
    expect((await changed).status()).toBe(200)
    await expect(owner.page.getByText('密码已修改，其他设备上的登录已失效', { exact: true })).toBeVisible()
    await expect(oldPassword).toHaveValue('')
    await expect(newPassword).toHaveValue('')
    await expect(confirmPassword).toHaveValue('')

    await expect.poll(() => owner.page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => owner.page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await owner.page.getByTestId('desktop-settings-window').getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(owner.page.getByRole('heading', { name: '今天，给灵感一点空间。', exact: true })).toBeVisible()

    await owner.page.route('**/api/v1/auth/me', async (route) => {
      const response = await route.fetch()
      const me = await response.json()
      me.session_expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString()
      await route.fulfill({ response, body: JSON.stringify(me) })
    })
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    const expiryBanner = owner.page.getByRole('status').filter({ hasText: '会话将于' })
    await expect(expiryBanner).toContainText('请先保存内容')
    await expect(expiryBanner.getByRole('button', { name: '立即续期' })).toBeVisible()
    await owner.page.unroute('**/api/v1/auth/me')
    await expiryBanner.getByRole('button', { name: '立即续期' }).click()
    const renewal = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '续期当前会话' }) })
    await renewal.getByPlaceholder('登录密码').fill(nextPassword)
    const renewed = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/renew') && response.request().method() === 'POST')
    await renewal.getByRole('button', { name: '续期 7 天', exact: true }).click()
    expect((await renewed).status()).toBe(200)
    await expect(expiryBanner).toHaveCount(0)
    const session = await owner.page.evaluate(async () => (await fetch('/api/v1/auth/me')).json()) as { session_expires_at: string }
    expect(new Date(session.session_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)

    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(owner.username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const oldLogin = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    expect((await oldLogin).status()).toBe(401)
    await expect(page.getByText(/用户名或密码不正确/)).toBeVisible()

    await page.getByLabel('密码', { exact: true }).fill(nextPassword)
    const newLogin = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    expect((await newLogin).status()).toBe(200)
    await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()

    const sorted = [...wrongPasswordSamples].sort((a, b) => a - b)
    console.log(`G1-05 Electron 20 次旧密码拒绝 p50=${sorted[9].toFixed(2)}ms p95=${sorted[18].toFixed(2)}ms; rejected=20`)
  } finally {
    await closeElectron(owner.app, owner.profile, 'password-change')
  }
})

test('DEV-QA26 G7-09 真实 Electron 本地 mock 用量记录按四组展示', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(240_000)
  const username = 'qa26-g8-usage-data-' + Date.now()
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'DEV-QA26 用量本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
    api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const owner = await launchElectron(baseURL!, username, 'usage-data')
  try {
    await owner.page.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem('ops.currentAccount.v2:' + (me.user_id ?? me.username) + ':' + me.workspace.id, accountId)
    }, account.id)
    await owner.page.goto(baseURL + '/a/' + account.id)
    await owner.page.getByRole('link', { name: 'AI 对话', exact: true }).click()
    await expect(owner.page).toHaveURL(/\/agent$/)
    const privacy = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(privacy).toBeHidden()
    await expect(owner.page.getByRole('textbox', { name: '发送消息' })).toBeEnabled()

    const aiSamples: number[] = []
    let conversationID = ''
    for (let index = 1; index <= 20; index += 1) {
      const reply = `DEV-QA26 用量统计样本 ${String(index).padStart(2, '0')}`
      await owner.page.locator('textarea').fill('#text ' + reply)
      const accepted = owner.page.waitForResponse((response) =>
        new URL(response.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) !== null
        && response.request().method() === 'POST')
      const started = performance.now()
      await owner.page.getByRole('button', { name: '发送', exact: true }).click()
      expect((await accepted).status()).toBe(202)
      await expect(owner.page).toHaveURL(/\/agent\/c\/[a-f0-9-]+$/)
      conversationID = owner.page.url().split('/').pop()!
      await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run, { timeout: 30_000 }).toBeNull()
      const detail = await api(page, 'GET', `/agent/conversations/${conversationID}`) as { conversation: { account_id: string | null }; last_run: { status: string }; messages: Array<{ role: string; content: string }> }
      expect(detail.conversation.account_id).toBe(account.id)
      expect(detail.last_run.status).toBe('completed')
      expect(detail.messages.some((message) => message.role === 'assistant' && message.content === reply)).toBe(true)
      aiSamples.push(performance.now() - started)
    }

    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '完整用量报表')
    await expect(owner.page.getByRole('heading', { name: 'AI 用量', exact: true })).toBeVisible()
    const groups = [
      { key: 'day', label: '按天' }, { key: 'task', label: '按任务' },
      { key: 'model', label: '按模型' }, { key: 'account', label: '按账号' },
    ]
    const groupKeys = new Map<string, string>()
    for (const group of groups) {
      const report = await api(page, 'GET', `/usage?group_by=${group.key}`) as { group_by: string; from: string; to: string; rows: Array<{ key: string; calls: number; prompt_tokens: number; completion_tokens: number }>; total: { calls: number; failed: number } }
      await expect(owner.page.locator('input[type="date"]').nth(0)).toHaveValue(report.from)
      await expect(owner.page.locator('input[type="date"]').nth(1)).toHaveValue(report.to)
      expect(report.group_by).toBe(group.key)
      expect(report.total).toMatchObject({ calls: 20, failed: 0 })
      expect(report.rows.length).toBeGreaterThan(0)
      expect(report.rows.reduce((sum, row) => sum + row.calls, 0)).toBe(20)
      expect(report.total.calls).toBe(20)
      expect(report.rows.every((row) => row.prompt_tokens + row.completion_tokens > 0)).toBe(true)
      const expectedKey = group.key === 'task' ? '智能体对话'
        : group.key === 'model' ? 'DEV-QA26 用量本地 mock / mock-agent-tested'
          : group.key === 'account' ? '浏览器验收号' : report.rows[0].key
      expect(report.rows.some((row) => row.key === expectedKey)).toBe(true)
      groupKeys.set(group.key, expectedKey)
    }

    const interactions: number[] = []
    const table = owner.page.getByRole('table')
    for (let index = 0; index < 20; index += 1) {
      const group = groups[index % groups.length]
      const started = performance.now()
      await owner.page.getByRole('button', { name: group.label, exact: true }).click()
      await expect(table.getByText(groupKeys.get(group.key)!, { exact: true })).toBeVisible()
      interactions.push(performance.now() - started)
    }
    const percentile = (values: number[], ratio: number) => {
      const sorted = [...values].sort((a, b) => a - b)
      return Number(sorted[Math.ceil(sorted.length * ratio) - 1].toFixed(2))
    }
    console.log(`DEV-QA26_USAGE_DATA Electron ${JSON.stringify({ ai_samples: 20, ai_p50_ms: percentile(aiSamples, 0.5), ai_p95_ms: percentile(aiSamples, 0.95), group_clicks: 20, click_p50_ms: percentile(interactions, 0.5), click_p95_ms: percentile(interactions, 0.95), totals: 20, groups: [...groupKeys.keys()], model: 'local mock; no quality claim' })}`)
  } finally {
    await closeElectron(owner.app, owner.profile, 'usage-data')
  }
})

test('DEV-QA26 G8 真实 Electron 模型删除取消与空态读回', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(150_000)
  const owner = await openOwner(page, baseURL!, 'models')
  try {
    await selectDesktopSetting(owner.page, '服务器模型')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const providers = await api(page, 'GET', '/model-providers') as Array<{ id: string; name: string }>
    expect(providers.length).toBeGreaterThan(0)
    const provider = providers[0]
    const card = settings.locator('div.group.p-5').filter({ hasText: provider.name })
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: '删除', exact: true }).click()
    let confirm = owner.page.getByRole('dialog').filter({ hasText: '删除「' + provider.name + '」？' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    const secondGate = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '仍要删除？', exact: true }) })
    await expect(secondGate).toBeVisible()
    await secondGate.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/model-providers')).some((item: { id: string }) => item.id === provider.id)).toBe(true)

    await card.getByRole('button', { name: '删除', exact: true }).click()
    confirm = owner.page.getByRole('dialog').filter({ hasText: '删除「' + provider.name + '」？' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    const finalGate = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '仍要删除？', exact: true }) })
    const removed = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/model-providers/' + provider.id)
      && response.request().method() === 'DELETE'
      && response.request().postData()?.includes('true'))
    await finalGate.getByRole('button', { name: '删除', exact: true }).click()
    expect((await removed).ok()).toBe(true)
    await expect(settings.getByText('还没有配置模型', { exact: true })).toBeVisible()
    expect(await api(page, 'GET', '/model-providers')).toEqual([])
    await owner.page.reload()
    await selectDesktopSetting(owner.page, '服务器模型')
    const emptySettings = owner.page.getByTestId('desktop-settings-window')
    await expect(emptySettings.getByText('还没有配置模型', { exact: true })).toBeVisible()
    await emptySettings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await owner.page.getByRole('link', { name: 'AI 对话', exact: true }).click()
    await expect(owner.page.getByText(/还没有配置可用于对话的模型/)).toBeVisible()
    await expect(owner.page.getByRole('link', { name: '去模型配置', exact: true })).toBeVisible()
    await expect(owner.page.getByPlaceholder('请先配置支持工具调用的模型')).toBeDisabled()
    await expect(owner.page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(owner.page.getByRole('button', { name: '添加附件', exact: true })).toBeDisabled()
    const privacy = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await owner.page.getByRole('link', { name: '工作台', exact: true }).click()
    await expect(owner.page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
  } finally {
    await closeElectron(owner.app, owner.profile, 'models')
  }
})
test('DEV-QA26 G8 真实 Electron 编辑者邀请、角色、撤销与权限边界', async ({ page, browser, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(210_000)
  const owner = await openOwner(page, baseURL!, 'members')
  let memberContext: BrowserContext | undefined
  let editorApp: ElectronApp | undefined
  let editorProfile = ''
  try {
    await selectDesktopSetting(owner.page, '成员与邀请')
    const settings = owner.page.getByTestId('desktop-settings-window')
    await settings.getByRole('combobox').last().selectOption('editor')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { id: string; code: string; role: string }
    expect(invite.role).toBe('editor')
    await expect(settings.getByText(invite.code, { exact: true })).toBeVisible()

    const editorUsername = 'qa26-g8-editor-' + Date.now()
    memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    const joined = await memberContext.request.post('/api/v1/auth/register', {
      data: { username: editorUsername, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok(), '通过 UI 生成的邀请码注册编辑者').toBeTruthy()
    const joinedMe = await (await memberContext.request.get('/api/v1/auth/me')).json() as { user_id: string }
    expect((await api(page, 'GET', '/workspaces/current/members')).some((member: { user_id: string }) => member.user_id === joinedMe.user_id)).toBe(true)

    const editor = await launchElectron(baseURL!, editorUsername, 'editor', invite.code)
    editorApp = editor.app
    editorProfile = editor.profile
    await editor.page.goto(baseURL + '/settings/members')
    const editorSettings = editor.page.getByTestId('desktop-settings-window')
    await expect(editorSettings.getByText('只有工作区所有者可以生成邀请码、管理成员与模型/凭证。', { exact: true })).toBeVisible()
    await expect(editorSettings.getByRole('button', { name: '生成邀请码', exact: true })).toHaveCount(0)
    await selectDesktopSetting(editor.page, '服务器模型')
    await expect(editorSettings.getByText('你是编辑者，可查看模型配置，但不能修改密钥或路由。', { exact: true })).toBeVisible()
    await expect(editorSettings.getByRole('button', { name: '手动添加', exact: true })).toHaveCount(0)
    await expect(editorSettings.getByRole('button', { name: '快速配置', exact: true })).toHaveCount(0)
    const denied = await editor.page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const requests = [
        fetch('/api/v1/workspaces/current/invites', { method: 'POST', headers, body: JSON.stringify({ role: 'editor', max_uses: 1, days: 1 }) }),
        fetch('/api/v1/model-providers', { method: 'POST', headers, body: JSON.stringify({ name: '仅本地权限测试', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-only', models: ['mock-writer'] }) }),
        fetch('/api/v1/model-routes', { method: 'PUT', headers, body: JSON.stringify([]) }),
        fetch('/api/v1/workspaces/current/members/' + me.user_id, { method: 'PATCH', headers, body: JSON.stringify({ role: 'viewer' }) }),
      ]
      return Promise.all(requests.map(async (request) => (await request).status))
    })
    expect(denied).toEqual([403, 403, 403, 403])

    await owner.page.reload()
    await selectDesktopSetting(owner.page, '成员与邀请')
    const memberRow = settings.locator('li').filter({ hasText: editorUsername })
    await expect(memberRow).toBeVisible()
    const roleSelect = memberRow.getByRole('combobox')
    await roleSelect.selectOption('viewer')
    await expect.poll(async () => {
      const members = await api(page, 'GET', '/workspaces/current/members')
      return members.find((member: { user_id: string }) => member.user_id === joinedMe.user_id)?.role
    }).toBe('viewer')
    await roleSelect.selectOption('editor')
    await expect.poll(async () => {
      const members = await api(page, 'GET', '/workspaces/current/members')
      return members.find((member: { user_id: string }) => member.user_id === joinedMe.user_id)?.role
    }).toBe('editor')

    const inviteCard = settings.locator('li').filter({ hasText: invite.code })
    const revoke = owner.page.waitForResponse((response) =>
      response.url().endsWith('/workspaces/current/invites/' + invite.id + '/revoke') && response.request().method() === 'POST')
    await inviteCard.getByRole('button', { name: '撤销', exact: true }).click()
    expect((await revoke).ok()).toBe(true)
    expect((await api(page, 'GET', '/workspaces/current/invites')).some((item: { id: string }) => item.id === invite.id)).toBe(false)

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const removeDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '移出 ' + editorUsername + '？', exact: true }) })
    await removeDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === joinedMe.user_id)).toBe(true)
    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const finalRemove = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '移出 ' + editorUsername + '？', exact: true }) })
    const removeResponse = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/workspaces/current/members/' + joinedMe.user_id)
      && response.request().method() === 'PATCH')
    await finalRemove.getByRole('button', { name: '确定', exact: true }).click()
    expect((await removeResponse).ok()).toBe(true)
    expect((await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === joinedMe.user_id)).toBe(false)
  } finally {
    if (editorApp) await closeElectron(editorApp, editorProfile, 'editor')
    await memberContext?.close()
    await closeElectron(owner.app, owner.profile, 'members')
  }
})

test('DEV-QA26 G8 邮箱邀请无 SMTP 时只记录且拒绝无效地址', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(120_000)
  const owner = await openOwner(page, baseURL!, 'email-invite')
  try {
    await selectDesktopSetting(owner.page, '成员与邀请')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const config = await api(page, 'GET', '/settings') as { smtp: { host: string; from: string } }
    expect(config.smtp.host).toBe('')
    expect(config.smtp.from).toBe('')

    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { id: string; code: string }
    const inviteCard = settings.locator('li').filter({ hasText: invite.code })
    const email = inviteCard.getByPlaceholder('收件邮箱')
    const send = inviteCard.getByRole('button', { name: '发送邮件', exact: true })

    await send.click()
    await expect(owner.page.getByText('请填写收件邮箱', { exact: true })).toBeVisible()
    await email.fill('not-an-email')
    const invalidToast = expect(owner.page.getByText(/请填写有效邮箱/)).toBeVisible()
    const invalidResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
    await send.click()
    expect((await invalidResponse).status()).toBe(422)
    await invalidToast

    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const recipient = `qa26-no-send-${i}@example.invalid`
      await email.fill(recipient)
      const successToast = i === 0
        ? expect(owner.page.getByText('开发模式已记录邀请（未配置 SMTP，未真实发信）', { exact: true })).toBeVisible()
        : undefined
      const started = performance.now()
      const sentResponse = owner.page.waitForResponse((response) =>
        response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
      await send.click()
      const response = await sentResponse
      samples.push(performance.now() - started)
      expect(response.status()).toBe(200)
      const result = await response.json() as { status: string; message: string }
      expect(result.status).toBe('dev_logged')
      expect(result.message).toContain('未真实发信')
      if (successToast) await successToast
      await expect(email).toHaveValue('')
    }
    const sortedSamples = [...samples].sort((a, b) => a - b)
    const p50 = sortedSamples[Math.ceil(0.50 * sortedSamples.length) - 1]
    const p95 = sortedSamples[Math.ceil(0.95 * sortedSamples.length) - 1]
    console.log('[QA26 email invite click samples] ' + JSON.stringify({ p50_ms: Number(p50.toFixed(2)), p95_ms: Number(p95.toFixed(2)) }))

    const logs = await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string; detail: { to: string; status: string } }>
    const recorded = logs.filter((entry) => entry.target_id === invite.id)
    expect(recorded).toHaveLength(20)
    expect(recorded.every((entry) => entry.result === 'ok' && entry.detail.status === 'dev_logged' && entry.detail.to.endsWith('@example.invalid'))).toBe(true)

    await owner.page.reload()
    await selectDesktopSetting(owner.page, '成员与邀请')
    await expect(owner.page.getByText(invite.code, { exact: true })).toBeVisible()
    await expect(owner.page.getByPlaceholder('收件邮箱')).toHaveValue('')
    expect((await api(page, 'GET', '/workspaces/current/invites')).some((entry: { id: string }) => entry.id === invite.id)).toBe(true)
  } finally {
    await closeElectron(owner.app, owner.profile, 'email-invite')
  }
})

test('DEV-QA26 G2-04 真实 Electron 本机 SMTP sink 投递邀请与失败恢复', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const sinks: LocalSmtpSink[] = []
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined
  try {
    const smtp = await startLocalSmtpSink()
    sinks.push(smtp)
    const rejectingSmtp = await startLocalSmtpSink(true)
    sinks.push(rejectingSmtp)
    owner = await openOwner(page, baseURL!, 'smtp-local')

    await selectDesktopSetting(owner.page, '成员与邀请')
    let settings = owner.page.getByTestId('desktop-settings-window')
    await expect(settings.getByText('还没有有效邀请码', { exact: true })).toBeVisible()
    const emptyConfig = await api(page, 'GET', '/settings') as { smtp: { host: string; from: string; has_password: boolean; password?: string } }
    expect(emptyConfig.smtp).toMatchObject({ host: '', from: '', has_password: false })
    expect(emptyConfig.smtp).not.toHaveProperty('password')
    await settings.getByRole('combobox').last().selectOption('editor')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { id: string; code: string; role: string }
    expect(invite.role).toBe('editor')
    const inviteCard = settings.locator('li').filter({ hasText: invite.code })
    const email = inviteCard.getByPlaceholder('收件邮箱')
    const send = inviteCard.getByRole('button', { name: '发送邮件', exact: true })

    await selectDesktopSetting(owner.page, '邀请邮件')
    settings = owner.page.getByTestId('desktop-settings-window')
    const smtpHost = settings.getByLabel('SMTP 主机')
    const smtpPort = settings.getByLabel('端口')
    const smtpFrom = settings.getByLabel('发件人 From')
    await smtpHost.fill('127.0.0.1')
    await smtpPort.fill(String(rejectingSmtp.port))
    await smtpFrom.fill('qa26-sender@example.invalid')
    const saveRejectedConfig = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT')
    await settings.getByRole('button', { name: '保存 SMTP', exact: true }).click()
    expect((await saveRejectedConfig).status()).toBe(200)
    await expect(settings.locator('.desktop-settings-footer')).toContainText('配置按各项说明保存')
    expect((await api(page, 'GET', '/settings')).smtp.port).toBe(rejectingSmtp.port)

    await selectDesktopSetting(owner.page, '成员与邀请')
    settings = owner.page.getByTestId('desktop-settings-window')
    const failingCard = settings.locator('li').filter({ hasText: invite.code })
    const failingEmail = failingCard.getByPlaceholder('收件邮箱')
    await failingEmail.fill('qa26-failure@example.invalid')
    const failedSend = owner.page.waitForResponse((response) =>
      response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
    await failingCard.getByRole('button', { name: '发送邮件', exact: true }).click()
    expect((await failedSend).status()).toBe(502)
    await expect(owner.page.getByText(/邮件发送失败/)).toBeVisible()
    await expect(failingEmail).toHaveValue('qa26-failure@example.invalid')
    const failedLog = (await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string }>).find((entry) => entry.target_id === invite.id)
    expect(failedLog?.result).toBe('failed')

    await selectDesktopSetting(owner.page, '邀请邮件')
    let discardEmail = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discardEmail).toBeVisible()
    await discardEmail.getByRole('button', { name: '取消', exact: true }).click()
    await expect(settings.getByRole('heading', { name: '成员与邀请', exact: true })).toBeVisible()
    await expect(failingEmail).toHaveValue('qa26-failure@example.invalid')
    expect((await api(page, 'GET', '/settings')).smtp.port).toBe(rejectingSmtp.port)

    await selectDesktopSetting(owner.page, '邀请邮件')
    discardEmail = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discardEmail).toBeVisible()
    await discardEmail.getByRole('button', { name: '放弃修改', exact: true }).click()
    settings = owner.page.getByTestId('desktop-settings-window')
    await settings.getByLabel('SMTP 主机').fill('127.0.0.1')
    await settings.getByLabel('端口').fill(String(smtp.port))
    await settings.getByLabel('发件人 From').fill('qa26-sender@example.invalid')
    const saveWorkingConfig = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT')
    await settings.getByRole('button', { name: '保存 SMTP', exact: true }).click()
    expect((await saveWorkingConfig).status()).toBe(200)
    await expect(settings.locator('.desktop-settings-footer')).toContainText('配置按各项说明保存')
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await selectDesktopSetting(owner.page, '邀请邮件')
    settings = owner.page.getByTestId('desktop-settings-window')
    await expect(settings.getByLabel('SMTP 主机')).toHaveValue('127.0.0.1')
    await expect(settings.getByLabel('端口')).toHaveValue(String(smtp.port))
    await expect(settings.getByLabel('发件人 From')).toHaveValue('qa26-sender@example.invalid')
    const persistedConfig = await api(page, 'GET', '/settings') as { smtp: { host: string; port: number; from: string; has_password: boolean; password?: string } }
    expect(persistedConfig.smtp).toMatchObject({ host: '127.0.0.1', port: smtp.port, from: 'qa26-sender@example.invalid', has_password: false })
    expect(persistedConfig.smtp).not.toHaveProperty('password')

    await settings.getByLabel('发件人 From').fill('discard@example.invalid')
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
    const discard = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: '取消', exact: true }).click()
    await expect(settings.getByLabel('发件人 From')).toHaveValue('discard@example.invalid')
    expect((await api(page, 'GET', '/settings')).smtp.from).toBe('qa26-sender@example.invalid')
    await settings.getByLabel('发件人 From').fill('qa26-sender@example.invalid')

    await selectDesktopSetting(owner.page, '成员与邀请')
    settings = owner.page.getByTestId('desktop-settings-window')
    const messageCard = settings.locator('li').filter({ hasText: invite.code })
    const messageEmail = messageCard.getByPlaceholder('收件邮箱')
    const clickSamples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const recipient = `qa26-local-${index}@example.invalid`
      await messageEmail.fill(recipient)
      const sent = owner.page.waitForResponse((response) =>
        response.url().endsWith('/invites/' + invite.id + '/send-email') && response.request().method() === 'POST')
      const started = performance.now()
      await messageCard.getByRole('button', { name: '发送邮件', exact: true }).click()
      const response = await sent
      clickSamples.push(performance.now() - started)
      expect(response.status()).toBe(200)
      expect((await response.json()).status).toBe('sent')
      expect(smtp.messages).toHaveLength(index + 1)
      await expect(messageEmail).toHaveValue('')
    }
    for (const [index, message] of smtp.messages.entries()) {
      expect(message).toContain(`To: qa26-local-${index}@example.invalid`)
      expect(message).toContain(`邀请码：${invite.code}`)
      expect(message).toContain('编辑者')
    }
    const sortedSamples = [...clickSamples].sort((a, b) => a - b)
    const percentile = (p: number) => sortedSamples[Math.ceil(p * sortedSamples.length) - 1]
    console.log('[QA26 local SMTP Electron click samples] ' + JSON.stringify({
      count: clickSamples.length,
      p50_ms: Number(percentile(0.5).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      failures: 0,
    }))
    const inviteLogs = (await api(page, 'GET', '/audit-logs?action=invite_email&limit=200') as Array<{ target_id: string; result: string; detail: { status: string } }>).filter((entry) => entry.target_id === invite.id)
    expect(inviteLogs).toHaveLength(21)
    expect(inviteLogs.filter((entry) => entry.result === 'ok' && entry.detail.status === 'sent')).toHaveLength(20)
    expect(inviteLogs.filter((entry) => entry.result === 'failed')).toHaveLength(1)

    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await selectDesktopSetting(owner.page, '成员与邀请')
    settings = owner.page.getByTestId('desktop-settings-window')
    await expect(settings.getByText(invite.code, { exact: true })).toBeVisible()
    await expect(settings.getByPlaceholder('收件邮箱')).toHaveValue('')
    expect((await api(page, 'GET', '/workspaces/current/invites')).some((entry: { id: string }) => entry.id === invite.id)).toBe(true)
  } finally {
    if (owner) await closeElectron(owner.app, owner.profile, 'smtp-local')
    await Promise.allSettled(sinks.map((sink) => sink.close()))
  }
})

test('DEV-QA26 G8 真实 Electron 回收站彻底删除取消与确认', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(150_000)
  const owner = await openOwner(page, baseURL!, 'trash')
  try {
    await selectDesktopSetting(owner.page, '敏感词库')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const word = 'qa26-trash-' + Date.now()
    await settings.getByLabel(/^敏感词/).fill(word)
    const created = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/sensitive-words') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '添加', exact: true }).click()
    expect((await created).ok()).toBe(true)
    const activeWords = await api(page, 'GET', '/sensitive-words') as Array<{ id: string; word: string }>
    const createdWord = activeWords.find((item) => item.word === word)
    expect(createdWord).toBeTruthy()
    const chip = settings.getByText(word, { exact: true }).locator('xpath=..')
    const softDelete = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/sensitive-words/' + createdWord!.id)
      && response.request().method() === 'DELETE')
    await chip.getByRole('button', { name: '删除', exact: true }).click()
    expect((await softDelete).ok()).toBe(true)
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
    expect((await api(page, 'GET', '/trash')).some((item: { id: string; type: string }) => item.id === createdWord!.id && item.type === 'sensitive_word')).toBe(true)

    await selectDesktopSetting(owner.page, '回收站')
    await expect(owner.page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible()
    const trashRow = owner.page.locator('li').filter({ hasText: word })
    await trashRow.getByRole('button', { name: '彻底删除', exact: true }).click()
    const cancelDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/trash')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(true)

    await trashRow.getByRole('button', { name: '彻底删除', exact: true }).click()
    const confirmDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    const purge = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/trash/sensitive_word/' + createdWord!.id)
      && new URL(response.url()).searchParams.get('confirm') === 'true'
      && response.request().method() === 'DELETE')
    await confirmDialog.getByRole('button', { name: '彻底删除', exact: true }).click()
    expect((await purge).ok()).toBe(true)
    await expect.poll(async () => (await api(page, 'GET', '/trash')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === createdWord!.id)).toBe(false)
  } finally {
    await closeElectron(owner.app, owner.profile, 'trash')
  }
})

test('DEV-QA26 G8 回收站 viewer 不能恢复或彻底删除作品', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(210_000)
  const owner = await openOwner(page, baseURL!, 'trash-role')
  let viewerApp: ElectronApp | undefined
  let viewerProfile = ''
  try {
    const title = `QA26 回收站权限作品 ${Date.now()}`
    const work = await api(page, 'POST', `/accounts/${owner.account.id}/works`, { title }) as { id: string }
    await owner.page.goto(`${baseURL}/a/${owner.account.id}/works`)
    const ownerRow = owner.page.getByTestId('desktop-work-row').filter({ hasText: title })
    await expect(ownerRow).toBeVisible()
    const softDelete = owner.page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'DELETE')
    await ownerRow.getByRole('button', { name: '删除', exact: true }).click()
    expect((await softDelete).ok()).toBe(true)
    expect((await api(page, 'GET', '/trash?type=work') as Array<{ id: string }>).some((item) => item.id === work.id)).toBe(true)

    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '回收站')
    const trashRow = owner.page.locator('li').filter({ hasText: title })
    await expect(trashRow).toBeVisible()
    const restored = owner.page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/trash/work/${work.id}/restore`) && response.request().method() === 'POST')
    await trashRow.getByRole('button', { name: '恢复', exact: true }).click()
    expect((await restored).ok()).toBe(true)
    expect((await api(page, 'GET', `/works/${work.id}`) as { title: string }).title).toBe(title)
    expect((await api(page, 'GET', '/trash?type=work') as Array<{ id: string }>).some((item) => item.id === work.id)).toBe(false)

    await owner.page.goto(`${baseURL}/a/${owner.account.id}/works`)
    const restoredRow = owner.page.getByTestId('desktop-work-row').filter({ hasText: title })
    const softDeleteAgain = owner.page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'DELETE')
    await restoredRow.getByRole('button', { name: '删除', exact: true }).click()
    expect((await softDeleteAgain).ok()).toBe(true)

    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '成员与邀请')
    const members = owner.page.getByTestId('desktop-settings-window')
    await members.getByRole('combobox').last().selectOption('viewer')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await members.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { code: string }
    const viewerUsername = `qa26-g8-trash-viewer-${Date.now()}`
    viewerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-trash-viewer-'))
    viewerApp = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + viewerProfile, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const viewerPage = await viewerApp.firstWindow()
    await viewerPage.goto(baseURL + '/register')
    await viewerPage.getByLabel('用户名', { exact: true }).fill(viewerUsername)
    await viewerPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await viewerPage.getByLabel('邀请码（可选）').fill(invite.code)
    await viewerPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => viewerPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const ownerWorkspace = (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace
    const viewerMe = await viewerPage.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json())) as { user_id: string; workspace: { id: string }; role: string; csrf_token: string }
    expect(viewerMe.workspace.id).toBe(ownerWorkspace.id)
    expect(viewerMe.role).toBe('viewer')
    await viewerPage.evaluate(({ userId, workspaceId, accountId }) => {
      localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, accountId)
    }, { userId: viewerMe.user_id, workspaceId: viewerMe.workspace.id, accountId: owner.account.id })
    await viewerPage.goto(`${baseURL}/a/${owner.account.id}`)
    await viewerPage.getByRole('button', { name: /用户菜单/ }).click()
    await viewerPage.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(viewerPage, '回收站')

    const viewerTrashRow = viewerPage.locator('li').filter({ hasText: title })
    await expect(viewerTrashRow).toBeVisible()
    const allTab = viewerPage.getByRole('button', { name: /^全部/ })
    const workTab = viewerPage.getByRole('button', { name: /^作品/ })
    const tabSamples: number[] = []
    for (let i = 0; i < 20; i++) {
      const target = i % 2 === 0 ? workTab : allTab
      const started = performance.now()
      await target.click()
      await expect(target).toHaveClass(/bg-white/)
      await expect(viewerTrashRow).toBeVisible()
      tabSamples.push(performance.now() - started)
    }
    const sortedTabSamples = [...tabSamples].sort((a, b) => a - b)
    const tabMetrics = { environment: 'Windows Electron', samples_ms: tabSamples.map((sample) => Number(sample.toFixed(2))), p50_ms: Number(sortedTabSamples[9].toFixed(2)), p95_ms: Number(sortedTabSamples[18].toFixed(2)), failures: 0 }
    await test.info().attach('trash-viewer-tab-click-metrics', { body: Buffer.from(JSON.stringify(tabMetrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 trash viewer tab clicks n=20 p50=${tabMetrics.p50_ms}ms p95=${tabMetrics.p95_ms}ms failures=0 environment=Windows Electron`)
    await expect(viewerTrashRow.getByRole('button', { name: '恢复', exact: true })).toHaveCount(0)
    await expect(viewerTrashRow.getByRole('button', { name: '恢复并查看', exact: true })).toHaveCount(0)
    await expect(viewerTrashRow.getByRole('button', { name: '彻底删除', exact: true })).toHaveCount(0)
    const writeStatuses = await viewerPage.evaluate(async ({ id, csrfToken }) => {
      const headers = { 'X-CSRF-Token': csrfToken }
      const [restore, purge] = await Promise.all([
        fetch(`/api/v1/trash/work/${id}/restore`, { method: 'POST', headers }),
        fetch(`/api/v1/trash/work/${id}?confirm=true`, { method: 'DELETE', headers }),
      ])
      return [restore.status, purge.status]
    }, { id: work.id, csrfToken: viewerMe.csrf_token })
    expect(writeStatuses).toEqual([403, 403])
    expect((await api(page, 'GET', '/trash?type=work') as Array<{ id: string }>).some((item) => item.id === work.id)).toBe(true)
  } finally {
    if (viewerApp) await closeElectron(viewerApp, viewerProfile, 'trash-viewer')
    await closeElectron(owner.app, owner.profile, 'trash-role')
  }
})

test('DEV-QA26 G2-13 真实 Electron 回收站逐项验收选题素材样本角色参考', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const owner = await openOwner(page, baseURL!, 'trash-types', '漫画')
  type TrashItem = { id: string; type: string; title: string }
  const stamp = Date.now()
  const accountId = owner.account.id
  const titles = {
    topic: `QA26 回收站选题 ${stamp}`,
    material: `QA26 回收站素材 ${stamp}`,
    sample: `QA26 回收站样本 ${stamp}`,
    character: `QA26 回收站角色 ${stamp}`,
  }
  const materialContent = `只用于 DEV-QA26 本地回收站验收的素材 ${stamp}`
  const sampleBody = `只用于 DEV-QA26 本地回收站验收的风格样本正文 ${stamp}，不引用任何外部内容。`
  const referenceURL = `https://www.xiaohongshu.com/explore/qa26-trash-${stamp}`
  const trashTypes = [
    { type: 'topic', tab: '选题', title: titles.topic, route: `/a/${accountId}/topics` },
    { type: 'material', tab: '素材', title: materialContent, route: `/a/${accountId}/materials` },
    { type: 'style_sample', tab: '风格样本', title: titles.sample, route: `/a/${accountId}/profile?tab=samples` },
    { type: 'character_card', tab: '角色卡', title: titles.character, route: `/a/${accountId}/profile?tab=characters` },
    { type: 'reference', tab: '对标参考', title: referenceURL, sourceTitle: referenceURL, route: `/a/${accountId}/ops` },
  ]
  const getTrash = async () => await api(page, 'GET', '/trash') as TrashItem[]
  const findTrash = async (type: string, title: string) => {
    const found = (await getTrash()).find((item) => item.type === type && item.title === title)
    expect(found, `${type} ${title} 应在服务端回收站中`).toBeTruthy()
    return found!
  }
  const closeSettings = async () => {
    const settings = owner.page.getByTestId('desktop-settings-window')
    if (await settings.isVisible().catch(() => false)) await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  }
  const openTrash = async () => {
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '回收站')
    await expect(owner.page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible()
  }
  const deleteFromSource = async (item: typeof trashTypes[number]) => {
    await owner.page.goto(baseURL + item.route)
    if (item.type === 'topic') {
      const row = owner.page.getByTestId('desktop-topic-row').filter({ hasText: item.title })
      await expect(row).toBeVisible()
      const deleted = owner.page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/topics/') && response.request().method() === 'DELETE')
      await row.getByRole('button', { name: '更多', exact: true }).click()
      await row.getByRole('button', { name: '删除', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else if (item.type === 'material') {
      await expect(owner.page.getByTestId('desktop-material-details')).toBeVisible()
      await owner.page.getByText(materialContent, { exact: false }).first().click()
      const deleted = owner.page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/materials/') && response.request().method() === 'DELETE')
      await owner.page.getByTestId('desktop-material-details').getByRole('button', { name: '删除这条素材', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else if (item.type === 'style_sample' || item.type === 'character_card') {
      const row = owner.page.locator('li').filter({ hasText: item.title })
      await expect(row).toBeVisible()
      const deleted = owner.page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes(item.type === 'style_sample' ? '/api/v1/style-samples/' : '/api/v1/characters/') && response.request().method() === 'DELETE')
      await row.getByRole('button', { name: '删除', exact: true }).click()
      const dialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: `删除「${item.title}」？`, exact: true }) })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    } else {
      await owner.page.getByRole('tab', { name: '对标参考', exact: true }).click()
      const refLink = owner.page.locator(`a[href="${item.sourceTitle || item.title}"]`)
      await expect(refLink).toBeVisible()
      const card = refLink.locator('xpath=..')
      const deleted = owner.page.waitForResponse((response) =>
        new URL(response.url()).pathname.includes('/api/v1/references/') && response.request().method() === 'DELETE')
      await card.getByRole('button', { name: '移入回收站', exact: true }).click()
      expect((await deleted).ok()).toBe(true)
    }
    await expect.poll(async () => (await getTrash()).some((entry) => entry.type === item.type && entry.title === item.title)).toBe(true)
  }
  const restoreFromTrash = async (item: TrashItem) => {
    const tabName = trashTypes.find((candidate) => candidate.type === item.type)!.tab
    await owner.page.getByRole('button', { name: new RegExp(`^${tabName}`) }).click()
    const row = owner.page.locator('li').filter({ hasText: item.title })
    await expect(row).toBeVisible()
    const restored = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/trash/${item.type}/${item.id}/restore`) && response.request().method() === 'POST')
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    expect((await restored).ok()).toBe(true)
    await expect.poll(async () => (await getTrash()).some((entry) => entry.id === item.id)).toBe(false)
  }
  const purgeWithCancelAndConfirm = async (item: TrashItem) => {
    const tabName = trashTypes.find((candidate) => candidate.type === item.type)!.tab
    await owner.page.getByRole('button', { name: new RegExp(`^${tabName}`) }).click()
    const row = owner.page.locator('li').filter({ hasText: item.title })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '彻底删除', exact: true }).click()
    const cancelDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await getTrash()).some((entry) => entry.id === item.id)).toBe(true)

    await row.getByRole('button', { name: '彻底删除', exact: true }).click()
    const confirmDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '彻底删除？', exact: true }) })
    const purged = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/trash/${item.type}/${item.id}`)
      && new URL(response.url()).searchParams.get('confirm') === 'true'
      && response.request().method() === 'DELETE')
    await confirmDialog.getByRole('button', { name: '彻底删除', exact: true }).click()
    expect((await purged).ok()).toBe(true)
    await expect.poll(async () => (await getTrash()).some((entry) => entry.id === item.id)).toBe(false)
  }

  try {
    await api(page, 'POST', `/accounts/${accountId}/topics`, { title: titles.topic, angle: 'DEV-QA26 隔离测试选题' })
    await api(page, 'POST', '/materials', { account_id: accountId, kind: 'experience', content: materialContent, source: 'DEV-QA26 本地验收', tags: [] })
    await api(page, 'POST', `/accounts/${accountId}/style-samples`, { title: titles.sample, content_md: sampleBody })
    await api(page, 'POST', `/accounts/${accountId}/characters`, { name: titles.character, appearance: '测试角色', personality: '只用于本地验收', catchphrase: 'DEV-QA26' })
    await closeSettings()
    await owner.page.goto(baseURL + `/a/${accountId}/ops`)
    await owner.page.getByRole('tab', { name: '对标参考', exact: true }).click()
    await owner.page.getByLabel('单篇链接（每行一条，最多 20 条）').fill(referenceURL)
    const referenceAdded = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/api/v1/accounts/${accountId}/references`) && response.request().method() === 'POST')
    await owner.page.getByRole('button', { name: '添加参考链接', exact: true }).click()
    expect((await referenceAdded).ok()).toBe(true)
    await expect(owner.page.locator(`a[href="${referenceURL}"]`)).toBeVisible()

    for (const item of trashTypes) await deleteFromSource(item)
    const items = await Promise.all(trashTypes.map((item) => findTrash(item.type, item.title)))

    await openTrash()
    const filterSamples: number[] = []
    for (let i = 0; i < 20; i++) {
      const item = trashTypes[i % trashTypes.length]
      const tab = owner.page.getByRole('button', { name: new RegExp(`^${item.tab}`) })
      const started = Date.now()
      await tab.click()
      await expect(tab).toHaveClass(/bg-white/)
      await expect(owner.page.locator('li').filter({ hasText: item.title })).toBeVisible()
      filterSamples.push(Date.now() - started)
    }
    const sorted = [...filterSamples].sort((a, b) => a - b)
    const metrics = {
      environment: 'Windows Electron', samples_ms: filterSamples,
      p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], failures: 0,
    }
    await test.info().attach('trash-object-type-filter-metrics', { body: Buffer.from(JSON.stringify(metrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 trash object filters n=20 p50=${metrics.p50_ms}ms p95=${metrics.p95_ms}ms failures=0 environment=Windows Electron`)

    for (const item of items) await restoreFromTrash(item)
    await owner.page.reload()
    await openTrash()
    for (const item of trashTypes) {
      await owner.page.getByRole('button', { name: new RegExp(`^${item.tab}`) }).click()
      await expect(owner.page.getByText('回收站是空的', { exact: true })).toBeVisible()
    }
    const recovered = await getTrash()
    expect(recovered.some((entry) => items.some((item) => item.id === entry.id))).toBe(false)

    await closeSettings()
    for (const item of trashTypes) await deleteFromSource(item)
    const secondPass = await Promise.all(trashTypes.map((item) => findTrash(item.type, item.title)))
    await openTrash()
    for (const item of secondPass) await purgeWithCancelAndConfirm(item)
    await owner.page.reload()
    await openTrash()
    await expect(owner.page.getByText('回收站是空的', { exact: true })).toBeVisible()
    const afterReload = await getTrash()
    expect(afterReload.some((entry) => secondPass.some((item) => item.id === entry.id))).toBe(false)
  } finally {
    await closeElectron(owner.app, owner.profile, 'trash-types')
  }
})

test('DEV-QA26 G2-13 真实 Electron viewer 全类型回收站写权限矩阵', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(240_000)
  const owner = await openOwner(page, baseURL!, 'trash-matrix', '漫画')
  let viewerApp: ElectronApp | undefined
  let viewerProfile = ''
  try {
    const stamp = Date.now()
    const accountId = owner.account.id
    const workTitle = `QA26 viewer 回收站作品 ${stamp}`
    const topicTitle = `QA26 viewer 回收站选题 ${stamp}`
    const materialTitle = `QA26 viewer 回收站素材 ${stamp}`
    const sampleTitle = `QA26 viewer 回收站样本 ${stamp}`
    const characterTitle = `QA26 viewer 回收站角色 ${stamp}`
    const referenceTitle = `https://www.xiaohongshu.com/explore/qa26-trash-viewer-${stamp}`
    const wordTitle = `qa26-viewer-trash-${stamp}`

    const work = await api(page, 'POST', `/accounts/${accountId}/works`, { title: workTitle }) as { id: string }
    const topic = await api(page, 'POST', `/accounts/${accountId}/topics`, { title: topicTitle, angle: '隔离的权限矩阵记录' }) as { topic: { id: string } }
    const material = await api(page, 'POST', '/materials', { account_id: accountId, kind: 'experience', content: materialTitle, source: 'DEV-QA26 本地验收', tags: [] }) as { id: string }
    const sample = await api(page, 'POST', `/accounts/${accountId}/style-samples`, { title: sampleTitle, content_md: '仅用于 DEV-QA26 viewer 权限验收。' }) as { id: string }
    const character = await api(page, 'POST', `/accounts/${accountId}/characters`, { name: characterTitle, appearance: '测试角色', personality: '仅用于权限验收', catchphrase: 'DEV-QA26' }) as { id: string }
    const reference = await api(page, 'POST', `/accounts/${accountId}/references`, { links: [referenceTitle] }) as { ids: string[] }
    await api(page, 'POST', '/sensitive-words', { words: [wordTitle], category: 'DEV-QA26' })
    const word = (await api(page, 'GET', '/sensitive-words') as Array<{ id: string; word: string }>).find((item) => item.word === wordTitle)
    expect(word).toBeTruthy()

    const fixtures = [
      { type: 'work', id: work.id, title: workTitle, tab: '作品', deletePath: `/works/${work.id}` },
      { type: 'topic', id: topic.topic.id, title: topicTitle, tab: '选题', deletePath: `/topics/${topic.topic.id}` },
      { type: 'material', id: material.id, title: materialTitle, tab: '素材', deletePath: `/materials/${material.id}` },
      { type: 'style_sample', id: sample.id, title: sampleTitle, tab: '风格样本', deletePath: `/style-samples/${sample.id}` },
      { type: 'character_card', id: character.id, title: characterTitle, tab: '角色卡', deletePath: `/characters/${character.id}` },
      { type: 'reference', id: reference.ids[0], title: referenceTitle, tab: '对标参考', deletePath: `/references/${reference.ids[0]}` },
      { type: 'sensitive_word', id: word!.id, title: wordTitle, tab: '敏感词', deletePath: `/sensitive-words/${word!.id}` },
    ]
    await Promise.all(fixtures.map((item) => api(page, 'DELETE', item.deletePath)))
    const seededTrash = await api(page, 'GET', '/trash') as Array<{ id: string; type: string; title: string }>
    const confirmedFixtures = fixtures.map((item) => {
      const entry = seededTrash.find((candidate) => candidate.type === item.type && candidate.id === item.id)
      expect(entry, `${item.type} 应进入回收站`).toBeTruthy()
      return { ...item, title: entry!.title }
    })

    await selectDesktopSetting(owner.page, '成员与邀请')
    const members = owner.page.getByTestId('desktop-settings-window')
    await members.getByRole('combobox').last().selectOption('viewer')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await members.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { code: string; role: string }
    expect(invite.role).toBe('viewer')

    const viewerUsername = `qa26-g8-trash-matrix-${stamp}`
    viewerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-trash-matrix-viewer-'))
    viewerApp = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + viewerProfile, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const viewerPage = await viewerApp.firstWindow()
    await viewerPage.goto(baseURL + '/register')
    await viewerPage.getByLabel('用户名', { exact: true }).fill(viewerUsername)
    await viewerPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await viewerPage.getByLabel('邀请码（可选）').fill(invite.code)
    await viewerPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => viewerPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const viewerMe = await viewerPage.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { user_id: string; workspace: { id: string }; role: string; csrf_token: string }
    expect(viewerMe.role).toBe('viewer')
    await viewerPage.evaluate(({ userId, workspaceId, accountId: selectedAccount }) => {
      localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, selectedAccount)
    }, { userId: viewerMe.user_id, workspaceId: viewerMe.workspace.id, accountId })
    await viewerPage.goto(`${baseURL}/a/${accountId}`)
    await viewerPage.getByRole('button', { name: /用户菜单/ }).click()
    await viewerPage.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(viewerPage, '回收站')

    const filterSamples: number[] = []
    for (let index = 0; index < 20; index++) {
      const item = confirmedFixtures[index % confirmedFixtures.length]
      const tab = viewerPage.getByRole('button', { name: new RegExp(`^${item.tab}`) })
      const started = performance.now()
      await tab.click()
      await expect(tab).toHaveClass(/bg-white/)
      const row = viewerPage.locator('li').filter({ hasText: item.title })
      await expect(row).toBeVisible()
      filterSamples.push(performance.now() - started)
      if (index < confirmedFixtures.length) {
        await expect(row.getByRole('button', { name: '恢复', exact: true })).toHaveCount(0)
        await expect(row.getByRole('button', { name: '恢复并查看', exact: true })).toHaveCount(0)
        await expect(row.getByRole('button', { name: '彻底删除', exact: true })).toHaveCount(0)
      }
    }
    const sortedFilterSamples = [...filterSamples].sort((a, b) => a - b)
    const filterMetrics = {
      environment: 'Windows Electron', samples_ms: filterSamples.map((sample) => Number(sample.toFixed(2))),
      p50_ms: Number(sortedFilterSamples[9].toFixed(2)), p95_ms: Number(sortedFilterSamples[18].toFixed(2)), failures: 0,
    }
    await test.info().attach('trash-viewer-type-filter-metrics', { body: Buffer.from(JSON.stringify(filterMetrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 trash viewer type filters n=20 p50=${filterMetrics.p50_ms}ms p95=${filterMetrics.p95_ms}ms failures=0 environment=Windows Electron`)

    const writeStatuses = await viewerPage.evaluate(async ({ items, csrfToken }) => await Promise.all(items.map(async (item) => {
      const headers = { 'X-CSRF-Token': csrfToken }
      const [restore, purge] = await Promise.all([
        fetch(`/api/v1/trash/${item.type}/${item.id}/restore`, { method: 'POST', headers }),
        fetch(`/api/v1/trash/${item.type}/${item.id}?confirm=true`, { method: 'DELETE', headers }),
      ])
      return { type: item.type, restore: restore.status, purge: purge.status }
    })), { items: confirmedFixtures.map(({ type, id }) => ({ type, id })), csrfToken: viewerMe.csrf_token })
    expect(writeStatuses).toEqual(confirmedFixtures.map(({ type }) => ({ type, restore: 403, purge: 403 })))
    const ownerTrashAfter = await api(page, 'GET', '/trash') as Array<{ id: string; type: string }>
    expect(confirmedFixtures.every((item) => ownerTrashAfter.some((entry) => entry.type === item.type && entry.id === item.id))).toBe(true)
  } finally {
    if (viewerApp) await closeElectron(viewerApp, viewerProfile, 'trash-matrix-viewer')
    await closeElectron(owner.app, owner.profile, 'trash-matrix')
  }
})

test('DEV-QA26 G2-02 真实 Electron 账号编辑、迁移、停用与恢复', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const owner = await openOwner(page, baseURL!, 'account-management')
  const oldWork = await api(page, 'POST', '/accounts/' + owner.account.id + '/works', {
    title: '迁移前作品 ' + Date.now(),
  }) as { id: string; content_format: string }
  expect(oldWork.content_format).toBe('image_note')
  const dialogSamples: number[] = []
  const journeyStarted = performance.now()
  try {
    await selectDesktopSetting(owner.page, '平台账号与凭证')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const changeType = settings.getByRole('button', { name: '修改类型', exact: true })

    let failedReadInjected = false
    await owner.page.route('**/api/v1/accounts/' + owner.account.id + '/works', async (route) => {
      if (route.request().method() === 'GET' && !failedReadInjected) {
        failedReadInjected = true
        await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'QA26 注入作品读取失败' } } })
        return
      }
      await route.continue()
    })
    await changeType.click()
    let migration = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '修改账号类型', exact: true }) })
    await expect(migration.getByRole('alert')).toContainText('读取修改影响失败')
    await expect(migration.getByRole('button', { name: '确认修改', exact: true })).toBeDisabled()
    await migration.getByRole('button', { name: '重新读取修改影响', exact: true }).click()
    await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
    await owner.page.unroute('**/api/v1/accounts/' + owner.account.id + '/works')
    await migration.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).content_format).toBe('image_note')

    for (let index = 0; index < 20; index += 1) {
      const started = performance.now()
      await changeType.click()
      migration = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '修改账号类型', exact: true }) })
      await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
      dialogSamples.push(performance.now() - started)
      await migration.getByRole('button', { name: '取消', exact: true }).click()
      await expect(migration).toHaveCount(0)
    }

    await changeType.click()
    migration = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '修改账号类型', exact: true }) })
    await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
    await migration.getByRole('radio', { name: /漫画/ }).check()
    const migratedResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/accounts/' + owner.account.id) && response.request().method() === 'PATCH')
    await migration.getByRole('button', { name: '确认修改', exact: true }).click()
    const migrated = await migratedResponse
    expect(migrated.status()).toBe(200)
    const migrationBody = await migrated.json() as {
      account: { content_format: string }
      type_change: { from: string; to: string; works_kept: number; character_cards_kept: number; stale_plan_slots: number }
    }
    expect(migrationBody.account.content_format).toBe('comic')
    expect(migrationBody.type_change).toMatchObject({ from: 'image_note', to: 'comic', works_kept: 1, character_cards_kept: 0, stale_plan_slots: 0 })
    expect((await api(page, 'GET', '/works/' + oldWork.id)).content_format).toBe('image_note')
    const newWork = await api(page, 'POST', '/accounts/' + owner.account.id + '/works', { title: '迁移后新作品 ' + Date.now() }) as { id: string; content_format: string }
    expect(newWork.content_format).toBe('comic')

    const savedName = 'QA26 账号保存 ' + Date.now()
    const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
    await name.fill('QA26 未保存名称')
    await settings.getByRole('button', { name: '取消修改', exact: true }).click()
    await expect(name).toHaveValue(owner.account.name)
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).name).toBe(owner.account.name)
    await name.fill(savedName)
    const saveResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/accounts/' + owner.account.id) && response.request().method() === 'PATCH')
    await settings.getByRole('button', { name: '保存信息', exact: true }).click()
    expect((await saveResponse).status()).toBe(200)
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).name).toBe(savedName)
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await reloadElectronWindow(owner.app)
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '平台账号与凭证')
    await expect(owner.page.getByTestId('desktop-settings-window').getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(savedName)
    await expect(owner.page.getByTestId('desktop-settings-window').getByText('漫画', { exact: true }).first()).toBeVisible()

    const currentSettings = owner.page.getByTestId('desktop-settings-window')
    await currentSettings.locator('.desktop-account-actions details > summary').click()
    await currentSettings.getByRole('button', { name: '停用当前账号', exact: true }).click()
    let disableDialog = owner.page.getByRole('dialog').filter({ hasText: '停用「小红书 · ' + savedName + '」？' })
    await expect(disableDialog).toBeVisible()
    await disableDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).status).toBe('active')

    await currentSettings.getByRole('button', { name: '停用当前账号', exact: true }).click()
    disableDialog = owner.page.getByRole('dialog').filter({ hasText: '停用「小红书 · ' + savedName + '」？' })
    const disabledResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/accounts/' + owner.account.id + '/disable') && response.request().method() === 'POST')
    await disableDialog.getByRole('button', { name: '停用', exact: true }).click()
    expect((await disabledResponse).status()).toBe(200)
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).status).toBe('disabled')
    await currentSettings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(owner.page.getByRole('heading', { name: '当前账号已停用', exact: true })).toBeVisible()
    await openDesktopAccountSwitcher(owner.page)
    const picker = owner.page.getByTestId('desktop-context-menu')
    await picker.getByText('已停用 1', { exact: true }).click()
    await picker.getByRole('button', { name: new RegExp(savedName + ' 已停用') }).click()
    await expect(currentSettings).toBeVisible()
    await currentSettings.locator('.desktop-account-actions details > summary').click()
    const enabledResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/accounts/' + owner.account.id + '/enable') && response.request().method() === 'POST')
    await currentSettings.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await enabledResponse).status()).toBe(200)
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).status).toBe('active')

    await currentSettings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await reloadElectronWindow(owner.app)
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '平台账号与凭证')
    const reloadedSettings = owner.page.getByTestId('desktop-settings-window')
    await expect(reloadedSettings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(savedName)
    await expect(reloadedSettings.getByText('漫画', { exact: true }).first()).toBeVisible()
    const sorted = [...dialogSamples].sort((a, b) => a - b)
    console.log('DEV-QA26 G2-02 Electron modify-type dialog n=20 p50=' +
      ((sorted[9] + sorted[10]) / 2).toFixed(2) + 'ms p95=' + sorted[18].toFixed(2) +
      'ms failures=0; journey_ms=' + (performance.now() - journeyStarted).toFixed(2) + ' environment=Windows Electron')
  } finally {
    await closeElectron(owner.app, owner.profile, 'account-management')
  }
})

test('DEV-QA26 G2-02 真实 Electron 编辑者只能查看平台账号', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const owner = await openOwner(page, baseURL!, 'account-role')
  let editorApp: ElectronApp | undefined
  let editorProfile = ''
  try {
    await selectDesktopSetting(owner.page, '成员与邀请')
    const settings = owner.page.getByTestId('desktop-settings-window')
    await settings.getByRole('combobox').last().selectOption('editor')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { code: string; role: string }
    expect(invite.role).toBe('editor')

    const editorUsername = 'qa26-g2-account-editor-' + Date.now()
    editorProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g8-account-role-'))
    editorApp = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + editorProfile, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const editorPage = await editorApp.firstWindow()
    await editorPage.goto(baseURL + '/register')
    await editorPage.getByLabel('用户名', { exact: true }).fill(editorUsername)
    await editorPage.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await editorPage.getByLabel('邀请码（可选）').fill(invite.code)
    await editorPage.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => editorPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const ownerWorkspace = (await api(page, 'GET', '/auth/me') as { workspace: { id: string } }).workspace
    const editorMe = await editorPage.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as {
      workspace: { id: string }; role: string
    }
    expect(editorMe.workspace.id).toBe(ownerWorkspace.id)
    expect(editorMe.role).toBe('editor')
    expect((await editorPage.evaluate(async () => await (await fetch('/api/v1/accounts')).json()) as Array<{ id: string }>)
      .some((account) => account.id === owner.account.id)).toBe(true)
    await editorPage.goto(baseURL + '/a/' + owner.account.id)
    await editorPage.getByRole('button', { name: /用户菜单/ }).click()
    await editorPage.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(editorPage, '平台账号与凭证')
    const editorSettings = editorPage.getByTestId('desktop-settings-window')
    await expect(editorSettings.getByText('编辑者可查看账号，修改由所有者操作。', { exact: true })).toBeVisible()
    await expect(editorSettings.getByRole('textbox', { name: '账号名称', exact: true })).toBeDisabled()
    await expect(editorSettings.getByRole('button', { name: '修改类型', exact: true })).toHaveCount(0)
    await expect(editorSettings.getByRole('button', { name: '停用当前账号', exact: true })).toHaveCount(0)
    await expect(editorSettings.getByRole('button', { name: '删除当前账号', exact: true })).toHaveCount(0)
    const denied = await editorPage.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const [edit, disable, remove] = await Promise.all([
        fetch('/api/v1/accounts/' + accountId, { method: 'PATCH', headers, body: JSON.stringify({ name: '越权账号名' }) }),
        fetch('/api/v1/accounts/' + accountId + '/disable', { method: 'POST', headers }),
        fetch('/api/v1/accounts/' + accountId + '?confirm=true', { method: 'DELETE', headers }),
      ])
      return [edit.status, disable.status, remove.status]
    }, owner.account.id)
    expect(denied).toEqual([403, 403, 403])
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).name).toBe(owner.account.name)
    expect((await api(page, 'GET', '/accounts/' + owner.account.id)).status).toBe('active')
  } finally {
    if (editorApp) await closeElectron(editorApp, editorProfile, 'account-role')
    await closeElectron(owner.app, owner.profile, 'account-role')
  }
})

test('DEV-QA26 G8 真实 Electron 敏感词从设置生效、过滤、撤销与观察者权限', async ({ page, browser, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const owner = await openOwner(page, baseURL!, 'words-audit')
  let viewerContext: BrowserContext | undefined
  let viewerApp: ElectronApp | undefined
  let viewerProfile = ''
  let ownerClosed = false
  try {
    await selectDesktopSetting(owner.page, '敏感词库')
    const settings = owner.page.getByTestId('desktop-settings-window')
    const wordField = settings.getByLabel(/^敏感词/)
    await expect(settings.getByText('还没有自定义敏感词。', { exact: true })).toBeVisible()

    const failedWord = `qa26-word-fail-${Date.now()}`
    let rejectNextPost = true
    await owner.page.route('**/api/v1/sensitive-words', async (route) => {
      if (route.request().method() === 'POST' && rejectNextPost) {
        rejectNextPost = false
        await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'qa26 injected sensitive word failure' } } })
        return
      }
      await route.continue()
    })
    await wordField.fill(failedWord)
    const rejected = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/sensitive-words') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '添加', exact: true }).click()
    expect((await rejected).status()).toBe(500)
    await expect(owner.page.getByText('qa26 injected sensitive word failure')).toBeVisible()
    await expect(wordField).toHaveValue(failedWord)
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { word: string }) => item.word === failedWord)).toBe(false)
    await owner.page.unroute('**/api/v1/sensitive-words')

    const cancelledDraft = `qa26-word-cancel-${Date.now()}`
    await wordField.fill(cancelledDraft)
    await selectDesktopSetting(owner.page, '平台账号与凭证')
    const discardDialog = owner.page.getByRole('dialog').filter({ has: owner.page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discardDialog).toBeVisible()
    await discardDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(wordField).toHaveValue(cancelledDraft)
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { word: string }) => item.word === cancelledDraft)).toBe(false)
    await wordField.fill('')

    const stamp = Date.now()
    const primaryWord = `qa26-word-${stamp}`
    const secondaryWord = `qa26-term-${stamp}`
    const category = `qa26-category-${stamp}`
    await wordField.fill(`${primaryWord}\n${secondaryWord}`)
    await settings.getByPlaceholder('例如：医疗、金融').fill(category)
    const added = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/sensitive-words') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '添加', exact: true }).click()
    const addResponse = await added
    expect(addResponse.ok()).toBe(true)
    expect(await addResponse.json()).toMatchObject({ added: 2, skipped: 0 })
    await expect(owner.page.getByText('已添加 2 个', { exact: true })).toBeVisible()
    const createdWords = (await api(page, 'GET', '/sensitive-words') as Array<{ id: string; word: string; category: string; source: string }>)
      .filter((item) => item.word === primaryWord || item.word === secondaryWord)
    expect(createdWords).toHaveLength(2)
    expect(createdWords.every((item) => item.source === 'custom' && item.category === category)).toBe(true)

    const search = settings.getByRole('textbox', { name: '搜索', exact: true })
    const searchSamples: number[] = []
    for (let index = 0; index < 20; index++) {
      const matches = index % 2 === 0
      const started = performance.now()
      await search.fill(matches ? primaryWord : `qa26-no-match-${stamp}`)
      if (matches) await expect(settings.locator('span').filter({ hasText: primaryWord }).first()).toBeVisible()
      else await expect(settings.getByText('没有匹配的词。', { exact: true })).toBeVisible()
      searchSamples.push(performance.now() - started)
    }
    const sortedSearchSamples = [...searchSamples].sort((a, b) => a - b)
    const searchMetrics = {
      environment: 'Windows native Electron', sample_count: searchSamples.length,
      p50_ms: Number(sortedSearchSamples[9].toFixed(2)), p95_ms: Number(sortedSearchSamples[18].toFixed(2)), failures: 0,
    }
    await test.info().attach('g8-sensitive-word-search-metrics', { body: Buffer.from(JSON.stringify(searchMetrics)), contentType: 'application/json' })
    console.log(`DEV-QA26 sensitive word search n=20 p50=${searchMetrics.p50_ms}ms p95=${searchMetrics.p95_ms}ms failures=0 environment=Windows Electron`)

    await search.fill('')
    const primaryEntry = createdWords.find((item) => item.word === primaryWord)!
    const chip = settings.locator('span').filter({ hasText: primaryWord }).first()
    const softDelete = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/sensitive-words/' + primaryEntry.id) && response.request().method() === 'DELETE')
    await chip.getByRole('button', { name: '删除', exact: true }).click()
    expect((await softDelete).ok()).toBe(true)
    await expect(owner.page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === primaryEntry.id)).toBe(false)
    expect((await api(page, 'GET', '/trash')).some((item: { id: string; type: string }) => item.id === primaryEntry.id && item.type === 'sensitive_word')).toBe(true)
    await owner.page.getByRole('button', { name: '撤销', exact: true }).click()
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string; word: string }) => item.id === primaryEntry.id && item.word === primaryWord)).toBe(true)
    expect((await api(page, 'GET', '/trash')).some((item: { id: string }) => item.id === primaryEntry.id)).toBe(false)

    await reloadElectronWindow(owner.app)
    await owner.page.goto(`${baseURL}/a/${owner.account.id}`)
    await expect(owner.page.getByRole('button', { name: /用户菜单/ })).toBeVisible()
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '敏感词库')
    await expect(owner.page.getByTestId('desktop-settings-window').locator('span').filter({ hasText: primaryWord }).first()).toBeVisible()
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === primaryEntry.id)).toBe(true)
    await owner.page.getByTestId('desktop-settings-window').getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(owner.page.getByTestId('desktop-settings-window')).toHaveCount(0)

    const workId = await createOutline(owner.page)
    const work = await api(page, 'GET', '/works/' + workId) as { sections: Array<{ id: string; revision: number }> }
    await api(page, 'PATCH', '/sections/' + work.sections[0].id, {
      content_md: `发布前检查必须命中自定义敏感词 ${primaryWord}。`, base_revision: work.sections[0].revision,
    })
    await owner.page.goto(`${baseURL}/works/${workId}/check`)
    const checkStarted = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/works/${workId}/checks`) && response.request().method() === 'POST')
    await owner.page.getByRole('button', { name: '开始检查', exact: true }).click()
    expect((await checkStarted).ok()).toBe(true)
    await expect.poll(async () => {
      const latest = await api(page, 'GET', `/works/${workId}/checks/latest`)
      return latest.run?.items?.some((item: { category: string; message: string }) => item.category === 'sensitive' && item.message.includes(primaryWord)) ?? false
    }, { timeout: 30_000 }).toBe(true)
    await expect(owner.page.getByText(primaryWord, { exact: false }).first()).toBeVisible()

    await owner.page.goto(`${baseURL}/a/${owner.account.id}`)
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '成员与邀请')
    const memberSettings = owner.page.getByTestId('desktop-settings-window')
    await memberSettings.getByRole('combobox').last().selectOption('viewer')
    const inviteResponse = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/workspaces/current/invites') && response.request().method() === 'POST')
    await memberSettings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await inviteResponse.then((response) => response.json()) as { code: string; role: string }
    expect(invite.role).toBe('viewer')

    const viewerUsername = `qa26-g8-words-viewer-${stamp}`
    viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: viewerUsername, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok()).toBeTruthy()
    const viewerMe = await (await viewerContext.request.get('/api/v1/auth/me')).json() as { role: string; workspace: { id: string } }
    expect(viewerMe.role).toBe('viewer')
    expect(viewerMe.workspace.id).toBe((await api(page, 'GET', '/auth/me')).workspace.id)
    await viewerContext.close()
    viewerContext = undefined

    await closeElectron(owner.app, owner.profile, 'words-audit')
    ownerClosed = true
    const viewer = await launchElectron(baseURL!, viewerUsername, 'words-viewer', invite.code)
    viewerApp = viewer.app
    viewerProfile = viewer.profile
    const viewerPage = viewer.page
    const loggedIn = await viewerPage.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { username: string; role: string; workspace: { id: string }; user_id: string }
    expect(loggedIn.username).toBe(viewerUsername)
    expect(loggedIn.role).toBe('viewer')
    expect(loggedIn.workspace.id).toBe(viewerMe.workspace.id)
    await viewerPage.goto(`${baseURL}/settings/words`)
    const viewerSettings = viewerPage.getByTestId('desktop-settings-window')
    await expect(viewerSettings.getByText('你是观察者，只能查看；敏感词由所有者或编辑者维护。', { exact: true })).toBeVisible()
    await expect(viewerSettings.getByLabel(/^敏感词/)).toHaveCount(0)
    await expect(viewerSettings.getByRole('button', { name: '添加', exact: true })).toHaveCount(0)
    await expect(viewerSettings.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
    const denied = await viewerPage.evaluate(async ({ wordId, word }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
      const [add, remove] = await Promise.all([
        fetch('/api/v1/sensitive-words', { method: 'POST', headers, body: JSON.stringify({ words: [word], category: 'DEV-QA26' }) }),
        fetch('/api/v1/sensitive-words/' + wordId, { method: 'DELETE', headers }),
      ])
      return [add.status, remove.status]
    }, { wordId: primaryEntry.id, word: `qa26-forbidden-${stamp}` })
    expect(denied).toEqual([403, 403])
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { id: string }) => item.id === primaryEntry.id)).toBe(true)
    expect((await api(page, 'GET', '/sensitive-words')).some((item: { word: string }) => item.word === `qa26-forbidden-${stamp}`)).toBe(false)
  } finally {
    if (viewerApp) await closeElectron(viewerApp, viewerProfile, 'words-viewer')
    await viewerContext?.close()
    if (!ownerClosed) await closeElectron(owner.app, owner.profile, 'words-audit')
  }
})
