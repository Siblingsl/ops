import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { selectDesktopSetting } from './support'

async function closeQaElectron(app: Awaited<ReturnType<typeof _electron.launch>> | undefined) {
  if (!app) return
  try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 只关闭本用例创建的客户端。 */ }
  await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function prepareRoutine(page: Page, baseURL: string, modelBaseURL = 'http://127.0.0.1:8297/v1') {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw10-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW10 例行任务验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW10 工作台 mock 模型', base_url: modelBaseURL, api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const bootstrap = await api(page, 'GET', '/agent/bootstrap')
  expect(bootstrap.features.routines).toBe(true)
  return account
}

async function startHeldRoutineModelProxy() {
  const mockBaseURL = new URL(process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1')
  let holdNextStream = false
  let wasHeld = false
  let wasAborted = false
  let resolveHeld: (() => void) | undefined
  let resolveAborted: (() => void) | undefined
  let heldPromise = Promise.resolve()
  let abortedPromise = Promise.resolve()
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      void (async () => {
        let hold = false
        if (holdNextStream && incoming.method === 'POST' && incoming.url === '/v1/chat/completions') {
          try { hold = JSON.parse(body.toString()).stream === true } catch { /* Invalid payload is forwarded for the upstream mock to reject. */ }
        }
        if (hold) {
          holdNextStream = false
          wasHeld = true
          resolveHeld?.()
          const disconnected = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 15_000)
            outgoing.once('close', () => {
              clearTimeout(timer)
              resolve(!outgoing.writableEnded)
            })
          })
          if (disconnected) {
            wasAborted = true
            resolveAborted?.()
            return
          }
        }
        try {
          const upstream = await fetch(`${mockBaseURL.origin}${incoming.url ?? '/'}`, {
            method: incoming.method ?? 'GET',
            headers: {
              'content-type': incoming.headers['content-type'] ?? 'application/json',
              ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}),
            },
            ...(body.length > 0 ? { body } : {}),
          })
          const responseBody = Buffer.from(await upstream.arrayBuffer())
          outgoing.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-cache',
          })
          outgoing.end(responseBody)
        } catch (error) {
          if (!outgoing.destroyed) {
            outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            outgoing.end(error instanceof Error ? error.message : String(error))
          }
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动本地例行模型代理')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    arm() {
      holdNextStream = true
      wasHeld = false
      wasAborted = false
      heldPromise = new Promise<void>((resolve) => { resolveHeld = resolve })
      abortedPromise = new Promise<void>((resolve) => { resolveAborted = resolve })
    },
    async waitUntilHeld() {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('mock 模型未收到在途运行请求')), 10_000)
        void heldPromise.then(() => { clearTimeout(timer); resolve() }, reject)
      })
      expect(wasHeld).toBe(true)
    },
    async waitUntilAborted() {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('撤权后模型请求未被取消')), 8_000)
        void abortedPromise.then(() => { clearTimeout(timer); resolve() }, reject)
      })
      expect(wasAborted).toBe(true)
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

async function routineJourney(page: Page, baseURL: string, screenshotName: string, revokeAccountBeforeRun = false) {
  const account = await prepareRoutine(page, baseURL)
  const materialName = `AW10 例行公开引用 ${Date.now()}`
  const material = await api(page, 'POST', '/materials', {
    account_id: account.id, kind: 'case', content: `${materialName}：经授权的公开运营背景资料。`, source: '本地端到端测试',
  })
  await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '服务器模型', exact: true }).locator('option')).toHaveCount(2)
  await expect(dialog.getByRole('combobox', { name: '运营账号', exact: true })).toHaveValue(account.id)
  const name = `AW10 私有报告 ${Date.now()}`
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。\n#text 本次例行报告：只读查询已完成。')
  await dialog.getByRole('button', { name: '添加引用', exact: true }).click()
  const picker = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '引用工作区资料', exact: true }) })
  await picker.getByRole('textbox', { name: '搜索资料', exact: true }).fill(materialName)
  const candidate = picker.getByRole('button', { name: new RegExp(materialName) })
  await expect(candidate).toBeVisible()
  await candidate.click()
  await picker.getByRole('button', { name: '预览并校验', exact: true }).click()
  await expect(picker.locator('pre')).toHaveText(`${materialName}：经授权的公开运营背景资料。`)
  await picker.getByRole('button', { name: '添加引用', exact: true }).click()
  await expect(dialog.getByText(materialName, { exact: false })).toBeVisible()
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
  expect((await createdResponse).status()).toBe(200)
  const routineList = await api(page, 'GET', '/agent/routines')
  const routine = routineList.items.find((item: { name: string }) => item.name === name)
  expect(routine).toBeTruthy()
  expect(routine.model.provider_id).toBeTruthy()
  expect(routine.status).toBe('enabled')
  expect(routine.public_context_refs).toHaveLength(1)
  expect(routine.public_context_refs[0].id).toBe(material.id)
  const occurrencePath = `/agent/routines/${routine.id}/occurrences`

  if (revokeAccountBeforeRun) {
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toBeHidden()
    const isDesktop = await page.evaluate(() => /Electron/i.test(navigator.userAgent))
    if (isDesktop) {
      await page.getByRole('button', { name: /^用户菜单：/ }).click()
      await page.getByRole('menuitem', { name: '切换工作区与账号', exact: true }).click()
      await page.getByRole('tab', { name: /小红书/ }).click()
      await page.getByTestId('desktop-context-menu').getByRole('button', { name: 'AW10 例行任务验收号', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/a/${account.id}(?:$|/)`))
      await page.goto(`${baseURL}/settings/accounts`)
      const accountActions = page.locator('summary').filter({ hasText: '账号操作' })
      await accountActions.click()
      await page.getByRole('button', { name: '停用当前账号', exact: true }).click()
    } else {
      await page.goto(`${baseURL}/settings/accounts?id=${account.id}`)
      await page.getByRole('button', { name: /AW10 例行任务验收号/ }).click()
      await page.getByRole('button', { name: '停用', exact: true }).click()
    }
    const disableDialog = page.getByRole('dialog').filter({ hasText: '停用' })
    await disableDialog.getByRole('button', { name: '停用', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id)?.status).toBe('disabled')
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    const disabledRoutine = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(disabledRoutine.error_code).toBe('account_disabled')
    expect(disabledRoutine.next_due_at).toBeFalsy()
    const notifications = await api(page, 'GET', '/notifications')
    expect(notifications.items.some((item: { kind: string; title: string; body: string }) => item.kind === 'agent_routine' && item.title === '例行任务已暂停' && item.body.includes('绑定账号已停用'))).toBe(true)
    await page.reload()
    await expect(page.getByText('已停用', { exact: true }).first()).toBeVisible()

    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const disabledTask = page.locator('article').filter({ hasText: name })
    const controlPath = `/api/v1/agent/routines/${routine.id}/control`
    await expect(disabledTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(disabledTask.getByText(/绑定账号已停用；重新启用账号后，请手动重新启用此任务。/)).toBeVisible()
    await expect(disabledTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await expect(disabledTask.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
    expect((await api(page, 'GET', occurrencePath)).items).toHaveLength(0)

    await page.goto(`${baseURL}/settings/accounts`)
    const accountActions = page.locator('summary').filter({ hasText: '账号操作' })
    await accountActions.click()
    const enableAccount = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/accounts/${account.id}/enable` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重新启用', exact: true }).last().click()
    expect((await enableAccount).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id)?.status).toBe('active')
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')

    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const restoredTask = page.locator('article').filter({ hasText: name })
    const enableRoutine = page.waitForResponse((response) => new URL(response.url()).pathname === controlPath && response.request().method() === 'POST')
    await restoredTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await enableRoutine).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
    return
  }

  const task = dialog.locator('article').filter({ hasText: name })
  await task.getByRole('button', { name: '立即运行一次', exact: true }).click()
  await expect.poll(async () => {
    const result = await api(page, 'GET', occurrencePath)
    return result.items[0]?.status
  }, { timeout: 60_000 }).toBe('completed')
  const occurrence = (await api(page, 'GET', occurrencePath)).items[0]
  expect(occurrence.run_id).toBeTruthy()
  await task.getByRole('button', { name: '执行记录', exact: true }).click()
  await expect(task.getByText(/手动运行 · 已完成/)).toBeVisible()

  const conversations = await api(page, 'GET', `/agent/conversations?q=${encodeURIComponent(`例行任务：${name}`)}`)
  const reportConversation = conversations.items.find((item: { title: string }) => item.title === `例行任务：${name}`)
  expect(reportConversation).toBeTruthy()
  const artifacts = await api(page, 'GET', `/agent/conversations/${reportConversation.id}/artifacts`)
  expect(artifacts.items.some((item: { source_run_id?: string }) => item.source_run_id === occurrence.run_id)).toBe(true)
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshotName}.png`) })
}

test('DEV-AW10 Windows Electron配置受限例行任务、手动运行并查看私有报告', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw10-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await routineJourney(await app.firstWindow(), baseURL!, 'agent-workbench-aw10-electron')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw10-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron停用绑定账号后暂停例行任务并逐项恢复', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-revoke-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await routineJourney(await app.firstWindow(), baseURL!, 'qa26-routine-revoke-electron', true)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-revoke-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron创建者降为观察者与移出后暂停例行任务', async ({ baseURL, browser }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(240_000)
  const ownerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-role-owner-'))
  let ownerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let editorContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    ownerApp = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${ownerProfile}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const ownerPage = await ownerApp.firstWindow()
    const account = await prepareRoutine(ownerPage, baseURL!)
    const ownerMe = await api(ownerPage, 'GET', '/auth/me')
    const invite = await api(ownerPage, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 })
    const editorUsername = `qa26-routine-role-${Date.now()}`

    editorContext = await browser.newContext({ baseURL: baseURL! })
    const joined = await editorContext.request.post('/api/v1/auth/register', {
      data: { username: editorUsername, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok(), '通过邀请码注册工作区编辑者').toBeTruthy()
    const editorPage = await editorContext.newPage()
    await editorPage.goto(`${baseURL}/agent`)
    await expect.poll(async () => (await api(editorPage, 'GET', '/auth/me')).role).toBe('editor')
    const editorMe = await api(editorPage, 'GET', '/auth/me')
    expect(editorMe.workspace.id).toBe(ownerMe.workspace.id)
    const privacy = editorPage.getByRole('dialog').filter({ has: editorPage.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await editorPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = editorPage.getByRole('dialog').filter({ has: editorPage.getByRole('heading', { name: '受限例行任务', exact: true }) })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: '运营账号', exact: true })).toHaveValue(account.id)
    const name = `QA26 降权恢复任务 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('只读核对并生成报告。\n#text 创建者降权恢复测试。')
    const created = editorPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await created).status()).toBe(200)
    const before = await api(editorPage, 'GET', '/agent/routines')
    const routine = before.items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')

    await ownerPage.getByRole('button', { name: /^用户菜单：/ }).click()
    await ownerPage.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(ownerPage, '成员与邀请')
    const settings = ownerPage.getByTestId('desktop-settings-window')
    const memberRow = settings.locator('li').filter({ hasText: editorUsername })
    await expect(memberRow).toBeVisible()
    const roleSelect = memberRow.getByRole('combobox')
    const roleChanged = ownerPage.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/workspaces/current/members/${editorMe.user_id}`) && response.request().method() === 'PATCH')
    await roleSelect.selectOption('viewer')
    expect((await roleChanged).status()).toBe(200)
    await expect.poll(async () => (await api(ownerPage, 'GET', '/workspaces/current/members')).find((item: { username: string }) => item.username === editorUsername)?.role).toBe('viewer')
    await expect.poll(async () => (await api(editorPage, 'GET', '/auth/me')).role).toBe('viewer')

    const afterDowngrade = await api(editorPage, 'GET', '/agent/routines')
    expect(afterDowngrade.items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    expect(afterDowngrade.items.find((item: { id: string }) => item.id === routine.id)?.error_code).toBe('member_role_revoked')
    expect((await api(editorPage, 'GET', '/notifications')).items.some((item: { kind: string; title: string }) => item.kind === 'agent_routine' && item.title === '例行任务已暂停')).toBe(true)

    await editorPage.goto(`${baseURL}/agent`)
    await editorPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const pausedTask = editorPage.locator('article').filter({ hasText: name })
    await expect(pausedTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(pausedTask.getByText(/恢复编辑权限后，请手动重新启用此任务/)).toBeVisible()
    await expect(pausedTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)

    await roleSelect.selectOption('editor')
    await expect.poll(async () => (await api(ownerPage, 'GET', '/workspaces/current/members')).find((item: { username: string }) => item.username === editorUsername)?.role).toBe('editor')
    await editorPage.reload()
    await editorPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const restoredTask = editorPage.locator('article').filter({ hasText: name })
    const enableRoutine = editorPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await restoredTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await enableRoutine).status()).toBe(200)
    await expect.poll(async () => (await api(editorPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const cancelRemoval = ownerPage.getByRole('dialog').filter({ has: ownerPage.getByRole('heading', { name: `移出 ${editorUsername}？`, exact: true }) })
    await cancelRemoval.getByRole('button', { name: '取消', exact: true }).click()
    await expect(memberRow).toBeVisible()
    expect((await api(ownerPage, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === editorMe.user_id)).toBe(true)

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const confirmRemoval = ownerPage.getByRole('dialog').filter({ has: ownerPage.getByRole('heading', { name: `移出 ${editorUsername}？`, exact: true }) })
    const removed = ownerPage.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/workspaces/current/members/${editorMe.user_id}`) && response.request().method() === 'PATCH')
    await confirmRemoval.getByRole('button', { name: '确定', exact: true }).click()
    expect((await removed).status()).toBe(200)
    await expect.poll(async () => (await api(ownerPage, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === editorMe.user_id)).toBe(false)
    const removedMemberMe = await editorContext!.request.get(`${baseURL}/api/v1/auth/me`)
    expect(removedMemberMe.status()).toBe(200)
    expect(((await removedMemberMe.json()) as { workspace: { id: string } }).workspace.id).not.toBe(ownerMe.workspace.id)
    const removedMemberRoutines = await editorContext!.request.get(`${baseURL}/api/v1/agent/routines`)
    expect(removedMemberRoutines.status()).toBe(200)
    expect(((await removedMemberRoutines.json()) as { items: unknown[] }).items).toHaveLength(0)

    const rejoinInvite = await api(ownerPage, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 })
    await editorPage.goto(`${baseURL}/settings/members`)
    await editorPage.getByPlaceholder('邀请码').fill(rejoinInvite.code)
    const rejoined = editorPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/workspaces/join' && response.request().method() === 'POST')
    const joinedWorkspaceHome = editorPage.waitForURL((url) => url.pathname === '/')
    await editorPage.getByRole('button', { name: '加入并切换', exact: true }).click()
    expect((await rejoined).status()).toBe(200)
    await joinedWorkspaceHome
    const rejoinedIdentity = await editorContext!.request.get(`${baseURL}/api/v1/auth/me`)
    expect(rejoinedIdentity.status()).toBe(200)
    expect(((await rejoinedIdentity.json()) as { workspace: { id: string } }).workspace.id).toBe(ownerMe.workspace.id)
    await editorPage.goto(`${baseURL}/agent`)
    await editorPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const afterRejoinTask = editorPage.locator('article').filter({ hasText: name })
    await expect(afterRejoinTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(afterRejoinTask.getByText(/重新加入并恢复编辑权限后，请手动重新启用此任务/)).toBeVisible()
    await expect(afterRejoinTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    expect((await api(editorPage, 'GET', '/notifications')).items.some((item: { kind: string; body: string }) => item.kind === 'agent_routine' && item.body.includes('已移出此工作区'))).toBe(true)
    const reenabled = editorPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await afterRejoinTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await reenabled).status()).toBe(200)
    await expect.poll(async () => (await api(editorPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
  } finally {
    await ownerApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await ownerApp?.close()
    await editorContext?.close()
    const resolved = resolve(ownerProfile)
    if (!resolved.startsWith(resolve(tmpdir()) + sep) || !basename(ownerProfile).startsWith('ops-qa26-routine-role-owner-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(ownerProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron关闭工作区智能体后暂停例行任务并逐项恢复', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-agent-disable-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepareRoutine(page, baseURL!)
    await page.goto(`${baseURL}/settings/agent`)
    const agentSwitch = page.getByRole('switch', { name: '启用智能体', exact: true })
    const toggleSamples: number[] = []
    for (let index = 0; index < 20; index++) {
      const expectedEnabled = index % 2 === 1
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/settings' && response.request().method() === 'PUT')
      const startedAt = Date.now()
      await agentSwitch.click()
      const response = await responsePromise
      expect(response.status()).toBe(200)
      await expect(agentSwitch).toHaveAttribute('aria-checked', expectedEnabled ? 'true' : 'false')
      toggleSamples.push(Date.now() - startedAt)
    }
    const sortedToggleSamples = [...toggleSamples].sort((a, b) => a - b)
    const toggleMetrics = { environment: 'Windows native Electron; local mock API', sample_count: toggleSamples.length, samples: toggleSamples,
      p50_ms: sortedToggleSamples[9], p95_ms: sortedToggleSamples[18], failed: 0 }
    console.log(`DEV-QA26_METRIC_AGENT_TOGGLE_ELECTRON ${JSON.stringify(toggleMetrics)}`)
    await testInfo.attach('agent-toggle-20-samples.json', { body: JSON.stringify(toggleMetrics, null, 2), contentType: 'application/json' })
    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
    const name = `QA26 智能体关闭 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。')
    const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await createdResponse).status()).toBe(200)
    const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')

    await page.goto(`${baseURL}/settings/agent`)
    const disable = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/settings' && response.request().method() === 'PUT')
    await page.getByRole('switch', { name: '启用智能体', exact: true }).click()
    expect((await disable).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/agent/bootstrap')).reason).toBe('disabled')

    const enable = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/settings' && response.request().method() === 'PUT')
    await page.getByRole('switch', { name: '启用智能体', exact: true }).click()
    expect((await enable).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/agent/bootstrap')).can_use).toBe(true)
    const paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.status).toBe('paused')
    expect(paused.error_code).toBe('agent_disabled')
    expect(paused.next_due_at).toBeFalsy()
    expect((await api(page, 'GET', '/notifications')).items.some((item: { kind: string; body: string }) => item.kind === 'agent_routine' && item.body.includes('工作区已关闭智能体'))).toBe(true)
    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const task = page.locator('article').filter({ hasText: name })
    await expect(task.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(task.getByText(/工作区已关闭智能体.*请手动重新启用此任务/)).toBeVisible()
    await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await task.getByRole('button', { name: '重新启用', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-agent-disable-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron停用例行任务模型后应立即暂停', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-model-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepareRoutine(page, baseURL!)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
    const name = `QA26 模型停用 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。')
    const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await createdResponse).status()).toBe(200)
    const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')
    const provider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === routine.model.provider_id)
    expect(provider).toBeTruthy()
    await page.goto(`${baseURL}/settings/models`)
    const providerCard = page.locator('div.group').filter({ hasText: provider.name })
    await expect(providerCard.getByRole('switch', { name: '启用', exact: true })).toHaveAttribute('aria-checked', 'true')
    await providerCard.getByRole('switch', { name: '启用', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)?.status).toBe('disabled')
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    const paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.error_code).toBe('model_unavailable')
    expect(paused.next_due_at).toBeFalsy()
    expect((await api(page, 'GET', '/notifications')).items.some((item: { kind: string; body: string }) => item.kind === 'agent_routine' && item.body.includes('任务模型不可用'))).toBe(true)
    await page.reload()
    await expect(providerCard.getByText('已停用', { exact: true })).toBeVisible()
    expect((await api(page, 'GET', `/agent/routines/${routine.id}/occurrences`)).items).toHaveLength(0)
    await page.goto(`${baseURL}/settings/models`)
    const restoreCard = page.locator('div.group').filter({ hasText: provider.name })
    await restoreCard.getByRole('switch', { name: '启用', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)?.status).toBe('active')
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const readyTask = page.locator('article').filter({ hasText: name })
    await expect(readyTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(readyTask.getByText(/任务模型不可用或未通过工具能力自检/)).toBeVisible()
    await expect(readyTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await expect(readyTask.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
    await readyTask.getByRole('button', { name: '重新启用', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-model-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron修改模型密钥后自检失败暂停例行任务并逐项恢复', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-model-selftest-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepareRoutine(page, baseURL!)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
    const name = `QA26 模型自检失败 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。')
    const createResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await createResponse).status()).toBe(200)
    const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')
    const provider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === routine.model.provider_id)
    expect(provider).toBeTruthy()

    await page.goto(`${baseURL}/settings/models`)
    let providerCard = page.locator('div.group').filter({ hasText: provider.name })
    await providerCard.getByRole('button', { name: '编辑', exact: true }).click()
    let providerDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑模型供应商', exact: true }) })
    await providerDialog.getByLabel(/API 密钥/).fill('bad-key')
    const saveBadKey = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}` && response.request().method() === 'PATCH')
    await providerDialog.getByRole('button', { name: '保存', exact: true }).click()
    expect((await saveBadKey).status()).toBe(200)
    let updatedProvider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)
    expect(updatedProvider.last_test_ok).toBeNull()
    expect(updatedProvider.capabilities).toHaveLength(0)
    await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    let paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.error_code).toBe('model_unavailable')
    expect(paused.next_due_at).toBeFalsy()
    expect((await api(page, 'GET', '/notifications')).items.some((item: { kind: string; body: string }) => item.kind === 'agent_routine' && item.body.includes('任务模型不可用'))).toBe(true)

    providerCard = page.locator('div.group').filter({ hasText: provider.name })
    const badSelftestResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}/selftest` && response.request().method() === 'POST')
    await providerCard.getByRole('button', { name: '自检', exact: true }).click()
    const badSelftest = await badSelftestResponse
    expect(badSelftest.status()).toBe(200)
    const failedResult = await badSelftest.json()
    expect(failedResult.ok).toBe(false)
    expect(failedResult.results.find((item: { key: string }) => item.key === 'tools')?.ok).toBe(false)
    const failedDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '供应商能力自检', exact: true }) })
    await expect(failedDialog).toContainText('自检完成：1/7 项通过')
    await expect(failedDialog).not.toContainText('bad-key')
    updatedProvider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)
    expect(updatedProvider.last_test_ok).toBe(false)
    expect(updatedProvider.capabilities.find((item: { model: string }) => item.model === 'mock-agent-tested')?.tools_ok).toBe(false)
    paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.status).toBe('paused')
    expect((await api(page, 'GET', `/agent/routines/${routine.id}/occurrences`)).items).toHaveLength(0)
    await failedDialog.getByRole('button', { name: '关闭', exact: true }).click()

    providerCard = page.locator('div.group').filter({ hasText: provider.name })
    await providerCard.getByRole('button', { name: '编辑', exact: true }).click()
    providerDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑模型供应商', exact: true }) })
    await providerDialog.getByLabel(/API 密钥/).fill('local-e2e-key')
    const saveGoodKey = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}` && response.request().method() === 'PATCH')
    await providerDialog.getByRole('button', { name: '保存', exact: true }).click()
    expect((await saveGoodKey).status()).toBe(200)
    updatedProvider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)
    expect(updatedProvider.last_test_ok).toBeNull()
    expect(updatedProvider.capabilities).toHaveLength(0)
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')

    providerCard = page.locator('div.group').filter({ hasText: provider.name })
    const goodSelftestResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}/selftest` && response.request().method() === 'POST')
    await providerCard.getByRole('button', { name: '自检', exact: true }).click()
    const goodSelftest = await goodSelftestResponse
    expect(goodSelftest.status()).toBe(200)
    const readyResult = await goodSelftest.json()
    expect(readyResult.ok).toBe(true)
    expect(readyResult.results.find((item: { key: string }) => item.key === 'tools')?.ok).toBe(true)
    const readyDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '供应商能力自检', exact: true }) })
    await expect(readyDialog).toContainText('自检完成：7/7 项通过')
    await readyDialog.getByRole('button', { name: '关闭', exact: true }).click()
    expect((await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)?.capabilities.find((item: { model: string }) => item.model === 'mock-agent-tested')?.tools_ok).toBe(true)
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')

    const providerSwitch = page.locator('div.group').filter({ hasText: provider.name }).getByRole('switch', { name: '启用', exact: true })
    const toggleSamples: number[] = []
    for (let index = 0; index < 20; index++) {
      const expectedActive = index % 2 === 1
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}` && response.request().method() === 'PATCH')
      const startedAt = Date.now()
      await providerSwitch.click()
      const response = await responsePromise
      expect(response.status()).toBe(200)
      await expect(providerSwitch).toHaveAttribute('aria-checked', expectedActive ? 'true' : 'false')
      toggleSamples.push(Date.now() - startedAt)
    }
    const sortedSamples = [...toggleSamples].sort((a, b) => a - b)
    const toggleMetrics = { environment: 'Windows native Electron; local mock API', sample_count: toggleSamples.length,
      samples_ms: toggleSamples, p50_ms: sortedSamples[9], p95_ms: sortedSamples[18], failed: 0 }
    console.log(`DEV-QA26_METRIC_ROUTINE_MODEL_CONFIG_ELECTRON ${JSON.stringify(toggleMetrics)}`)
    await testInfo.attach('routine-model-config-20-samples.json', { body: JSON.stringify(toggleMetrics, null, 2), contentType: 'application/json' })
    expect((await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)?.status).toBe('active')

    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const routineCard = page.locator('article').filter({ hasText: name })
    await expect(routineCard.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(routineCard.getByText(/任务模型不可用.*请手动重新启用此任务/)).toBeVisible()
    await expect(routineCard.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    const resumeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await routineCard.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await resumeResponse).status()).toBe(200)
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
    expect((await api(page, 'GET', `/agent/routines/${routine.id}/occurrences`)).items).toHaveLength(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-model-selftest-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron系统用户停用后暂停例行任务并逐项恢复', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(240_000)
  const startedAt = Date.now()
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-user-disable-'))
  const adminData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-admin-disable-'))
  let userApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let adminApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const electronPath = resolve(process.cwd(), '../node_modules/electron/dist/electron.exe')
    const mainPath = resolve(process.cwd(), '../.build/main.js')
    userApp = await _electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${userData}`, mainPath],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const userPage = await userApp.firstWindow()
    await prepareRoutine(userPage, baseURL!)
    const identity = await api(userPage, 'GET', '/auth/me')
    const username = identity.username as string
    const name = `QA26 系统用户停用 ${Date.now()}`
    await userPage.goto(`${baseURL}/agent`)
    await userPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const routineDialog = userPage.getByRole('dialog').filter({ has: userPage.getByRole('heading', { name: '受限例行任务', exact: true }) })
    await routineDialog.getByLabel('名称', { exact: true }).fill(name)
    await routineDialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。')
    const routineSelectors = routineDialog.getByRole('combobox')
    await routineSelectors.nth(0).selectOption({ index: 1 })
    await routineSelectors.nth(1).selectOption({ index: 1 })
    const createdResponse = userPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    const createButton = routineDialog.getByRole('button', { name: '创建并启用', exact: true })
    await expect(createButton).toBeEnabled()
    await createButton.click()
    expect((await createdResponse).status()).toBe(200)
    const routine = (await api(userPage, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')

    adminApp = await _electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${adminData}`, mainPath],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const adminPage = await adminApp.firstWindow()
    await adminPage.goto(`${baseURL}/login`)
    await adminPage.getByLabel('用户名', { exact: true }).fill('skyeder')
    await adminPage.getByLabel('密码', { exact: true }).fill('local-e2e-admin-pass-456')
    const adminLogin = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await adminPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await adminLogin).status()).toBe(200)
    await adminPage.goto(`${baseURL}/settings/admin`)
    await expect(adminPage.getByText('用户', { exact: true })).toBeVisible()
    const userCard = adminPage.getByRole('heading', { name: '用户', exact: true })
      .locator('..').locator('..').locator('..')
    const userRow = userCard.getByRole('listitem').filter({ hasText: username })
    await expect(userRow).toBeVisible()
    await expect(userRow.getByText(/会话 1/)).toBeVisible()
    const disableButton = userRow.getByRole('button', { name: '禁用', exact: true })
    const disableResponse = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/admin/users/') && response.request().method() === 'PATCH')
    await disableButton.click()
    expect((await disableResponse).status()).toBe(200)
    await expect(userRow.getByRole('button', { name: '启用', exact: true })).toBeVisible()
    await expect(userRow.getByText(/会话 0/)).toBeVisible()
    expect(await userPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(401)

    const enableButton = userRow.getByRole('button', { name: '启用', exact: true })
    const enableResponse = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/admin/users/') && response.request().method() === 'PATCH')
    await enableButton.click()
    expect((await enableResponse).status()).toBe(200)
    await expect(userRow.getByRole('button', { name: '禁用', exact: true })).toBeVisible()
    await expect(userRow.getByText(/会话 0/)).toBeVisible()

    await userPage.goto(`${baseURL}/login`)
    await userPage.getByLabel('用户名', { exact: true }).fill(username)
    await userPage.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const userLogin = userPage.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await userPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await userLogin).status()).toBe(200)
    await userPage.goto(`${baseURL}/agent`)
    await userPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const task = userPage.locator('article').filter({ hasText: name })
    await expect(task.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(task.getByText(/系统用户已停用；重新启用用户后，请手动重新启用此任务。/)).toBeVisible()
    await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await expect(task.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
    const paused = (await api(userPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.status).toBe('paused')
    expect(paused.error_code).toBe('system_user_disabled')
    expect(paused.next_due_at).toBeFalsy()
    expect((await api(userPage, 'GET', '/notifications')).items.some((item: { kind: string; body: string; link: string }) => item.kind === 'agent_routine' && item.body.includes('系统用户已停用') && item.link.includes(routine.id))).toBe(true)
    await userPage.reload()
    await userPage.goto(`${baseURL}/agent`)
    await userPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const restoredTask = userPage.locator('article').filter({ hasText: name })
    const reenabled = userPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await restoredTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await reenabled).status()).toBe(200)
    expect((await api(userPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id).status).toBe('enabled')

    const journeyMs = Date.now() - startedAt
    testInfo.attach('system-user-disable-journey.json', { body: JSON.stringify({ environment: 'Windows native Electron; local mock API', journey_ms: journeyMs, failed: 0 }, null, 2), contentType: 'application/json' })
    console.log(`DEV-QA26_SYSTEM_USER_DISABLE_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local mock API', journey_ms: journeyMs, failed: 0 })}`)
  } finally {
    await closeQaElectron(adminApp)
    await closeQaElectron(userApp)
    if (!resolve(adminData).startsWith(resolve(tmpdir()) + sep) || !basename(adminData).startsWith('ops-qa26-routine-admin-disable-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(adminData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-user-disable-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron系统用户停用在途例行任务后保留中断记录', async ({ baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(240_000)
  const startedAt = Date.now()
  const proxy = await startHeldRoutineModelProxy()
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-inflight-user-'))
  const adminData = await mkdtemp(join(tmpdir(), 'ops-qa26-routine-inflight-admin-'))
  let userApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let adminApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const electronPath = resolve(process.cwd(), '../node_modules/electron/dist/electron.exe')
    const mainPath = resolve(process.cwd(), '../.build/main.js')
    userApp = await _electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${userData}`, mainPath],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const userPage = await userApp.firstWindow()
    await prepareRoutine(userPage, baseURL!, proxy.baseURL)
    const identity = await api(userPage, 'GET', '/auth/me')
    const username = identity.username as string
    const name = `QA26 在途例行任务停止 ${Date.now()}`
    await userPage.goto(`${baseURL}/agent`)
    await userPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const routineDialog = userPage.getByRole('dialog').filter({ has: userPage.getByRole('heading', { name: '受限例行任务', exact: true }) })
    await routineDialog.getByLabel('名称', { exact: true }).fill(name)
    await routineDialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('只读查询账号表现，等待本次运行被系统管理员停止。')
    const selectors = routineDialog.getByRole('combobox')
    await selectors.nth(0).selectOption({ index: 1 })
    await selectors.nth(1).selectOption({ index: 1 })
    const createdResponse = userPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await routineDialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await createdResponse).status()).toBe(200)
    const routine = (await api(userPage, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')
    expect(routine.model.model).toBe('mock-agent-tested')

    adminApp = await _electron.launch({ executablePath: electronPath, args: [`--user-data-dir=${adminData}`, mainPath],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const adminPage = await adminApp.firstWindow()
    await adminPage.goto(`${baseURL}/login`)
    await adminPage.getByLabel('用户名', { exact: true }).fill('skyeder')
    await adminPage.getByLabel('密码', { exact: true }).fill('local-e2e-admin-pass-456')
    const adminLogin = adminPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await adminPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await adminLogin).status()).toBe(200)
    await adminPage.goto(`${baseURL}/settings/admin`)
    const userCard = adminPage.getByRole('heading', { name: '用户', exact: true }).locator('..').locator('..').locator('..')
    const userRow = userCard.getByRole('listitem').filter({ hasText: username })
    await expect(userRow).toBeVisible()

    const task = userPage.locator('article').filter({ hasText: name })
    proxy.arm()
    const runOnce = userPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await task.getByRole('button', { name: '立即运行一次', exact: true }).click()
    expect((await runOnce).status()).toBe(200)
    await proxy.waitUntilHeld()
    await expect.poll(async () => {
      const occurrences = await api(userPage, 'GET', `/agent/routines/${routine.id}/occurrences`)
      return occurrences.items[0]?.status
    }).toBe('running')

    const disableButton = userRow.getByRole('button', { name: '禁用', exact: true })
    const disabledResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/api/v1/admin/users/') && response.request().method() === 'PATCH')
    const revokedSession = userPage.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/auth/me' && response.request().method() === 'GET' && response.status() === 401)
    await disableButton.click()
    expect((await disabledResponse).status()).toBe(200)
    await proxy.waitUntilAborted()
    expect((await revokedSession).status()).toBe(401)

    const enableUser = userRow.getByRole('button', { name: '启用', exact: true })
    const enabledResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/api/v1/admin/users/') && response.request().method() === 'PATCH')
    await enableUser.click()
    expect((await enabledResponse).status()).toBe(200)
    await userPage.goto(`${baseURL}/login`)
    await userPage.getByLabel('用户名', { exact: true }).fill(username)
    await userPage.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const userLogin = userPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await userPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await userLogin).status()).toBe(200)
    await userPage.goto(`${baseURL}/agent`)
    await userPage.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const pausedTask = userPage.locator('article').filter({ hasText: name })
    await expect(pausedTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(pausedTask.getByText(/系统用户已停用；重新启用用户后，请手动重新启用此任务。/)).toBeVisible()
    await expect(pausedTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    const pausedRoutine = (await api(userPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(pausedRoutine).toMatchObject({ status: 'paused', error_code: 'system_user_disabled' })
    expect(pausedRoutine.next_due_at).toBeFalsy()
    expect((await api(userPage, 'GET', '/notifications')).items.some((item: { kind: string; body: string; link: string }) =>
      item.kind === 'agent_routine' && item.body.includes('系统用户已停用') && item.link.includes(routine.id))).toBe(true)
    await expect.poll(async () => (await api(userPage, 'GET', `/agent/routines/${routine.id}/occurrences`)).items[0]?.status).toBe('interrupted')
    const occurrences = await api(userPage, 'GET', `/agent/routines/${routine.id}/occurrences`)
    expect(occurrences.items[0]).toMatchObject({ status: 'interrupted', error_code: 'stopped' })
    expect(occurrences.items[0].run_id).toBeTruthy()
    await pausedTask.getByRole('button', { name: '执行记录', exact: true }).click()
    const history = pausedTask.getByRole('list', { name: '例行任务执行记录', exact: true })
    await expect(history).toContainText('中断')
    await expect(history).toContainText('stopped')
    await pausedTask.getByRole('button', { name: '收起记录', exact: true }).click()

    const conversations = await api(userPage, 'GET', `/agent/conversations?q=${encodeURIComponent(`例行任务：${name}`)}`)
    const conversation = conversations.items.find((item: { title: string }) => item.title === `例行任务：${name}`)
    expect(conversation).toBeTruthy()
    await expect.poll(async () => (await api(userPage, 'GET', `/agent/conversations/${conversation.id}`)).last_run?.status).toBe('stopped')

    const reenable = pausedTask.getByRole('button', { name: '重新启用', exact: true })
    const reenableResponse = userPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await reenable.click()
    expect((await reenableResponse).status()).toBe(200)
    expect((await api(userPage, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id).status).toBe('enabled')
    expect((await api(userPage, 'GET', `/agent/routines/${routine.id}/occurrences`)).items[0].status).toBe('interrupted')

    const samples: number[] = []
    let failures = 0
    for (let i = 0; i < 20; i++) {
      try {
        const start = performance.now()
        await pausedTask.getByRole('button', { name: '执行记录', exact: true }).click()
        await expect(pausedTask.getByRole('list', { name: '例行任务执行记录', exact: true })).toBeVisible()
        samples.push(performance.now() - start)
        await pausedTask.getByRole('button', { name: '收起记录', exact: true }).click()
      } catch (error) {
        failures++
        throw error
      }
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    const journeyMs = Date.now() - startedAt
    const metrics = { environment: 'Windows native Electron; local E2E API and delayed loopback mock model', journey_ms: journeyMs,
      ordinary_interactions: 20, interaction_p50_ms: Number(p50.toFixed(2)), interaction_p95_ms: Number(p95.toFixed(2)), failures }
    testInfo.attach('system-user-disable-inflight-routine.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
    console.log(`DEV-QA26_ROUTINE_INFLIGHT_DISABLE_ELECTRON ${JSON.stringify(metrics)}`)
  } finally {
    await closeQaElectron(adminApp)
    await closeQaElectron(userApp)
    await proxy.close()
    if (!resolve(adminData).startsWith(resolve(tmpdir()) + sep) || !basename(adminData).startsWith('ops-qa26-routine-inflight-admin-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(adminData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-qa26-routine-inflight-user-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

