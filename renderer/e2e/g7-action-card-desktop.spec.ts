import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>

async function closeElectron(app: ElectronApp | undefined, profile: string, tag: string) {
  if (app) {
    try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本用例启动的 Electron。 */ }
    await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
  }
  const resolved = resolve(profile)
  if (!resolved.startsWith(resolve(tmpdir()) + '\\') || !profile.includes(`ops-qa26-g7-${tag}-`)) {
    throw new Error('拒绝清理测试目录之外路径')
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

async function openAgent(page: Page, baseURL: string, tag: string) {
  const username = `qa26-g7-${tag}-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  const provider = await api(page, 'POST', '/model-providers', {
    name: `QA26 原生 Electron 动作卡 ${tag}`,
    base_url: process.env.OPS_E2E_MOCK_BASE_URL!,
    api_key: 'local-e2e-key',
    models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

  const profile = await mkdtemp(join(tmpdir(), `ops-qa26-g7-${tag}-`))
  let app: ElectronApp | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL },
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
    await native.getByRole('button', { name: /用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '切换工作区与账号' }).click()
    await native.getByTestId('desktop-context-menu').getByRole('tab', { name: /小红书/ }).click()
    await native.getByTestId('desktop-context-menu').getByRole('button', { name: '浏览器验收号', exact: true }).click()
    await native.getByRole('link', { name: 'AI 对话', exact: true }).click()
    const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(privacy).toBeHidden()
    await native.getByTestId('desktop-agent-list').getByRole('button', { name: '新对话', exact: true }).click()
    return { app, native, profile, account }
  } catch (error) {
    await closeElectron(app, profile, tag)
    throw error
  }
}

async function proposeMaterial(page: Page, native: Page, accountId: string, content: string) {
  await native.getByPlaceholder(/说说你想写什么/).fill(
    `请添加素材：${content}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: accountId, kind: 'opinion', content })}`,
  )
  const create = native.waitForResponse((response) =>
    /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname)
    && response.request().method() === 'POST')
  await native.getByRole('button', { name: '发送', exact: true }).click()
  expect((await create).ok()).toBeTruthy()
  await native.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationId = native.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).active_run).toBeNull()
  const conversation = await api(page, 'GET', `/agent/conversations/${conversationId}`)
  return { conversationId, actions: conversation.actions as Array<{ id: string; status: string }> }
}

test('DEV-QA26 G7 真实 Electron 动作卡逐张执行并验证服务端素材写入', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景只使用本地 mock API 与模型')
  test.setTimeout(180_000)
  const client = await openAgent(page, baseURL!, 'execute')
  try {
    const content = `原生 Electron 逐张执行 ${Date.now()}`
    const { conversationId, actions } = await proposeMaterial(page, client.native, client.account.id, content)
    expect(actions).toHaveLength(1)
    expect(actions[0].status).toBe('pending')

    const card = client.native.locator('.desktop-agent-action-card').first()
    await expect(card).toBeAttached()
    await expect(client.native.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
    const execute = client.native.waitForResponse((response) =>
      /\/agent\/actions\/[^/]+\/execute$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST')
    await card.getByRole('button', { name: /执行|入库|保存/ }).first().click()
    expect((await execute).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions[0].status).toBe('succeeded')

    const materials = await api(page, 'GET', `/materials?account_id=${client.account.id}`) as Array<{ content: string }>
    expect(materials.some((item) => item.content === content)).toBeTruthy()
  } finally {
    await closeElectron(client.app, client.profile, 'execute')
  }
})

test('DEV-QA26 G7 真实 Electron 动作卡拒绝后服务端零写入', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景只使用本地 mock API 与模型')
  test.setTimeout(180_000)
  const client = await openAgent(page, baseURL!, 'reject')
  try {
    const content = `原生 Electron 拒绝零写入 ${Date.now()}`
    const { conversationId, actions } = await proposeMaterial(page, client.native, client.account.id, content)
    expect(actions).toHaveLength(1)
    expect(actions[0].status).toBe('pending')

    const card = client.native.locator('.desktop-agent-action-card').first()
    await expect(card).toBeAttached()
    await expect(client.native.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
    const reject = client.native.waitForResponse((response) =>
      /\/agent\/actions\/[^/]+\/reject$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST')
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    expect((await reject).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationId}`)).actions[0].status).toBe('rejected')

    const materials = await api(page, 'GET', `/materials?account_id=${client.account.id}`) as Array<{ content: string }>
    expect(materials.some((item) => item.content === content)).toBeFalsy()
  } finally {
    await closeElectron(client.app, client.profile, 'reject')
  }
})

test('DEV-QA26 G7 真实 Electron H-02 动作卡逐项确认后保存观点', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景只使用本地 mock API 与模型')
  test.setTimeout(180_000)
  const client = await openAgent(page, baseURL!, 'gate')
  try {
    const title = '原生 Electron H-02 观点门 ' + Date.now()
    const work = await api(page, 'POST', '/accounts/' + client.account.id + '/works', { title, content_format: 'image_note' }) as { id: string }
    const viewpoint = '先把复杂目标拆成当天能完成的小步，再持续记录实际结果。' + Date.now()
    const message = '这是我的核心观点原话：' + viewpoint
      + '\n请按原文保存，不要改写。'
      + '\n#tool load_tool_domain {"domain":"works"}'
      + '\n#tool works__set_viewpoint ' + JSON.stringify({ id: work.id, viewpoint })
    await client.native.getByPlaceholder(/说说你想写什么/).fill(message)
    const create = client.native.waitForResponse((response) =>
      /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST')
    await client.native.getByRole('button', { name: '发送', exact: true }).click()
    expect((await create).ok()).toBeTruthy()
    await client.native.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
    const conversationId = client.native.url().split('/').pop()!
    await expect.poll(async () => (await api(page, 'GET', '/agent/conversations/' + conversationId)).active_run).toBeNull()
    const conversation = await api(page, 'GET', '/agent/conversations/' + conversationId)
    expect(conversation.actions).toHaveLength(1)
    expect(conversation.actions[0]).toMatchObject({ status: 'pending', gate: 'H-02' })
    expect((await api(page, 'GET', '/works/' + work.id)).viewpoint).toBe('')

    const card = client.native.locator('.desktop-agent-action-card').first()
    await expect(card).toBeAttached()
    await expect(client.native.getByRole('button', { name: /全部执行|全部确认/ })).toHaveCount(0)
    const gate = card.getByRole('checkbox')
    await expect(gate).not.toBeChecked()
    await gate.check()
    const execute = client.native.waitForResponse((response) =>
      /\/agent\/actions\/[^/]+\/execute$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST')
    await card.getByRole('button', { name: /保存我的观点/ }).click()
    expect((await execute).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', '/agent/conversations/' + conversationId)).actions[0].status).toBe('succeeded')
    expect((await api(page, 'GET', '/works/' + work.id)).viewpoint).toBe(viewpoint)
  } finally {
    await closeElectron(client.app, client.profile, 'gate')
  }
})
