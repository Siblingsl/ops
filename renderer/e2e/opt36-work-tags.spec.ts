import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount } from './support'

const password = 'local-e2e-password-123'
const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]

test('DEV-QA26 G4-16 真实 Electron 标签保存、失败/取消、筛选视图、搜索与 editor', async ({ page, baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)

  const username = `qa26-opt36-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username)
  const title = `QA26 OPT36 Electron 标签 ${Date.now()}`
  const otherTitle = `QA26 OPT36 Electron 另一标签 ${Date.now()}`
  const first = await api(page, 'POST', `/accounts/${account.id}/works`, { title })
  const other = await api(page, 'POST', `/accounts/${account.id}/works`, { title: otherTitle })
  await api(page, 'PATCH', `/works/${first.id}`, { tags: ['QA26主题A'], viewpoint: '标签修改不应改变作品正文和检查状态。' })
  await api(page, 'PATCH', `/works/${other.id}`, { tags: ['QA26主题B'] })
  const before = await api(page, 'GET', `/works/${first.id}`)

  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-opt36-owner-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let editorProfile = ''
  let editorApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)

    const journeyStartedAt = Date.now()
    await native.goto(`${baseURL}/a/${account.id}/works`)
    const rows = native.getByTestId('desktop-work-row')
    const firstRow = rows.filter({ hasText: title })
    await expect(firstRow).toBeVisible()
    let patchRequests = 0
    native.on('request', request => {
      if (request.url().endsWith(`/api/v1/works/${first.id}`) && request.method() === 'PATCH') patchRequests++
    })

    await firstRow.getByRole('button', { name: '编辑作品标签' }).click()
    let dialog = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '编辑作品标签', exact: true }) })
    await dialog.getByLabel('新增标签').fill('QA26取消标签')
    await dialog.getByRole('button', { name: '添加', exact: true }).click()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(patchRequests, '取消编辑不得发出标签写入').toBe(0)
    expect((await api(page, 'GET', `/works/${first.id}`)).tags).toEqual(['QA26主题A'])

    await firstRow.getByRole('button', { name: '编辑作品标签' }).click()
    dialog = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '编辑作品标签', exact: true }) })
    await dialog.getByRole('button', { name: '移除标签 QA26主题A' }).click()
    await dialog.getByLabel('新增标签').fill('QA26主题C')
    await dialog.getByRole('button', { name: '添加', exact: true }).click()
    const workRoute = `**/api/v1/works/${first.id}`
    await native.route(workRoute, async route => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟标签保存暂不可用' }) })
      } else await route.continue()
    })
    const rejectedSave = native.waitForResponse(response => response.url().endsWith(`/api/v1/works/${first.id}`) && response.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: '保存标签', exact: true }).click()
    expect((await rejectedSave).status()).toBe(503)
    await expect(dialog).toBeVisible()
    const afterRejectedSave = await api(page, 'GET', `/works/${first.id}`)
    expect(afterRejectedSave.tags).toEqual(['QA26主题A'])
    expect(afterRejectedSave.revision).toBe(before.revision)
    await native.unroute(workRoute)

    const successfulSave = native.waitForResponse(response => response.url().endsWith(`/api/v1/works/${first.id}`) && response.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: '保存标签', exact: true }).click()
    const saveResponse = await successfulSave
    expect(saveResponse.status(), await saveResponse.text()).toBe(200)
    expect(saveResponse.request().postDataJSON()).toEqual({ tags: ['QA26主题C'] })
    await expect(native.getByText('标签已保存', { exact: true })).toBeVisible()
    const saved = await api(page, 'GET', `/works/${first.id}`)
    expect(saved.tags).toEqual(['QA26主题C'])
    expect(saved.revision).toBe(before.revision)
    expect(saved.status).toBe(before.status)
    expect(saved.sections).toEqual(before.sections)

    await native.reload()
    await expect(firstRow).toContainText('QA26主题C')
    const tagFilter = native.getByLabel('按标签筛选')
    await tagFilter.selectOption('QA26主题C')
    await expect.poll(() => new URL(native.url()).searchParams.get('tag')).toBe('QA26主题C')
    await expect(rows.filter({ hasText: title })).toBeVisible()
    await expect(rows.filter({ hasText: otherTitle })).toHaveCount(0)
    await native.reload()
    await expect(tagFilter).toHaveValue('QA26主题C')
    await expect(rows.filter({ hasText: title })).toBeVisible()

    await native.getByRole('button', { name: '保存当前筛选为视图' }).click()
    await native.getByPlaceholder('视图名称').fill('QA26标签视图')
    await native.getByRole('button', { name: '保存', exact: true }).click()
    const savedView = native.getByRole('button', { name: 'QA26标签视图', exact: true })
    await expect(savedView).toBeVisible()

    await tagFilter.selectOption('QA26主题B')
    await expect(rows.filter({ hasText: otherTitle })).toBeVisible()
    await savedView.click()
    await expect.poll(() => new URL(native.url()).searchParams.get('tag')).toBe('QA26主题C')
    await expect(rows.filter({ hasText: title })).toBeVisible()
    await native.reload()
    await expect(savedView).toBeVisible()
    await expect(tagFilter).toHaveValue('QA26主题C')

    const latencies: number[] = []
    for (let index = 0; index < 20; index++) {
      const selectedTag = index % 2 === 0 ? 'QA26主题C' : 'QA26主题B'
      const expectedTitle = index % 2 === 0 ? title : otherTitle
      const hiddenTitle = index % 2 === 0 ? otherTitle : title
      const started = Date.now()
      await tagFilter.selectOption(selectedTag)
      await expect.poll(() => new URL(native.url()).searchParams.get('tag')).toBe(selectedTag)
      await expect(rows.filter({ hasText: expectedTitle })).toBeVisible()
      await expect(rows.filter({ hasText: hiddenTitle })).toHaveCount(0)
      latencies.push(Date.now() - started)
    }
    console.log(`G4-16 Electron 标签筛选：n=${latencies.length} p50=${percentile(latencies, 0.5)}ms p95=${percentile(latencies, 0.95)}ms failures=0`)
    await testInfo.attach('g4-16-electron-tag-filter-latencies', { body: JSON.stringify({ samples: latencies, failures: 0 }), contentType: 'application/json' })

    await tagFilter.selectOption('QA26主题C')
    await native.getByRole('button', { name: /用户菜单/ }).click()
    await native.getByRole('menuitem', { name: /搜索与命令/ }).click()
    const palette = native.getByRole('dialog', { name: '命令面板' })
    const paletteSearch = palette.getByPlaceholder('搜索作品、选题、素材，或输入命令（支持拼音首字母）')
    const searchResponse = native.waitForResponse(response => {
      if (!response.url().includes('/api/v1/search')) return false
      return new URL(response.url()).searchParams.get('q') === 'QA26主题C'
    })
    await paletteSearch.fill('QA26主题C')
    const search = await searchResponse
    expect(search.ok()).toBeTruthy()
    const hits = await search.json()
    expect(hits.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'work', id: first.id, title, snippet: 'QA26主题C' })]))
    await expect(palette.getByRole('button', { name: new RegExp(title) })).toBeVisible()
    await palette.press('Escape')

    const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 }) as { code: string }
    const editorUsername = `qa26-opt36-editor-${Date.now()}`
    editorProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-opt36-editor-'))
    editorApp = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${editorProfile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const editor = await editorApp.firstWindow()
    await editor.goto(`${baseURL}/register`)
    await editor.getByLabel('用户名', { exact: true }).fill(editorUsername)
    await editor.getByLabel('密码（至少 12 位）').fill(password)
    await editor.getByLabel('邀请码（可选）').fill(editorInvite.code)
    await editor.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => editor.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const editorMe = await editor.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as { user_id: string; username: string; workspace: { id: string }; role: string }
    expect(editorMe.role).toBe('editor')
    await editor.evaluate(({ accountId, userId, workspaceId }) => {
      localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, accountId)
    }, { accountId: account.id, userId: editorMe.user_id, workspaceId: editorMe.workspace.id })
    await editor.goto(`${baseURL}/a/${account.id}/works`)
    const editorRow = editor.getByTestId('desktop-work-row').filter({ hasText: title })
    await expect(editorRow.getByRole('button', { name: '编辑作品标签' })).toBeVisible()
    await editorRow.getByRole('button', { name: '编辑作品标签' }).click()
    const editorDialog = editor.getByRole('dialog').filter({ has: editor.getByRole('heading', { name: '编辑作品标签', exact: true }) })
    await editorDialog.getByLabel('新增标签').fill('QA26编辑者标签')
    await editorDialog.getByRole('button', { name: '添加', exact: true }).click()
    const editorSave = editor.waitForResponse(response => response.url().endsWith(`/api/v1/works/${first.id}`) && response.request().method() === 'PATCH')
    await editorDialog.getByRole('button', { name: '保存标签', exact: true }).click()
    expect((await editorSave).status()).toBe(200)
    const editorPersisted = await api(page, 'GET', `/works/${first.id}`)
    expect(editorPersisted.tags).toEqual(['QA26主题C', 'QA26编辑者标签'])
    expect(editorPersisted.revision).toBe(before.revision)
    expect(editorPersisted.sections).toEqual(before.sections)
    console.log(`G4-16 Electron 标签保存/筛选/搜索/editor旅程 ${(Date.now() - journeyStartedAt) / 1000}s`)
  } finally {
    if (editorApp) {
      try { execFileSync('taskkill', ['/PID', String(editorApp.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([editorApp.close().catch(() => undefined), new Promise(done => setTimeout(done, 2_000))])
    }
    if (editorProfile) {
      if (!resolve(editorProfile).startsWith(resolve(tmpdir()) + '\\') || !editorProfile.includes('ops-qa26-opt36-editor-')) throw new Error('拒绝清理测试目录之外路径')
      await rm(editorProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本测试创建的 Electron。 */ }
      await app.close().catch(() => undefined)
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-opt36-owner-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
