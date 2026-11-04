import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, createOutline, registerAccount, selectDesktopSetting } from './support'

const password = 'local-e2e-password-123'

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

async function enterTitleAndBody(native: Page, page: Page, workID: string, origin: string) {
  const title = `QA26复盘CSV-${Date.now()}`
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

async function packAndMarkPublished(native: Page, page: Page, workID: string, origin: string) {
  await native.goto(`${origin}/works/${workID}/pack`)
  await native.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(native.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000)
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

async function uploadCsv(native: Page, name: string, csv: string) {
  const chooser = native.waitForEvent('filechooser')
  await native.getByRole('button', { name: '导入表格（CSV）', exact: true }).click()
  await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
}

test('DEV-QA26 G6 真实 Electron CSV 确认与非空复盘质量看板', async ({ page, baseURL }) => {
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
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
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
    const report = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0]
    expect(report.work_ids).toContain(workID)

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
