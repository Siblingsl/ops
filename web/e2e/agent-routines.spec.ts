import { expect, test, type Page } from '@playwright/test'
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

async function prepareRoutine(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw10-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW10 例行任务验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW10 工作台 mock 模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-agent-tested'],
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

