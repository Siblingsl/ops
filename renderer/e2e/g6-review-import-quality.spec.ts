import { _electron, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, createOutline, registerAccount, selectDesktopSetting } from './support'

const password = 'local-e2e-password-123'
type ElectronApp = Awaited<ReturnType<typeof _electron.launch>>

async function launchG6Electron(baseURL: string, username: string, tag: string, inviteCode?: string) {
  const profile = await mkdtemp(join(tmpdir(), `ops-qa26-g6-${tag}-`))
  let app: ElectronApp | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/login`)
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    if (inviteCode) await page.getByLabel('邀请码（可选）').fill(inviteCode)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    return { app, page, profile }
  } catch (error) {
    await closeG6Electron(app, profile, tag)
    throw error
  }
}

async function closeG6Electron(app: ElectronApp | undefined, profile: string, tag: string) {
  if (app) {
    try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
    await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
  }
  const resolved = resolve(profile)
  if (!resolved.startsWith(resolve(tmpdir()) + '\\') || !profile.includes(`ops-qa26-g6-${tag}-`)) throw new Error('拒绝清理测试目录之外路径')
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function localDateInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function addLocalModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: `DEV-QA26 G6 本地模型 ${Date.now()}`,
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
    api_key: 'local-qa26-g6-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', ['outline', 'fact_flag', 'review_analysis'].map((task_type) => ({
    task_type, provider_id: provider.id, model: 'mock-writer',
  })))
}

async function enterTitleAndBody(native: Page, page: Page, workID: string, origin: string, title = `QA26复盘CSV-${Date.now()}`) {
  const titleInput = native.locator('#step-title input').first()
  await titleInput.fill(title)
  await titleInput.press('Tab')
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).title).toBe(title)

  const work = await api(page, 'GET', `/works/${workID}`) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `第 ${index + 1} 段先记录可核对的事实，再说明下一步如何验证。`, base_revision: section.revision,
    })
  }
  await native.goto(`${origin}/works/${workID}`)
  return title
}

async function finishChecksInElectron(native: Page, page: Page, workID: string, origin: string) {
  await native.goto(`${origin}/works/${workID}/check`)
  const initial = await api(page, 'GET', `/works/${workID}/checks/latest`)
  if (!initial.run) await native.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      if (item.category === 'ai_disclosure') {
        const checkbox = native.getByRole('checkbox', { name: '已知悉，发布时会声明' })
        if (!(await checkbox.isChecked())) await checkbox.click()
      } else {
        await native.locator(`input[name="${item.id}"]`).first().check()
      }
    }
  }
  await native.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('ready')
}

async function packAndMarkPublished(native: Page, page: Page, workID: string, origin: string, daysAgo = 8) {
  await native.goto(`${origin}/works/${workID}/pack`)
  await native.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(native.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60_000)
  const backfill = native.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill('https://example.invalid/qa26-local-review')
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = native.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${workID}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('published')
  const work = await api(page, 'GET', `/works/${workID}`)
  expect(work.published_url).toBe('https://example.invalid/qa26-local-review')
  return { publishedAt, capturedAt: new Date(publishedAt.getTime() + 7 * 24 * 60 * 60_000) }
}

async function packXhsAndMarkPublished(native: Page, page: Page, workID: string, origin: string, daysAgo: number) {
  await native.goto(`${origin}/works/${workID}/pack`)
  await native.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(native.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60_000)
  const publishedURL = `https://example.invalid/qa26-local-review-${workID}`
  const backfill = native.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill(publishedURL)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = native.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${workID}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('published')
  return (await api(page, 'GET', `/works/${workID}`)).published_at as string
}

async function createPublishedXhsWork(native: Page, page: Page, accountID: string, title: string, origin: string) {
  await native.goto(`${origin}/a/${accountID}`)
  const workID = await createOutline(native)
  const work = await api(page, 'GET', `/works/${workID}`) as { revision: number }
  await api(page, 'PATCH', `/works/${workID}`, { title, base_revision: work.revision })
  const imageData = await native.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d9e8ee'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me') as { csrf_token: string }
  const uploaded = await native.evaluate(async ({ id, image, csrf }) => {
    const bytes = Uint8Array.from(atob(image), (character) => character.charCodeAt(0))
    const form = new FormData()
    form.append('file', new File([bytes], 'qa26-editor-import.png', { type: 'image/png' }))
    const response = await fetch(`/api/v1/works/${id}/assets`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    })
    return { status: response.status, body: await response.text() }
  }, { id: workID, image: imageData, csrf: me.csrf_token })
  expect(uploaded.status, uploaded.body).toBe(200)
  const sections = (await api(page, 'GET', `/works/${workID}`)).sections as Array<{ id: string; revision: number }>
  for (const [index, section] of sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `第 ${index + 1} 段先记录可核对的事实，再说明下一步如何验证。`, base_revision: section.revision,
    })
  }
  await finishChecksInElectron(native, page, workID, origin)
  const publishedAt = await packXhsAndMarkPublished(native, page, workID, origin, 8)
  return { workID, publishedAt }
}

test('DEV-QA26 G6 真实 Electron 编辑者可预览 CSV 且观察者被拒绝', async ({ page, browser, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const username = `qa26-g6-viewer-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g6-viewer-owner-${Date.now()}`)
  const title = `QA26编辑者导入-${Date.now()}`
  const publishedWork = await createPublishedXhsWork(page, page, account.id, title, baseURL!)
  const ownerUsername = (await api(page, 'GET', '/auth/me') as { username: string }).username
  const owner = await launchG6Electron(baseURL!, ownerUsername, 'viewer-owner')
  let viewerContext: BrowserContext | undefined
  let viewerApp: ElectronApp | undefined
  let viewerProfile = ''
  let editorApp: ElectronApp | undefined
  let editorProfile = ''
  try {
    await owner.page.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)
    await owner.page.goto(`${baseURL}/a/${account.id}`)
    await owner.page.getByRole('button', { name: /用户菜单/ }).click()
    await owner.page.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(owner.page, '成员与邀请')
    const settings = owner.page.getByTestId('desktop-settings-window')
    await settings.getByRole('combobox').last().selectOption('viewer')
    const inviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const invite = await (await inviteResponse).json() as { code: string; role: string }
    expect(invite.role).toBe('viewer')

    viewerContext = await browser.newContext({ baseURL: new URL(baseURL!).origin })
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username, password, invite_code: invite.code },
    })
    expect(joined.ok(), '使用真实 Electron 界面生成的邀请码注册观察者').toBeTruthy()
    const viewer = await launchG6Electron(baseURL!, username, 'viewer-client', invite.code)
    viewerApp = viewer.app
    viewerProfile = viewer.profile
    await viewer.page.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)
    await viewer.page.goto(`${baseURL}/a/${account.id}/review`)
    await expect.poll(() => viewer.page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
    await viewer.page.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    await expect(viewer.page.getByRole('button', { name: '导入表格（CSV）', exact: true })).toHaveCount(0)

    const denied = await viewer.page.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const form = new FormData()
      form.append('file', new File(['标题,阅读\n无作品,1'], 'viewer-denied.csv', { type: 'text/csv' }))
      const response = await fetch(`/api/v1/accounts/${accountID}/metrics/import`, {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form,
      })
      return { status: response.status, body: await response.text() }
    }, account.id)
    expect(denied.status).toBe(403)
    expect(denied.body).toContain('观察者仅可浏览，不能修改内容')
    expect(await api(page, 'GET', `/works/${publishedWork.workID}/metrics`)).toHaveLength(0)

    await settings.getByRole('combobox').last().selectOption('editor')
    const editorInviteResponse = owner.page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await settings.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const editorInvite = await (await editorInviteResponse).json() as { code: string; role: string }
    expect(editorInvite.role).toBe('editor')
    const editorUsername = `qa26-g6-editor-${Date.now()}`
    const editorJoined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: editorUsername, password, invite_code: editorInvite.code },
    })
    expect(editorJoined.ok(), '使用真实 Electron 界面生成的邀请码注册编辑者').toBeTruthy()
    const editor = await launchG6Electron(baseURL!, editorUsername, 'editor-client', editorInvite.code)
    editorApp = editor.app
    editorProfile = editor.profile
    await editor.page.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)
    await editor.page.goto(`${baseURL}/a/${account.id}/review`)
    await expect.poll(() => editor.page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('editor')
    await editor.page.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    await expect(editor.page.getByRole('button', { name: '导入表格（CSV）', exact: true })).toBeVisible()
    const editorPreviewResponse = editor.page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    const capturedAt = new Date(Date.parse(publishedWork.publishedAt) + 7 * 24 * 60 * 60_000).toISOString()
    await uploadCsv(editor.page, 'editor-confirm.csv', ['标题,发布时间,统计时间,阅读', `"${title}",${publishedWork.publishedAt},${capturedAt},321`].join('\n'))
    const editorPreviewResult = await editorPreviewResponse
    expect(editorPreviewResult.status()).toBe(200)
    const editorPreview = editor.page.getByRole('dialog').filter({ has: editor.page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    await expect(editorPreview).toBeVisible()
    expect(((await editorPreviewResult.json()) as { preview: Array<{ work_id: string }> }).preview[0].work_id).toBe(publishedWork.workID)
    const saved = editor.page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await editorPreview.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await saved).ok()).toBeTruthy()
    expect(await api(page, 'GET', `/works/${publishedWork.workID}/metrics`)).toMatchObject([
      { source: 'file', reads: 321, day_offset: 7 },
    ])
  } finally {
    if (editorApp) await closeG6Electron(editorApp, editorProfile, 'editor-client')
    if (viewerApp) await closeG6Electron(viewerApp, viewerProfile, 'viewer-client')
    await viewerContext?.close()
    await closeG6Electron(owner.app, owner.profile, 'viewer-owner')
  }
})

test('DEV-QA26 G6 真实 Electron 同名 CSV 需人工消歧并可按发布时间匹配', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(240_000)
  const username = `qa26-g6-duplicate-${Date.now()}`
  const account = await registerAccount(page, '图文笔记', 'xhs', username)
  await addLocalModel(page)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g6-electron-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)

    const duplicateTitle = `QA26同名CSV-${Date.now()}`
    const imageData = await native.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const context = canvas.getContext('2d')!
      context.fillStyle = '#d9e8ee'
      context.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const workIDs: string[] = []
    for (const daysAgo of [20, 8]) {
      await native.goto(`${baseURL}/a/${account.id}`)
      const workID = await createOutline(native)
      workIDs.push(workID)
      const editable = await api(page, 'GET', `/works/${workID}`) as { revision: number }
      await api(page, 'PATCH', `/works/${workID}`, { title: duplicateTitle, base_revision: editable.revision })
      const me = await api(page, 'GET', '/auth/me') as { csrf_token: string }
      const uploaded = await page.evaluate(async ({ id, image, csrf }) => {
        const bytes = Uint8Array.from(atob(image), (character) => character.charCodeAt(0))
        const form = new FormData()
        form.append('file', new File([bytes], 'qa26-duplicate.png', { type: 'image/png' }))
        const response = await fetch(`/api/v1/works/${id}/assets`, {
          method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
        })
        return { status: response.status, body: await response.text() }
      }, { id: workID, image: imageData, csrf: me.csrf_token })
      expect(uploaded.status, uploaded.body).toBe(200)
      const sections = (await api(page, 'GET', `/works/${workID}`)).sections as Array<{ id: string; revision: number }>
      for (const [index, section] of sections.entries()) {
        await api(page, 'PATCH', `/sections/${section.id}`, {
          content_md: `第 ${index + 1} 段先记录可核对的事实，再说明下一步如何验证。`, base_revision: section.revision,
        })
      }
      await native.goto(`${baseURL}/works/${workID}`)
      await finishChecksInElectron(native, page, workID, baseURL!)
      await packXhsAndMarkPublished(native, page, workID, baseURL!, daysAgo)
    }
    const savedWorks = await Promise.all(workIDs.map(async (id) => await api(page, 'GET', `/works/${id}`) as { published_at: string }))
    const capturedAt = (publishedAt: string) => new Date(Date.parse(publishedAt) + 7 * 24 * 60 * 60_000).toISOString()

    await native.goto(`${baseURL}/a/${account.id}/review`)
    await native.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    const noDateCSV = ['标题,统计时间,阅读', `"${duplicateTitle}",${capturedAt(savedWorks[0].published_at)},101`].join('\n')
    const noDateResponse = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-duplicate-no-date.csv', noDateCSV)
    const noDatePreview = await (await noDateResponse).json() as { preview: Array<{ work_id: string | null; matched: boolean }> }
    expect(noDatePreview.preview[0].work_id, '没有发布时间时不能猜测同名作品').toBeNull()
    const manual = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    const choice = manual.getByRole('combobox').first()
    const options = await choice.locator('option').allTextContents()
    const duplicateOptions = options.filter((label) => label.includes(duplicateTitle))
    expect(duplicateOptions).toHaveLength(2)
    expect(new Set(duplicateOptions).size).toBe(2)
    expect(await choice.inputValue()).toBe('')
    await choice.selectOption(workIDs[0])
    const manualImport = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await manual.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await manualImport).ok()).toBeTruthy()
    expect(await api(page, 'GET', `/works/${workIDs[0]}/metrics`)).toHaveLength(1)
    expect(await api(page, 'GET', `/works/${workIDs[1]}/metrics`)).toHaveLength(0)

    const datedCSV = ['标题,发布时间,统计时间,阅读', `"${duplicateTitle}",${savedWorks[1].published_at},${capturedAt(savedWorks[1].published_at)},202`].join('\n')
    const datedResponse = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-duplicate-published-at.csv', datedCSV)
    const datedPreview = await (await datedResponse).json() as { preview: Array<{ work_id: string | null; matched: boolean }> }
    expect(datedPreview.preview[0].work_id).toBe(workIDs[1])
    const dated = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    const datedImport = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await dated.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await datedImport).ok()).toBeTruthy()
    expect(await api(page, 'GET', `/works/${workIDs[1]}/metrics`)).toHaveLength(1)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g6-electron-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function uploadCsv(native: Page, name: string, csv: string, mimeType = 'text/csv') {
  const chooser = native.waitForEvent('filechooser')
  await native.getByRole('button', { name: '导入表格（CSV）', exact: true }).click()
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(csv, 'utf8') })
}

test('DEV-QA26 G6 真实 Electron CSV 确认、复盘反馈与只读权限', async ({ page, browser, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(240_000)
  const username = `qa26-g6-electron-${Date.now()}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  await addLocalModel(page)

  const profilePrefix = join(tmpdir(), 'ops-qa26-g6-electron-')
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}`)
    const workID = await createOutline(native)
    const title = await enterTitleAndBody(native, page, workID, baseURL!)
    await finishChecksInElectron(native, page, workID, baseURL!)
    const { capturedAt } = await packAndMarkPublished(native, page, workID, baseURL!)

    await native.goto(`${baseURL}/a/${account.id}/review`)
    await native.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    const review = native.locator('#desktop-review-advanced')
    await expect(review.getByRole('heading', { name: 'AI 复盘', exact: true })).toBeVisible()
    await review.getByLabel(/使用增强复盘/).uncheck()
    const wrongType = native.waitForResponse((response) => response.url().endsWith('/api/v1/accounts/' + account.id + '/metrics/import') && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-not-csv.txt', '标题,阅读\n"' + title + '",123', 'text/plain')
    expect((await wrongType).status()).toBe(422)
    await expect(native.getByText(/请上传 CSV 文件/)).toBeVisible()
    expect(await api(page, 'GET', '/works/' + workID + '/metrics')).toHaveLength(0)
    const badCsv = [
      '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
      `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
      `"不存在的作品",${capturedAt.toISOString()},bad,100,2,1,0,0,0`,
    ].join('\n')
    const parseResponse = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-invalid-row.csv', badCsv)
    expect((await parseResponse).ok()).toBeTruthy()
    const preview = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    await expect(preview).toBeVisible()
    await expect(preview.getByText('已精确匹配', { exact: true })).toBeVisible()
    await expect(preview.getByText(/无法解析：bad/)).toBeVisible()
    await preview.getByRole('button', { name: '取消', exact: true }).click()
    expect(await api(page, 'GET', `/works/${workID}/metrics`)).toHaveLength(0)

    const validCsv = [
      '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
      `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
    ].join('\n')
    const validPreviewResponse = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-valid.csv', validCsv)
    expect((await validPreviewResponse).ok()).toBeTruthy()
    const confirmedPreview = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    await expect(confirmedPreview.getByText(title, { exact: true })).toBeVisible()
    const imported = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await confirmedPreview.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await imported).ok()).toBeTruthy()
    await expect(native.getByText('已导入 1 行', { exact: true })).toBeVisible()
    const savedMetrics = await api(page, 'GET', `/works/${workID}/metrics`)
    expect(savedMetrics).toHaveLength(1)
    expect(savedMetrics[0]).toMatchObject({ source: 'file', reads: 12000, impressions: 33000, likes: 36, favorites: 8, day_offset: 7 })
    const boardRow = native.getByTestId('desktop-review-table').getByRole('row').filter({ hasText: title })
    await expect(boardRow).toContainText('1.2万')
    await expect(boardRow).toContainText('33,000')

    const reportPost = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
    await review.getByRole('button', { name: '生成复盘报告', exact: true }).first().click()
    expect((await reportPost).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`)).length).toBe(1)
    const report = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0] as {
      id: string; work_ids: string[]; adopted: number[]; ignored: number[]
      content: { writing_insights: string[]; topic_suggestions: Array<{ title: string }> }
    }
    expect(report.work_ids).toContain(workID)
    expect(report.content.writing_insights.length).toBeGreaterThan(0)
    expect(report.content.topic_suggestions.length).toBeGreaterThan(0)

    await native.getByRole('button', { name: /^用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(native, 'AI 质量看板')
    await expect(native).toHaveURL(/\/settings\/quality$/)
    await expect(native.getByRole('heading', { name: 'AI 质量看板', exact: true })).toBeVisible()
    const board30 = await api(page, 'GET', '/quality?days=30&task_type=')
    expect(board30.tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.calls).toBeGreaterThanOrEqual(1)

    await native.getByRole('button', { name: '近 7 天', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/quality?days=7&task_type=')).tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.calls ?? 0).toBeGreaterThanOrEqual(1)
    const trendFilter = native.getByRole('combobox').last()
    await trendFilter.selectOption('review_analysis')
    await expect.poll(async () => (await api(page, 'GET', '/quality?days=7&task_type=review_analysis')).trend.length).toBeGreaterThan(0)
    const taskRow = native.getByRole('row').filter({ hasText: 'AI 复盘' })
    await expect(taskRow).toBeVisible()
    await taskRow.click()
    await expect(native.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible()
    await expect(native.getByText('mock-writer').first()).toBeVisible()
    const calls = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
    expect(calls.some((call: { outcome: string }) => call.outcome === '')).toBeTruthy()
    await native.getByRole('button', { name: '近 90 天', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', '/quality?days=90&task_type=review_analysis')).tasks.some((task: { task_type: string }) => task.task_type === 'review_analysis')).toBeTruthy()

    const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
    const viewerUsername = `qa26-g6-review-viewer-${Date.now()}`
    const viewerContext = await browser.newContext({ baseURL: new URL(baseURL!).origin })
    let viewerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
    let viewerProfile = ''
    try {
      const joined = await viewerContext.request.post('/api/v1/auth/register', {
        data: { username: viewerUsername, password, invite_code: invite.code },
      })
      expect(joined.ok(), '观察者通过邀请码加入当前工作区').toBeTruthy()
      viewerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g6-viewer-'))
      viewerApp = await _electron.launch({
        executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
        args: [`--user-data-dir=${viewerProfile}`, resolve('../desktop/.build/main.js')],
        env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
      })
      const viewer = await viewerApp.firstWindow()
      await viewer.goto(`${baseURL}/login`)
      await viewer.getByLabel('用户名', { exact: true }).fill(viewerUsername)
      await viewer.getByLabel('密码', { exact: true }).fill(password)
      await viewer.getByLabel('邀请码（可选）').fill(invite.code)
      await viewer.getByRole('button', { name: '登录', exact: true }).click()
      await expect.poll(() => viewer.evaluate(async () => (await fetch('/api/v1/auth/me')).json().then((me) => me.role))).toBe('viewer')
      await viewer.evaluate(async (accountID) => {
        const me = await (await fetch('/api/v1/auth/me')).json()
        localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
      }, account.id)
      await viewer.goto(`${baseURL}/a/${account.id}/review`)
      await viewer.getByRole('button', { name: '查看报告与证据', exact: true }).click()
      const viewerReport = viewer.getByTestId(`cx-review-report-${report.id}`)
      await expect(viewerReport).toBeVisible()
      await expect(viewerReport.getByRole('button', { name: '编辑报告', exact: true })).toHaveCount(0)
      await expect(viewerReport.getByRole('button', { name: '记住', exact: true })).toHaveCount(0)
      await expect(viewerReport.getByRole('button', { name: '忽略', exact: true })).toHaveCount(0)
      await expect(viewerReport.getByRole('button', { name: '采纳', exact: true })).toHaveCount(0)

      const denied = await viewer.evaluate(async (reportID) => {
        const me = await (await fetch('/api/v1/auth/me')).json()
        const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
        const requests = [
          fetch(`/api/v1/review-reports/${reportID}/content`, { method: 'PATCH', headers, body: '{}' }),
          fetch(`/api/v1/review-reports/${reportID}/insights/0/remember`, { method: 'POST', headers }),
          fetch(`/api/v1/review-reports/${reportID}/insights/0/ignore`, { method: 'POST', headers }),
          fetch(`/api/v1/review-reports/${reportID}/suggestions/0/adopt`, { method: 'POST', headers }),
        ]
        return Promise.all(requests.map(async (request) => (await request).status))
      }, report.id)
      expect(denied).toEqual([403, 403, 403, 403])
      const unchanged = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0]
      expect(unchanged.adopted).toEqual(report.adopted)
      expect(unchanged.ignored).toEqual(report.ignored)
    } finally {
      if (viewerApp) {
        try { execFileSync('taskkill', ['/PID', String(viewerApp.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
        await Promise.race([viewerApp.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
      }
      if (viewerProfile) {
        if (!resolve(viewerProfile).startsWith(resolve(tmpdir()) + '\\') || !viewerProfile.includes('ops-qa26-g6-viewer-')) throw new Error('拒绝清理测试目录之外路径')
        await rm(viewerProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
      await viewerContext.close()
    }

    await native.goto(`${baseURL}/a/${account.id}/review`)
    await native.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    const ownerReport = native.getByTestId(`cx-review-report-${report.id}`)
    const ignoreResponse = native.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/insights/0/ignore`) && response.request().method() === 'POST')
    await ownerReport.getByRole('button', { name: '忽略', exact: true }).first().click()
    expect((await ignoreResponse).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].ignored).toContain(0)
    let feedback = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
    expect(feedback[0]).toMatchObject({ outcome: 'rejected', reasons: ['其他'] })

    const adoptResponse = native.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/suggestions/0/adopt`) && response.request().method() === 'POST')
    await ownerReport.getByRole('button', { name: '采纳', exact: true }).first().click()
    expect((await adoptResponse).ok()).toBeTruthy()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].adopted).toContain(0)
    feedback = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
    expect(feedback.some((call: { outcome: string }) => call.outcome === 'accepted')).toBeTruthy()
    const updatedBoard = await api(page, 'GET', '/quality?days=30&task_type=review_analysis')
    expect(updatedBoard.tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.adopted).toBeGreaterThanOrEqual(1)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g6-electron-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G6 真实 Electron 复盘反馈20次量化样本', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(300_000)
  const username = `qa26-g6-feedback-samples-${Date.now()}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  await addLocalModel(page)
  const { app, page: native, profile } = await launchG6Electron(baseURL!, username, 'feedback-samples')
  try {
    await native.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}`)
    const workID = await createOutline(native)
    const title = await enterTitleAndBody(native, page, workID, baseURL!, `DEV-QA26复盘反馈样本-${Date.now()}`)
    await finishChecksInElectron(native, page, workID, baseURL!)
    const { capturedAt } = await packAndMarkPublished(native, page, workID, baseURL!)
    await native.goto(`${baseURL}/a/${account.id}/review`)
    await native.getByRole('button', { name: '查看报告与证据', exact: true }).click()
    const review = native.locator('#desktop-review-advanced')
    await review.getByLabel(/使用增强复盘/).uncheck()
    const csv = [
      '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
      `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
    ].join('\n')
    const previewRequest = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await uploadCsv(native, 'qa26-review-feedback-samples.csv', csv)
    expect((await previewRequest).ok()).toBeTruthy()
    const preview = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    const importRequest = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await preview.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await importRequest).ok()).toBeTruthy()
    expect(await api(page, 'GET', `/works/${workID}/metrics`)).toHaveLength(1)

    const samples: number[] = []
    const clicked: Array<{ reportID: string; action: 'ignored' | 'adopted'; index: number }> = []
    const runButton = review.getByRole('button', { name: '生成复盘报告', exact: true }).first()
    for (let sample = 0; sample < 20; sample += 1) {
      await expect(runButton).toBeEnabled()
      const existing = await api(page, 'GET', `/accounts/${account.id}/reviews`) as Array<{ id: string }>
      const oldIDs = new Set(existing.map((report) => report.id))
      const generation = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
      await runButton.click()
      expect((await generation).ok()).toBeTruthy()
      await expect.poll(async () => {
        const reports = await api(page, 'GET', `/accounts/${account.id}/reviews`) as Array<{ id: string }>
        return reports.some((report) => !oldIDs.has(report.id))
      }, { timeout: 30_000 }).toBeTruthy()
      const reports = await api(page, 'GET', `/accounts/${account.id}/reviews`) as Array<{
        id: string; adopted: number[]; ignored: number[]
        content: { writing_insights: string[]; topic_suggestions: Array<{ title: string }> }
      }>
      const report = reports.find((item) => !oldIDs.has(item.id))!
      expect(report.content.writing_insights).toHaveLength(2)
      expect(report.content.topic_suggestions).toHaveLength(3)
      const card = native.getByTestId(`cx-review-report-${report.id}`)
      await expect(card).toBeVisible()
      const isRejected = sample < 8
      const index = 0
      let request: Promise<import('@playwright/test').Response>
      if (isRejected) {
        const insight = report.content.writing_insights[index]
        request = native.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/insights/${index}/ignore`) && response.request().method() === 'POST')
        const startedAt = Date.now()
        await card.getByText(insight, { exact: true }).locator('..').getByRole('button', { name: '忽略', exact: true }).click()
        const response = await request
        samples.push(Date.now() - startedAt)
        expect(response.ok()).toBeTruthy()
        await expect.poll(async () => {
          const current = (await api(page, 'GET', `/accounts/${account.id}/reviews`)).find((item: { id: string }) => item.id === report.id)
          return current?.ignored?.includes(index) ?? false
        }).toBeTruthy()
        clicked.push({ reportID: report.id, action: 'ignored', index })
      } else {
        const suggestion = report.content.topic_suggestions[index]
        const topicsBefore = (await api(page, 'GET', `/accounts/${account.id}/topics`)).filter((item: { source: string; title: string }) => item.source === 'review' && item.title === suggestion.title).length
        request = native.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/suggestions/${index}/adopt`) && response.request().method() === 'POST')
        const startedAt = Date.now()
        await card.getByText(suggestion.title, { exact: true }).locator('..').locator('..').getByRole('button', { name: '采纳', exact: true }).click()
        const response = await request
        samples.push(Date.now() - startedAt)
        expect(response.ok()).toBeTruthy()
        await expect.poll(async () => {
          const current = (await api(page, 'GET', `/accounts/${account.id}/reviews`)).find((item: { id: string }) => item.id === report.id)
          return current?.adopted?.includes(index) ?? false
        }).toBeTruthy()
        await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/topics`)).filter((item: { source: string; title: string }) => item.source === 'review' && item.title === suggestion.title).length).toBe(topicsBefore + 1)
        clicked.push({ reportID: report.id, action: 'adopted', index })
      }
    }

    expect(clicked).toHaveLength(20)
    const calls = await api(page, 'GET', '/quality/calls?task_type=review_analysis') as Array<{ outcome: string }>
    expect(calls).toHaveLength(20)
    expect(calls.filter((call) => call.outcome === 'rejected')).toHaveLength(8)
    expect(calls.filter((call) => call.outcome === 'accepted')).toHaveLength(12)
    const quality = await api(page, 'GET', '/quality?days=30&task_type=review_analysis')
    const task = quality.tasks.find((item: { task_type: string }) => item.task_type === 'review_analysis')
    expect(task).toMatchObject({ calls: 20, with_feedback: 20, adopted: 12 })
    await native.getByRole('button', { name: /^用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await selectDesktopSetting(native, 'AI 质量看板')
    await expect(native.getByRole('heading', { name: 'AI 质量看板', exact: true })).toBeVisible()
    const qualityRow = native.getByRole('row').filter({ hasText: 'AI 复盘' })
    await expect(qualityRow).toBeVisible()
    await qualityRow.click()
    await expect(native.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible()
    await expect(native.getByText('mock-writer').first()).toBeVisible()

    const sorted = [...samples].sort((a, b) => a - b)
    const nearestRank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log(`[DEV-QA26-G6-FEEDBACK] ${JSON.stringify({ environment: 'Windows Electron + 本地 mock', samples: samples.length, failures: 0, p50_ms: nearestRank(0.5), p95_ms: nearestRank(0.95), samples_ms: samples })}`)
  } finally {
    await closeG6Electron(app, profile, 'feedback-samples')
  }
})
