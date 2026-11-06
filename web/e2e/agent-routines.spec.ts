import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { mockModelBaseUrl } from './support'

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

async function prepareRoutine(page: Page, baseURL: string, modelBaseURL = mockModelBaseUrl()) {
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

async function startFailingRoutineModelProxy() {
  const mockBaseURL = new URL(process.env.OPS_E2E_MOCK_BASE_URL ?? mockModelBaseUrl())
  let failuresRemaining = 0
  let injectedFailures = 0
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      void (async () => {
        if (failuresRemaining > 0 && incoming.method === 'POST' && incoming.url === '/v1/chat/completions') {
          failuresRemaining--
          injectedFailures++
          outgoing.writeHead(503, { 'content-type': 'application/json' })
          outgoing.end('{"error":{"message":"DEV-QA26 local injected upstream failure"}}')
          return
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
          outgoing.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-cache',
          })
          outgoing.end(Buffer.from(await upstream.arrayBuffer()))
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
  if (!address || typeof address === 'string') throw new Error('无法启动本地例行任务故障代理')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get injectedFailures() { return injectedFailures },
    failNext() { failuresRemaining++ },
    close() { return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) },
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
    await page.goto(`${baseURL}/settings/accounts?id=${account.id}`)
    await page.getByRole('button', { name: '停用', exact: true }).click()
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

    await page.goto(`${baseURL}/settings/accounts?id=${account.id}`)
    const enableAccount = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/accounts/${account.id}/enable` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重新启用', exact: true }).first().click()
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
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/${screenshotName}.png`) })
}

test('DEV-AW10 Web配置受限例行任务、手动运行并查看私有报告', async ({ page, baseURL }) => {
  await routineJourney(page, baseURL!, 'agent-workbench-aw10-web')
})

test('DEV-QA26 Web例行任务连续失败三次暂停并手动恢复', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000)
  const proxy = await startFailingRoutineModelProxy()
  const failureSamples: number[] = []
  try {
    const account = await prepareRoutine(page, baseURL!, proxy.baseURL)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
    const name = `QA26 连续失败暂停 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('只读检查并生成报告。\n#text 本地故障验收')
    await expect(dialog.getByRole('combobox', { name: '运营账号', exact: true })).toHaveValue(account.id)
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await created).status()).toBe(200)
    const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine).toMatchObject({ status: 'enabled', failure_count: 0 })
    const occurrencePath = `/agent/routines/${routine.id}/occurrences`

    for (let failure = 1; failure <= 3; failure++) {
      proxy.failNext()
      const started = performance.now()
      await dialog.locator('article').filter({ hasText: name }).getByRole('button', { name: '立即运行一次', exact: true }).click()
      await expect.poll(() => proxy.injectedFailures, { timeout: 30_000 }).toBe(failure)
      await expect.poll(async () => (await api(page, 'GET', occurrencePath)).items[0]?.status, { timeout: 30_000 }).toBe('failed')
      failureSamples.push(Number((performance.now() - started).toFixed(2)))
      const persisted = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
      expect(persisted.failure_count).toBe(failure)
      expect(persisted.status).toBe(failure === 3 ? 'paused' : 'enabled')
      if (failure < 3) expect(persisted.error_code).toBeTruthy()
      else {
        expect(persisted.error_code).toBe('three_consecutive_failures')
        expect(persisted.next_due_at).toBeFalsy()
      }
      await page.reload()
      await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
      const task = page.locator('article').filter({ hasText: name })
      await expect(task).toContainText(`连续失败 ${failure}/3`)
      await task.getByRole('button', { name: '执行记录', exact: true }).click()
      await expect(task).toContainText('手动运行 · 失败')
      if (failure === 3) {
        await expect(task.getByText('已暂停', { exact: true })).toBeVisible()
        await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
        await expect(task.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
        await task.getByRole('button', { name: '重新启用', exact: true }).click()
        await expect.poll(async () => {
          const enabled = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
          return { status: enabled.status, failure_count: enabled.failure_count, error_code: enabled.error_code ?? '' }
        }).toEqual({ status: 'enabled', failure_count: 0, error_code: '' })
        await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toBeVisible()
      }
    }
    const sorted = [...failureSamples].sort((a, b) => a - b)
    const metrics = { environment: 'Web Chromium; local mock API and injected loopback model 503', samples_ms: failureSamples,
      p50_ms: sorted[1], p95_ms: sorted[2], failure_count: 3, failed: 0 }
    await testInfo.attach('qa26-routine-three-failures-web.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
    console.log(`DEV-QA26_ROUTINE_THREE_FAILURES_WEB ${JSON.stringify(metrics)}`)
  } finally {
    await proxy.close()
  }
})

test('DEV-QA26 Web停用绑定账号后暂停例行任务并逐项恢复', async ({ page, baseURL }) => {
  await routineJourney(page, baseURL!, 'qa26-routine-revoke-web', true)
})

test('DEV-QA26 Web创建者降为观察者与移出后暂停例行任务', async ({ page, baseURL, browser }) => {
  const account = await prepareRoutine(page, baseURL!)
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 })
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const username = `qa26-routine-role-${Date.now()}`
    const joined = await context.request.post('/api/v1/auth/register', {
      data: { username, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok()).toBeTruthy()
    const editorMe = await (await context.request.get('/api/v1/auth/me')).json() as { user_id: string; role: string; workspace: { id: string } }
    expect(editorMe.role).toBe('editor')
    const ownerMe = await api(page, 'GET', '/auth/me')
    expect(editorMe.workspace.id).toBe(ownerMe.workspace.id)

    const editor = await context.newPage()
    await editor.goto(`${baseURL}/agent`)
    const privacy = editor.getByRole('dialog').filter({ has: editor.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await editor.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = editor.getByRole('dialog').filter({ has: editor.getByRole('heading', { name: '受限例行任务', exact: true }) })
    await expect(dialog.getByRole('combobox', { name: '运营账号', exact: true })).toHaveValue(account.id)
    const name = `QA26 降权恢复任务 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('只读核对并生成报告。\n#text 创建者降权恢复测试。')
    const created = editor.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await created).status()).toBe(200)
    const routine = (await api(editor, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')

    await page.goto(`${baseURL}/settings/members`)
    const memberRow = page.locator('li').filter({ hasText: username })
    await expect(memberRow).toBeVisible()
    const roleSelect = memberRow.getByRole('combobox')
    const roleChanged = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/workspaces/current/members/${editorMe.user_id}`) && response.request().method() === 'PATCH')
    await roleSelect.selectOption('viewer')
    expect((await roleChanged).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/workspaces/current/members')).find((item: { user_id: string }) => item.user_id === editorMe.user_id)?.role).toBe('viewer')
    await expect.poll(async () => (await api(editor, 'GET', '/auth/me')).role).toBe('viewer')

    const pausedRoutine = (await api(editor, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(pausedRoutine.status).toBe('paused')
    expect(pausedRoutine.error_code).toBe('member_role_revoked')
    expect((await api(editor, 'GET', '/notifications')).items.some((item: { kind: string; title: string }) => item.kind === 'agent_routine' && item.title === '例行任务已暂停')).toBe(true)
    await editor.goto(`${baseURL}/agent`)
    await editor.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const pausedTask = editor.locator('article').filter({ hasText: name })
    await expect(pausedTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(pausedTask.getByText(/恢复编辑权限后，请手动重新启用此任务/)).toBeVisible()
    await expect(pausedTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await expect(pausedTask.getByRole('button', { name: '重新启用', exact: true })).toHaveCount(0)

    await roleSelect.selectOption('editor')
    await expect.poll(async () => (await api(page, 'GET', '/workspaces/current/members')).find((item: { user_id: string }) => item.user_id === editorMe.user_id)?.role).toBe('editor')
    expect((await api(editor, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
    await editor.reload()
    await editor.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const restoredTask = editor.locator('article').filter({ hasText: name })
    const enabled = editor.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await restoredTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await enabled).status()).toBe(200)
    expect((await api(editor, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const cancelRemoval = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: `移出 ${username}？`, exact: true }) })
    await cancelRemoval.getByRole('button', { name: '取消', exact: true }).click()
    await expect(memberRow).toBeVisible()
    expect((await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === editorMe.user_id)).toBe(true)

    await memberRow.getByRole('button', { name: '移出', exact: true }).click()
    const confirmRemoval = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: `移出 ${username}？`, exact: true }) })
    const removed = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/workspaces/current/members/${editorMe.user_id}`) && response.request().method() === 'PATCH')
    await confirmRemoval.getByRole('button', { name: '确定', exact: true }).click()
    expect((await removed).status()).toBe(200)
    await expect.poll(async () => (await api(page, 'GET', '/workspaces/current/members')).some((item: { user_id: string }) => item.user_id === editorMe.user_id)).toBe(false)
    const removedMemberMe = await context.request.get(`${baseURL}/api/v1/auth/me`)
    expect(removedMemberMe.status()).toBe(200)
    expect(((await removedMemberMe.json()) as { workspace: { id: string } }).workspace.id).not.toBe(ownerMe.workspace.id)
    const removedMemberRoutines = await context.request.get(`${baseURL}/api/v1/agent/routines`)
    expect(removedMemberRoutines.status()).toBe(200)
    expect(((await removedMemberRoutines.json()) as { items: unknown[] }).items).toHaveLength(0)

    const rejoinInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 })
    await editor.goto(`${baseURL}/settings/members`)
    await editor.getByPlaceholder('邀请码').fill(rejoinInvite.code)
    const rejoined = editor.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/workspaces/join' && response.request().method() === 'POST')
    const joinedWorkspaceHome = editor.waitForURL((url) => url.pathname === '/')
    await editor.getByRole('button', { name: '加入并切换', exact: true }).click()
    expect((await rejoined).status()).toBe(200)
    await joinedWorkspaceHome
    const rejoinedIdentity = await context.request.get(`${baseURL}/api/v1/auth/me`)
    expect(rejoinedIdentity.status()).toBe(200)
    expect(((await rejoinedIdentity.json()) as { workspace: { id: string } }).workspace.id).toBe(ownerMe.workspace.id)
    await editor.goto(`${baseURL}/agent`)
    await editor.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const afterRejoinTask = editor.locator('article').filter({ hasText: name })
    await expect(afterRejoinTask.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(afterRejoinTask.getByText(/重新加入并恢复编辑权限后，请手动重新启用此任务/)).toBeVisible()
    await expect(afterRejoinTask.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    expect((await api(editor, 'GET', '/notifications')).items.some((item: { kind: string; body: string }) => item.kind === 'agent_routine' && item.body.includes('已移出此工作区'))).toBe(true)
    const reenabled = editor.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await afterRejoinTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await reenabled).status()).toBe(200)
    await expect.poll(async () => (await api(editor, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
  } finally {
    await context.close()
  }
})

test('DEV-QA26 Web关闭工作区智能体后暂停例行任务并逐项恢复', async ({ page, baseURL }, testInfo) => {
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
  const toggleMetrics = { environment: 'Web Chromium; local mock API', sample_count: toggleSamples.length, samples: toggleSamples,
    p50_ms: sortedToggleSamples[9], p95_ms: sortedToggleSamples[18], failed: 0 }
  console.log(`DEV-QA26_METRIC_AGENT_TOGGLE_WEB ${JSON.stringify(toggleMetrics)}`)
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
})

test('DEV-QA26 Web停用例行任务模型后应立即暂停', async ({ page, baseURL }) => {
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
})

test('DEV-QA26 Web修改模型密钥后自检失败暂停例行任务并逐项恢复', async ({ page, baseURL }, testInfo) => {
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
  const toggleMetrics = { environment: 'Web Chromium; local mock API', sample_count: toggleSamples.length,
    samples_ms: toggleSamples, p50_ms: sortedSamples[9], p95_ms: sortedSamples[18], failed: 0 }
  console.log(`DEV-QA26_METRIC_ROUTINE_MODEL_CONFIG_WEB ${JSON.stringify(toggleMetrics)}`)
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
})

test('DEV-QA26 Web系统用户停用后暂停例行任务并逐项恢复', async ({ page, browser, baseURL }, testInfo) => {
  const startedAt = Date.now()
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  try {
    await prepareRoutine(page, baseURL!)
    const identity = await api(page, 'GET', '/auth/me')
    const username = identity.username as string
    const permissionStatus = await page.evaluate(async () => (await fetch('/api/v1/admin/users')).status)
    expect(permissionStatus).toBe(403)
    await page.goto(`${baseURL}/settings/admin`)
    await expect(page).toHaveURL(/\/settings\/accounts$/)

    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
    const name = `QA26 系统用户停用 ${Date.now()}`
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。')
    const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
    expect((await createdResponse).status()).toBe(200)
    const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
    expect(routine.status).toBe('enabled')
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible()

    await adminPage.goto(`${baseURL}/login`)
    await adminPage.getByLabel('用户名', { exact: true }).fill('skyeder')
    await adminPage.getByLabel('密码', { exact: true }).fill('local-e2e-admin-pass-456')
    const adminLogin = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await adminPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await adminLogin).status()).toBe(200)
    await adminPage.goto(`${baseURL}/settings/admin`)
    await expect(adminPage.getByText('用户', { exact: true })).toBeVisible()
    console.log('DEV-QA26_SYSTEM_USER_DISABLE_WEB checkpoint=admin-page-ready')
    const users = await api(adminPage, 'GET', '/admin/users')
    const target = users.find((item: { username: string }) => item.username === username)
    expect(target).toBeTruthy()
    expect(target.session_count).toBe(1)
    const userCard = adminPage.getByRole('heading', { name: '用户', exact: true })
      .locator('..').locator('..').locator('..')
    const userRow = userCard.getByRole('listitem').filter({ hasText: username })
    await expect(userRow).toBeVisible()
    await expect(userRow.getByText(/会话 1/)).toBeVisible()
    const disableButton = userRow.getByRole('button', { name: '禁用', exact: true })
    const disableResponse = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/admin/users/${target.id}` && response.request().method() === 'PATCH')
    await disableButton.click()
    expect((await disableResponse).status()).toBe(200)
    await expect(userRow.getByRole('button', { name: '启用', exact: true })).toBeVisible()
    await expect(userRow.getByText(/会话 0/)).toBeVisible()
    const disabledUser = (await api(adminPage, 'GET', '/admin/users')).find((item: { id: string }) => item.id === target.id)
    expect(disabledUser.disabled_at).toBeTruthy()
    expect(disabledUser.session_count).toBe(0)
    console.log('DEV-QA26_SYSTEM_USER_DISABLE_WEB checkpoint=user-disabled')
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(401)
    const enableButton = userRow.getByRole('button', { name: '启用', exact: true })
    const enableResponse = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/admin/users/${target.id}` && response.request().method() === 'PATCH')
    await enableButton.click()
    expect((await enableResponse).status()).toBe(200)
    await expect(userRow.getByRole('button', { name: '禁用', exact: true })).toBeVisible()
    const enabledUser = (await api(adminPage, 'GET', '/admin/users')).find((item: { id: string }) => item.id === target.id)
    expect(enabledUser.disabled_at).toBeFalsy()

    await page.goto(`${baseURL}/login`)
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    const userLogin = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    expect((await userLogin).status()).toBe(200)
    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const task = page.locator('article').filter({ hasText: name })
    await expect(task.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(task.getByText(/系统用户已停用；重新启用用户后，请手动重新启用此任务。/)).toBeVisible()
    await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
    await expect(task.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
    const paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
    expect(paused.status).toBe('paused')
    expect(paused.error_code).toBe('system_user_disabled')
    expect(paused.next_due_at).toBeFalsy()
    expect((await api(page, 'GET', '/notifications')).items.some((item: { kind: string; body: string; link: string }) => item.kind === 'agent_routine' && item.body.includes('系统用户已停用') && item.link.includes(routine.id))).toBe(true)
    console.log('DEV-QA26_SYSTEM_USER_DISABLE_WEB checkpoint=pause-persisted')
    await page.reload()
    await page.goto(`${baseURL}/agent`)
    await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
    const restoredTask = page.locator('article').filter({ hasText: name })
    const enabledRoutine = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
    await restoredTask.getByRole('button', { name: '重新启用', exact: true }).click()
    expect((await enabledRoutine).status()).toBe(200)
    expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id).status).toBe('enabled')

    const journeyMs = Date.now() - startedAt
    testInfo.attach('system-user-disable-journey.json', { body: JSON.stringify({ environment: 'Web Chromium; local mock API', journey_ms: journeyMs, failed: 0 }, null, 2), contentType: 'application/json' })
    console.log(`DEV-QA26_SYSTEM_USER_DISABLE_WEB ${JSON.stringify({ environment: 'Web Chromium; local mock API', journey_ms: journeyMs, failed: 0 })}`)
  } finally {
    await adminPage.close().catch(() => undefined)
    await adminContext.close().catch(() => undefined)
  }
})

test('DEV-QA26 Web修改模型接口地址后暂停例行任务并逐项恢复', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000)
  const journeyStarted = performance.now()
  await prepareRoutine(page, baseURL!)
  await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
  const createDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
  const name = `QA26 模型地址变更 ${Date.now()}`
  await createDialog.getByLabel('名称', { exact: true }).fill(name)
  await createDialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('只读核对测试账号并生成报告。')
  const createResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
  await createDialog.getByRole('button', { name: '创建并启用', exact: true }).click()
  expect((await createResponse).status()).toBe(200)
  const routine = (await api(page, 'GET', '/agent/routines')).items.find((item: { name: string }) => item.name === name)
  expect(routine.status).toBe('enabled')
  const provider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === routine.model.provider_id)
  expect(provider).toBeTruthy()
  const originalBaseURL = provider.base_url as string
  const alternate = new URL(originalBaseURL)
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(alternate.hostname)
  alternate.port = alternate.port === '8297' ? '8298' : '8297'
  const alternateBaseURL = alternate.toString().replace(/\/$/, '')

  await page.goto(`${baseURL}/settings/models`)
  const samples: number[] = []
  let failures = 0
  for (let index = 0; index < 20; index++) {
    try {
      const nextBaseURL = index % 2 === 0 ? alternateBaseURL : originalBaseURL
      const card = page.locator('div.group').filter({ hasText: provider.name })
      await card.getByRole('button', { name: '编辑', exact: true }).click()
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑模型供应商', exact: true }) })
      await dialog.getByLabel(/接口地址/).fill(nextBaseURL)
      const started = performance.now()
      const save = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}` && response.request().method() === 'PATCH')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      expect((await save).status()).toBe(200)
      const savedProvider = (await api(page, 'GET', '/model-providers')).find((item: { id: string }) => item.id === provider.id)
      expect(savedProvider.base_url).toBe(nextBaseURL)
      samples.push(performance.now() - started)

      if (index === 0) {
        expect(savedProvider.capabilities).toHaveLength(0)
        await expect.poll(async () => (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('paused')
        const paused = (await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)
        expect(paused).toMatchObject({ status: 'paused', error_code: 'model_unavailable' })
        expect(paused.next_due_at).toBeFalsy()
        expect((await api(page, 'GET', `/agent/routines/${routine.id}/occurrences`)).items).toHaveLength(0)
        expect((await api(page, 'GET', '/notifications')).items.some((item: { kind: string; body: string; link: string }) =>
          item.kind === 'agent_routine' && item.body.includes('任务模型不可用') && item.link.includes(routine.id))).toBe(true)
      }
    } catch (error) {
      failures++
      throw error
    }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const metrics = { environment: 'Web Chromium; local E2E API and loopback mock model', sample_count: samples.length,
    samples_ms: samples.map((value) => Number(value.toFixed(2))), p50_ms: Number(sorted[9].toFixed(2)), p95_ms: Number(sorted[18].toFixed(2)), failed: failures }
  await testInfo.attach('routine-model-url-20-samples.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
  console.log(`DEV-QA26_METRIC_ROUTINE_MODEL_URL_WEB ${JSON.stringify(metrics)}`)

  await page.reload()
  const providerCard = page.locator('div.group').filter({ hasText: provider.name })
  await providerCard.getByRole('button', { name: '编辑', exact: true }).click()
  let dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑模型供应商', exact: true }) })
  await expect(dialog.getByLabel(/接口地址/)).toHaveValue(originalBaseURL)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  const selftest = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/model-providers/${provider.id}/selftest` && response.request().method() === 'POST')
  await providerCard.getByRole('button', { name: '自检', exact: true }).click()
  const selftestResponse = await selftest
  expect(selftestResponse.status()).toBe(200)
  expect(await selftestResponse.json()).toMatchObject({ ok: true })
  dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '供应商能力自检', exact: true }) })
  await expect(dialog).toContainText('自检完成：7/7 项通过')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)).toMatchObject({ status: 'paused', error_code: 'model_unavailable' })

  await page.goto(`${baseURL}/agent`)
  await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
  const task = page.locator('article').filter({ hasText: name })
  await expect(task.getByText('已暂停', { exact: true })).toBeVisible()
  await expect(task.getByText(/任务模型不可用.*请手动重新启用此任务/)).toBeVisible()
  await expect(task.getByRole('button', { name: '立即运行一次', exact: true })).toHaveCount(0)
  const resume = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/routines/${routine.id}/control` && response.request().method() === 'POST')
  await task.getByRole('button', { name: '重新启用', exact: true }).click()
  expect((await resume).status()).toBe(200)
  expect((await api(page, 'GET', '/agent/routines')).items.find((item: { id: string }) => item.id === routine.id)?.status).toBe('enabled')
  const journeyMs = Number((performance.now() - journeyStarted).toFixed(2))
  console.log(`DEV-QA26_METRIC_ROUTINE_MODEL_URL_JOURNEY_WEB ${JSON.stringify({ environment: 'Web Chromium; local E2E API and loopback mock model', journey_ms: journeyMs, failed: 0 })}`)
})

