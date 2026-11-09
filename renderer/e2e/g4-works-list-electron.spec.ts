import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { api, registerAccount } from './support'

test('DEV-QA26 G4-01 Electron 旧文导入、标签筛选与 viewer 只读', async ({ page, baseURL, browser }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(150_000)
  const username = `qa26-g4-works-${Date.now()}`
  const account = await registerAccount(page, '长图文', 'wechat_mp', username)
  const profile = await mkdtemp(join(tmpdir(), 'ops-qa26-g4-works-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
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
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}/works`)
    await expect(native.getByRole('heading', { name: '作品', exact: true })).toBeVisible()
    await expect(native.getByText('这里还没有作品', { exact: true })).toBeVisible()

    const journeyStartedAt = Date.now()
    await native.getByRole('button', { name: '导入旧文', exact: true }).click()
    const dialog = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '导入已发布旧文', exact: true }) })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('请填写作品标题')
    await dialog.getByLabel('作品标题').fill('QA26 真实 Electron 旧文导入')
    await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('请粘贴包含正文的旧文')

    const sectionOne = '先梳理当前问题，再列出可以逐项执行的做法。'.repeat(10)
    const sectionTwo = '完成后复核结果，并记录后续需要观察的变化。'.repeat(10)
    const articleBody = `## 先说明问题\n\n${sectionOne}\n\n## 再给方法\n\n${sectionTwo}`
    await dialog.getByLabel('发布日期').fill('2024-06-15')
    await dialog.getByLabel('旧文正文').fill(articleBody)
    await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
    const sections = dialog.getByTestId('import-preview-section')
    await expect(sections).toHaveCount(2)
    await expect(sections.nth(0)).toContainText('先说明问题')
    await expect(sections.nth(0)).toContainText(sectionOne)
    await expect(sections.nth(1)).toContainText('再给方法')
    await expect(sections.nth(1)).toContainText(sectionTwo)

    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click()
    await expect(dialog.getByLabel('作品标题')).toHaveValue('QA26 真实 Electron 旧文导入')
    await expect(dialog.getByLabel('发布日期')).toHaveValue('2024-06-15')
    await expect(dialog.getByLabel('旧文正文')).toHaveValue(articleBody)
    await expect(dialog.getByTestId('import-preview-section')).toHaveCount(0)
    await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
    await dialog.getByRole('button', { name: '确认导入为已发布作品', exact: true }).click()
    await native.waitForURL(/\/works\/[a-f0-9-]+$/)
    const workId = native.url().split('/').pop()!

    const work = await api(page, 'GET', `/works/${workId}`)
    expect(work.status).toBe('published')
    expect(work.locked).toBe(true)
    expect(new Date(Date.parse(work.published_at) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)).toBe('2024-06-15')
    expect(work.sections.map((section: { heading: string }) => section.heading)).toEqual(['先说明问题', '再给方法'])
    expect(work.sections.map((section: { content_md: string }) => section.content_md)).toEqual([sectionOne, sectionTwo])

    await native.goto(`${baseURL}/a/${account.id}/works`)
    const rows = native.getByTestId('desktop-work-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('QA26 真实 Electron 旧文导入')

    await rows.first().getByRole('button', { name: '编辑作品标签' }).click()
    const tags = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '编辑作品标签', exact: true }) })
    await tags.getByLabel('新增标签').fill('QA26旧文')
    await tags.getByRole('button', { name: '添加', exact: true }).click()
    const tagUpdate = native.waitForResponse(response => response.url().endsWith(`/api/v1/works/${workId}`) && response.request().method() === 'PATCH')
    await tags.getByRole('button', { name: '保存标签', exact: true }).click()
    const tagResponse = await tagUpdate
    expect(tagResponse.status(), await tagResponse.text()).toBe(200)
    await expect(native.getByText('标签已保存', { exact: true })).toBeVisible()
    const taggedWork = await api(page, 'GET', `/works/${workId}`)
    expect(taggedWork.tags).toContain('QA26旧文')
    await native.reload()
    await native.getByLabel('按标签筛选').selectOption('QA26旧文')
    await expect(native).toHaveURL(/tag=QA26/)
    await expect(rows).toContainText('QA26 真实 Electron 旧文导入')

    const durations: number[] = []
    for (let i = 0; i < 20; i++) {
      const published = i % 2 === 1
      const label = published ? '已发布' : '创作中'
      const status = published ? 'published' : 'drafting'
      const expectedRows = published ? 1 : 0
      const startedAt = Date.now()
      const tab = native.getByRole('tab', { name: new RegExp(label) })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(native).toHaveURL(new RegExp(`status=${status}`))
      await expect(rows).toHaveCount(expectedRows)
      durations.push(Date.now() - startedAt)
    }
    const sorted = [...durations].sort((a, b) => a - b)
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    console.log(`G4-01 Electron 状态筛选样本 n=20 失败=0 p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms`)
    console.log(`G4-01 Electron 导入与服务端读回旅程 ${((Date.now() - journeyStartedAt) / 1000).toFixed(1)}s`)

    const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
    const viewerContext = await browser.newContext({ baseURL: new URL(baseURL!).origin })
    let viewerApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
    let viewerProfile = ''
    try {
      const viewerUsername = `qa26-g4-viewer-${Date.now()}`
      const joined = await viewerContext.request.post('/api/v1/auth/register', {
        data: { username: viewerUsername, password: 'local-e2e-password-123', invite_code: invite.code },
      })
      expect(joined.ok(), 'viewer 使用 owner 创建的邀请码加入工作区').toBeTruthy()
      viewerProfile = await mkdtemp(join(tmpdir(), 'ops-qa26-g4-viewer-'))
      viewerApp = await _electron.launch({
        executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
        args: [`--user-data-dir=${viewerProfile}`, resolve('../desktop/.build/main.js')],
        env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
      })
      const viewer = await viewerApp.firstWindow()
      await viewer.goto(`${baseURL}/login`)
      await viewer.getByLabel('用户名', { exact: true }).fill(viewerUsername)
      await viewer.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
      await viewer.getByLabel('邀请码（可选）').fill(invite.code)
      await viewer.getByRole('button', { name: '登录', exact: true }).click()
      await expect.poll(() => viewer.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
      await viewer.evaluate(async (accountID) => {
        const me = await (await fetch('/api/v1/auth/me')).json()
        localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
      }, account.id)
      await viewer.goto(`${baseURL}/a/${account.id}/works`)
      const viewerRow = viewer.getByTestId('desktop-work-row').filter({ hasText: 'QA26 真实 Electron 旧文导入' })
      await expect(viewerRow).toContainText('QA26旧文')
      await expect(viewer.getByRole('button', { name: '编辑作品标签' })).toHaveCount(0)
      const denied = await viewer.evaluate(async (id) => {
        const me = await (await fetch('/api/v1/auth/me')).json()
        const response = await fetch(`/api/v1/works/${id}`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
          body: JSON.stringify({ tags: ['viewer 不应写入'] }),
        })
        return { status: response.status, body: await response.text() }
      }, workId)
      expect(denied.status).toBe(403)
      expect(denied.body).toContain('观察者仅可浏览，不能修改内容')
      const unchanged = await api(page, 'GET', `/works/${workId}`)
      expect(unchanged.tags).toEqual(['QA26旧文'])
      expect(unchanged.revision).toBe(taggedWork.revision)
    } finally {
      if (viewerApp) {
        try { execFileSync('taskkill', ['/PID', String(viewerApp.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
        await Promise.race([viewerApp.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
      }
      if (viewerProfile) {
        if (!resolve(viewerProfile).startsWith(resolve(tmpdir()) + '\\') || !viewerProfile.includes('ops-qa26-g4-viewer-')) throw new Error('拒绝清理测试目录之外路径')
        await rm(viewerProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
      await viewerContext.close()
    }
  } finally {
    if (app) {
      try { await app.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的客户端。 */ }
      await app.close().catch(() => undefined)
    }
    const resolvedProfile = resolve(profile)
    if (!resolvedProfile.startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g4-works-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
