import { _electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount } from './support'

const password = 'local-e2e-password-123'
const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]

async function startSummaryModel() {
  let mode: 'short' | 'long' | 'failure' = 'short'
  const server = createServer((request, response) => {
    if (mode === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: '本地验收模型暂不可用' } }))
      return
    }
    const summary = mode === 'long'
      ? Array.from({ length: 130 }, () => '长').join('')
      : '这篇文章梳理了从真实经历提炼观点、说明做法并检查关键边界的过程。'
    const content = JSON.stringify({ summary })
    const chunk = JSON.stringify({ choices: [{ delta: { content } }] })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + chunk + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地验收模型没有可用监听地址')
  return {
    baseURL: 'http://127.0.0.1:' + address.port + '/v1',
    setMode(next: 'short' | 'long' | 'failure') { mode = next },
    close: () => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

async function makeWork(page: Parameters<typeof api>[0], accountId: string) {
  const title = 'QA26 摘要验收 ' + Date.now()
  const work = await api(page, 'POST', '/accounts/' + accountId + '/works', { title })
  const withViewpoint = await api(page, 'PATCH', '/works/' + work.id, {
    viewpoint: '先从真实经历提炼结论，再按读者能执行的顺序讲清做法。', base_revision: work.revision,
  })
  await api(page, 'PUT', '/works/' + work.id + '/outline', {
    items: [{ heading: '从经历到做法', key_point: '先说明真实背景，再给出可复用步骤', material_ids: [] }],
    confirm: true, base_revision: withViewpoint.revision,
  })
  const outlined = await api(page, 'GET', '/works/' + work.id)
  await api(page, 'PATCH', '/sections/' + outlined.sections[0].id, {
    content_md: '这是一段用于本地摘要流程验收的正文。先写清经历，再说明读者可以照做的具体步骤。',
    base_revision: outlined.sections[0].revision,
  })
  return { id: work.id as string, title }
}

async function configureSummaryModel(page: Parameters<typeof api>[0], baseURL: string) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'DEV-QA26 本地摘要契约模型 ' + Date.now(), base_url: baseURL,
    api_key: 'qa26-local-only-placeholder', models: ['qa26-summary'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'summary', provider_id: provider.id, model: 'qa26-summary' }])
}

test('DEV-QA26 G4-08 真实 Electron 摘要生成、120字边界、错误与 editor 持久化', async ({ page, baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(300_000)
  const username = 'qa26-g408-owner-' + Date.now()
  const account = await registerAccount(page, '长图文', 'wechat_mp', username)
  const work = await makeWork(page, account.id)
  const before = await api(page, 'GET', '/works/' + work.id)
  expect(before.summary).toBe('')
  const model = await startSummaryModel()
  await configureSummaryModel(page, model.baseURL)

  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g408-owner-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let editorProfile = ''
  let editorApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + profile, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(baseURL + '/login')
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async accountId => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem('ops.currentAccount.v2:' + (me.user_id ?? me.username) + ':' + me.workspace.id, accountId)
    }, account.id)
    await native.goto(baseURL + '/works/' + work.id)
    await native.getByRole('link', { name: '标题与摘要', exact: true }).click()
    await native.getByRole('button', { name: '标题、摘要与配图', exact: true }).click()
    const titleDetails = native.locator('details.desktop-title-extras')
    await expect(titleDetails).toBeVisible()
    if (await titleDetails.getAttribute('open') === null) await titleDetails.locator('summary').click()
    const summaryField = native.getByRole('textbox', { name: /摘要/ })
    const generateButton = titleDetails.getByRole('button', { name: '生成', exact: true })
    await expect(summaryField).toHaveValue('')
    await expect(titleDetails.getByText(/0\s*\/\s*120/)).toBeVisible()

    const latencies: number[] = []
    const expected = '这篇文章梳理了从真实经历提炼观点、说明做法并检查关键边界的过程。'
    for (let index = 0; index < 20; index++) {
      const started = performance.now()
      const generated = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
      const saved = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
      await generateButton.click()
      const generation = await generated
      expect(generation.status(), await generation.text()).toBe(200)
      const result = await generation.json()
      expect(result.summary).toBe(expected)
      expect(result.truncated).toBe(false)
      const save = await saved
      expect(save.status(), await save.text()).toBe(200)
      expect(save.request().postDataJSON()).toEqual(expect.objectContaining({ summary: expected }))
      await expect(summaryField).toHaveValue(expected)
      const persisted = await api(page, 'GET', '/works/' + work.id)
      expect(persisted.summary).toBe(expected)
      expect(Array.from(persisted.summary).length).toBeLessThanOrEqual(120)
      latencies.push(performance.now() - started)
    }
    const p50 = percentile(latencies, 0.5)
    const p95 = percentile(latencies, 0.95)
    console.log('DEV-QA26 G4-08 Electron 摘要生成+PATCH+GET：n=' + latencies.length + ' p50=' + p50.toFixed(2) + 'ms p95=' + p95.toFixed(2) + 'ms failures=0')
    await testInfo.attach('g4-08-electron-summary-latencies', { body: JSON.stringify({ samples: latencies, p50, p95, failures: 0 }), contentType: 'application/json' })

    model.setMode('long')
    const boundaryGeneration = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    const boundarySave = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await generateButton.click()
    const boundary = await boundaryGeneration
    const boundaryResult = await boundary.json()
    expect(boundaryResult.truncated).toBe(true)
    expect(Array.from(boundaryResult.summary).length).toBe(120)
    expect((await boundarySave).status()).toBe(200)
    await expect(summaryField).toHaveValue('长'.repeat(120))
    await expect(native.getByText('AI 写的摘要超过 120 字，已截断，请检查结尾', { exact: true })).toBeVisible()
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe('长'.repeat(120))

    const savedBeforeManual = await api(page, 'GET', '/works/' + work.id)
    let patchCount = 0
    native.on('request', request => {
      if (request.url().endsWith('/api/v1/works/' + work.id) && request.method() === 'PATCH') patchCount++
    })
    await summaryField.fill('手'.repeat(121))
    await expect(titleDetails.getByText(/121\s*\/\s*120/)).toBeVisible()
    await summaryField.press('Tab')
    await native.waitForTimeout(250)
    expect(patchCount, '121字摘要不得提交 PATCH').toBe(0)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(savedBeforeManual.summary)
    await summaryField.fill('手'.repeat(120))
    const manualSave = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await summaryField.press('Tab')
    expect((await manualSave).status()).toBe(200)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe('手'.repeat(120))

    const beforeModelFailure = await api(page, 'GET', '/works/' + work.id)
    model.setMode('failure')
    const patchCountBeforeAIError = patchCount
    const failedGeneration = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    await generateButton.click()
    expect((await failedGeneration).status()).toBeGreaterThanOrEqual(500)
    await expect(native.getByText('生成摘要失败', { exact: true })).toBeVisible()
    expect(patchCount).toBe(patchCountBeforeAIError)
    await expect(summaryField).toHaveValue(beforeModelFailure.summary)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(beforeModelFailure.summary)

    model.setMode('short')
    const saveFailureSummary = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    const workRoute = '**/api/v1/works/' + work.id
    await native.route(workRoute, async route => {
      if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '本地模拟保存失败' } }) })
      else await route.continue()
    })
    const failedSave = native.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await generateButton.click()
    expect((await saveFailureSummary).status()).toBe(200)
    expect((await failedSave).status()).toBe(503)
    await expect(native.getByText(/本地模拟保存失败/)).toBeVisible()
    await expect(summaryField).toHaveValue(expected)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(beforeModelFailure.summary)
    await native.unroute(workRoute)
    await native.reload()
    await native.getByRole('link', { name: '标题与摘要', exact: true }).click()
    await native.getByRole('button', { name: '标题、摘要与配图', exact: true }).click()
    const reloadedDetails = native.locator('details.desktop-title-extras')
    if (await reloadedDetails.getAttribute('open') === null) await reloadedDetails.locator('summary').click()
    await expect(native.getByRole('textbox', { name: /摘要/ })).toHaveValue(beforeModelFailure.summary)

    const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 }) as { code: string }
    editorProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g408-editor-'))
    editorApp = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + editorProfile, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const editor = await editorApp.firstWindow()
    const editorUsername = 'qa26-g408-editor-' + Date.now()
    await editor.goto(baseURL + '/register')
    await editor.getByLabel('用户名', { exact: true }).fill(editorUsername)
    await editor.getByLabel('密码（至少 12 位）').fill(password)
    await editor.getByLabel('邀请码（可选）').fill(editorInvite.code)
    await editor.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => editor.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const editorMe = await editor.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { user_id: string; username: string; workspace: { id: string }; role: string }
    expect(editorMe.role).toBe('editor')
    await editor.evaluate(({ accountId, userId, workspaceId }) => {
      localStorage.setItem('ops.currentAccount.v2:' + userId + ':' + workspaceId, accountId)
    }, { accountId: account.id, userId: editorMe.user_id, workspaceId: editorMe.workspace.id })
    await editor.goto(baseURL + '/works/' + work.id)
    await editor.getByRole('link', { name: '标题与摘要', exact: true }).click()
    await editor.getByRole('button', { name: '标题、摘要与配图', exact: true }).click()
    const editorDetails = editor.locator('details.desktop-title-extras')
    if (await editorDetails.getAttribute('open') === null) await editorDetails.locator('summary').click()
    await expect(editor.getByRole('button', { name: '生成', exact: true })).toBeVisible()
    const editorGeneration = editor.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    const editorSave = editor.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await editorDetails.getByRole('button', { name: '生成', exact: true }).click()
    expect((await editorGeneration).status()).toBe(200)
    expect((await editorSave).status()).toBe(200)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(expected)
  } finally {
    await model.close()
    if (editorApp) {
      try { execFileSync('taskkill', ['/PID', String(editorApp.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await editorApp.close().catch(() => undefined)
    }
    if (editorProfile) {
      if (!resolve(editorProfile).startsWith(resolve(tmpdir()) + '\\') || !editorProfile.includes('ops-qa26-g408-editor-')) throw new Error('拒绝清理测试目录之外路径')
      await rm(editorProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本测试创建的 Electron。 */ }
      await app.close().catch(() => undefined)
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g408-owner-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
