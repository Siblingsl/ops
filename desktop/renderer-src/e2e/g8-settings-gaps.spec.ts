import { _electron, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount, selectDesktopSetting } from './support'

type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>

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

async function openOwner(page: Page, baseURL: string, tag: string) {
  const username = 'qa26-g8-' + tag + '-' + Date.now()
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
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
