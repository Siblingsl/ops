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
