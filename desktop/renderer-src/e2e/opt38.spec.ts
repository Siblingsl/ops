import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount } from './support'

const password = 'local-e2e-password-123'

test('OPT38 单篇 Markdown 导出保留标题、段落与图片顺序', async ({ page, baseURL }, testInfo) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)

  const username = `qa26-opt38-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username)
  const title = 'OPT38: Markdown / 导出验收'
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title })
  await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '这是本人输入的核心观点：清楚说明每一步，读者才能重复执行。',
    base_revision: work.revision,
  })
  await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [
      { heading: '第一段', key_point: '先确认顺序', material_ids: [] },
      { heading: '第二段', key_point: '再检查图片', material_ids: [] },
    ],
    confirm: true,
  })

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const context = canvas.getContext('2d')!
    context.fillStyle = '#456'
    context.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const images: { id: string }[] = []
  for (const index of [1, 2]) {
    const response = await page.request.post(`/api/v1/works/${work.id}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token },
      multipart: { file: { name: `opt38-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
    })
    expect(response.ok()).toBeTruthy()
    images.push(await response.json())
  }
  const current = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${current.sections[0].id}`, {
    content_md: `第一段正文。\n\n![第一张图片](/api/v1/assets/${images[0].id}/file)`,
    base_revision: current.sections[0].revision,
  })
  await api(page, 'PATCH', `/sections/${current.sections[1].id}`, {
    content_md: `第二段正文。\n\n![第二张图片](/api/v1/assets/${images[1].id}/file)`,
    base_revision: current.sections[1].revision,
  })

  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-opt38-'))
  const outputDir = resolve('../../.playwright-results')
  let runOutputDir = ''
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let editorProfile = ''
  let editorApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let viewerProfile = ''
  let viewerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    await mkdir(outputDir, { recursive: true })
    runOutputDir = await mkdtemp(join(outputDir, 'qa26-opt38-electron-'))
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
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
    await native.goto(`${baseURL}/works/${work.id}`)

    const more = native.locator('.desktop-work-more')
    await expect(more).toBeVisible()
    const firstAssetURL = new URL(`/api/v1/assets/${images[0].id}/file`, baseURL).href
    const secondAssetURL = new URL(`/api/v1/assets/${images[1].id}/file`, baseURL).href
    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      const savedPath = join(runOutputDir, `sample-${i + 1}.md`)
      await more.getByRole('button').click()
      const exportItem = native.getByRole('menuitem', { name: '导出 Markdown', exact: true })
      await expect(exportItem).toBeVisible()
      await app.evaluate(({ session }, args) => {
        session.fromPartition('persist:ops-business-development').once('will-download', (_event, item) => {
          Object.assign(globalThis, { __qa26Opt38Filename: item.getFilename() })
          item.setSavePath(args.filePath)
        })
      }, { filePath: savedPath })

      const refreshedWork = native.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
      const started = performance.now()
      await exportItem.click()
      expect((await refreshedWork).ok()).toBeTruthy()
      await expect(native.getByText('已开始下载', { exact: true }).first()).toBeVisible()
      await expect.poll(() => readFile(savedPath, 'utf8').catch(() => ''), { timeout: 15_000 })
        .toContain(`# ${title}`)
      const file = await readFile(savedPath, 'utf8')
      const filename = await app.evaluate(() =>
        (globalThis as typeof globalThis & { __qa26Opt38Filename?: string }).__qa26Opt38Filename)
      expect(filename).toBe('OPT38_ Markdown _ 导出验收.md')
      expect(file).toContain('第一段正文。')
      expect(file).toContain('第二段正文。')
      expect(file.indexOf('第一段正文。')).toBeLessThan(file.indexOf('第二段正文。'))
      expect(file.indexOf('## 第一段')).toBeLessThan(file.indexOf('## 第二段'))
      expect(file.indexOf(firstAssetURL)).toBeLessThan(file.indexOf('## 第二段'))
      expect(file.indexOf('## 第二段')).toBeLessThan(file.indexOf(secondAssetURL))
      latencies.push(performance.now() - started)
    }
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    console.log(`DEV-QA26 G4-17 Electron Markdown 导出：样本=${latencies.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms failures=0`)
    await testInfo.attach('g4-17-electron-export-latencies', {
      body: JSON.stringify({ samples: latencies, p50, p95, failures: 0 }),
      contentType: 'application/json',
    })

    const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 }) as { code: string }
    const editorUsername = `qa26-opt38-editor-${Date.now()}`
    editorProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-opt38-editor-'))
    editorApp = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${editorProfile}`, resolve('../.build/main.js')],
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
    const editorMe = await editor.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as {
      user_id: string
      workspace: { id: string }
      role: string
    }
    expect(editorMe.role).toBe('editor')
    await editor.evaluate(({ accountId, userId, workspaceId }) => {
      localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, accountId)
    }, { accountId: account.id, userId: editorMe.user_id, workspaceId: editorMe.workspace.id })
    const editorWork = editor.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
    await editor.goto(`${baseURL}/works/${work.id}`)
    expect((await editorWork).ok()).toBeTruthy()
    const editorMore = editor.locator('.desktop-work-more')
    await expect(editorMore).toBeVisible()
    await editorMore.getByRole('button').click()
    const editorExport = editor.getByRole('menuitem', { name: '导出 Markdown', exact: true })
    await expect(editorExport).toBeVisible()
    const editorPath = join(runOutputDir, 'editor-export.md')
    await editorApp.evaluate(({ session }, filePath) => {
      session.fromPartition('persist:ops-business-development').once('will-download', (_event, item) => item.setSavePath(filePath))
    }, editorPath)
    const editorRefresh = editor.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
    await editorExport.click()
    expect((await editorRefresh).ok()).toBeTruthy()
    await expect.poll(() => readFile(editorPath, 'utf8').catch(() => '')).toContain(`# ${title}`)
    const editorMarkdown = await readFile(editorPath, 'utf8')
    expect(editorMarkdown).toContain(firstAssetURL)
    expect(editorMarkdown).toContain(secondAssetURL)

    const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 }) as { code: string }
    const viewerUsername = `qa26-opt38-viewer-${Date.now()}`
    viewerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-opt38-viewer-'))
    viewerApp = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${viewerProfile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const viewer = await viewerApp.firstWindow()
    await viewer.goto(`${baseURL}/register`)
    await viewer.getByLabel('用户名', { exact: true }).fill(viewerUsername)
    await viewer.getByLabel('密码（至少 12 位）').fill(password)
    await viewer.getByLabel('邀请码（可选）').fill(invite.code)
    await viewer.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => viewer.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const viewerMe = await viewer.evaluate(async () => await (await fetch('/api/v1/auth/me')).json()) as {
      user_id: string
      workspace: { id: string }
      role: string
    }
    expect(viewerMe.role).toBe('viewer')
    await viewer.evaluate(({ accountId, userId, workspaceId }) => {
      localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, accountId)
    }, { accountId: account.id, userId: viewerMe.user_id, workspaceId: viewerMe.workspace.id })
    const viewerWork = viewer.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'GET')
    await viewer.goto(`${baseURL}/works/${work.id}`)
    expect((await viewerWork).ok()).toBeTruthy()
    await expect(viewer.locator('.desktop-work-more')).toHaveCount(0)
    await expect(viewer.getByRole('menuitem', { name: '导出 Markdown', exact: true })).toHaveCount(0)
  } finally {
    if (viewerApp) {
      try { await viewerApp.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的 viewer Electron。 */ }
      await viewerApp.close().catch(() => undefined)
    }
    if (editorApp) {
      try { await editorApp.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的 editor Electron。 */ }
      await editorApp.close().catch(() => undefined)
    }
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的 Electron。 */ }
      await app.close().catch(() => undefined)
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-opt38-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (editorProfile) {
      const resolvedEditorProfile = resolve(editorProfile)
      if (!resolvedEditorProfile.startsWith(resolve(tmpdir()) + '\\') || !editorProfile.includes('ops-qa26-opt38-editor-')) {
        throw new Error('拒绝清理测试目录之外路径')
      }
      await rm(editorProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    if (viewerProfile) {
      const resolvedViewerProfile = resolve(viewerProfile)
      if (!resolvedViewerProfile.startsWith(resolve(tmpdir()) + '\\') || !viewerProfile.includes('ops-qa26-opt38-viewer-')) {
        throw new Error('拒绝清理测试目录之外路径')
      }
      await rm(viewerProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    if (runOutputDir) {
      const resolvedOutput = resolve(runOutputDir)
      if (!resolvedOutput.startsWith(outputDir + '\\') || !runOutputDir.includes('qa26-opt38-electron-')) {
        throw new Error('拒绝清理测试目录之外路径')
      }
      await rm(runOutputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
