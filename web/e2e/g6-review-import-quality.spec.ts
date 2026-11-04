import { expect, test } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

const password = 'local-e2e-password-123'

function localDateInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function addLocalModel(page: import('@playwright/test').Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: `DEV-QA26 G6 本地模型 ${Date.now()}`,
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1',
    api_key: 'local-qa26-g6-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', ['outline', 'fact_flag', 'review_analysis'].map((task_type) => ({
    task_type, provider_id: provider.id, model: 'mock-writer',
  })))
}

async function enterTitleAndBody(page: import('@playwright/test').Page, workID: string) {
  const title = `QA26复盘CSV-${Date.now()}`
  const titleInput = page.locator('#step-title input').first()
  await titleInput.fill(title)
  await titleInput.press('Tab')
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).title).toBe(title)

  const work = await api(page, 'GET', `/works/${workID}`) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `第 ${index + 1} 段先记录可核对的事实，再说明下一步如何验证。`, base_revision: section.revision,
    })
  }
  await page.reload()
  return title
}

async function packAndMarkPublished(page: import('@playwright/test').Page, workID: string) {
  await page.goto(`/works/${workID}/check`)
  await finishChecks(page, workID)
  await page.goto(`/works/${workID}/pack`)
  await page.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000)
  const backfill = page.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill('https://example.invalid/qa26-local-review')
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${workID}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('published')
  return { publishedAt, capturedAt: new Date(publishedAt.getTime() + 7 * 24 * 60 * 60_000) }
}

async function uploadCsv(page: import('@playwright/test').Page, name: string, csv: string, mimeType = 'text/csv') {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入表格（CSV）', exact: true }).click()
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(csv, 'utf8') })
}

async function openSetting(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: /用户菜单/ }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

async function createPublishedXhsWork(page: import('@playwright/test').Page, accountID: string, title: string, daysAgo: number) {
  await page.goto(`/a/${accountID}`)
  const workID = await createOutline(page)
  const work = await api(page, 'GET', `/works/${workID}`) as { revision: number }
  await api(page, 'PATCH', `/works/${workID}`, { title, base_revision: work.revision })
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d9e8ee'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]
  })
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
  await page.goto(`/works/${workID}/check`)
  await finishChecks(page, workID)
  await page.goto(`/works/${workID}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByRole('heading', { name: '小红书发布包', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('packed')
  const publishedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60_000)
  const backfill = page.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill(`https://example.invalid/qa26-local-review-${workID}`)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${workID}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()
  return (await api(page, 'GET', `/works/${workID}`)).published_at as string
}

test('DEV-QA26 G6 Web 同名 CSV 需人工消歧并可按发布时间匹配', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(240_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g6-duplicate-web-${Date.now()}`)
  await addLocalModel(page)
  const duplicateTitle = `QA26同名CSV-${Date.now()}`
  const publishedAt = [
    await createPublishedXhsWork(page, account.id, duplicateTitle, 20),
    await createPublishedXhsWork(page, account.id, duplicateTitle, 8),
  ]
  const capturedAt = (at: string) => new Date(Date.parse(at) + 7 * 24 * 60 * 60_000).toISOString()

  await page.goto(`/a/${account.id}/review`)
  const noDateCSV = ['标题,统计时间,阅读', `"${duplicateTitle}",${capturedAt(publishedAt[0])},101`].join('\n')
  const noDateResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-duplicate-no-date.csv', noDateCSV)
  const noDatePreview = await (await noDateResponse).json() as { preview: Array<{ work_id: string | null; matched: boolean }> }
  expect(noDatePreview.preview[0].work_id, '没有发布时间时不能猜测同名作品').toBeNull()
  const manual = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
  const choice = manual.getByRole('combobox').first()
  const options = await choice.locator('option').allTextContents()
  const duplicateOptions = options.filter((label) => label.includes(duplicateTitle))
  expect(duplicateOptions).toHaveLength(2)
  expect(new Set(duplicateOptions).size).toBe(2)
  expect(await choice.inputValue()).toBe('')
  const firstWorkID = (await api(page, 'GET', `/accounts/${account.id}/board`)).find((row: { title: string; published_at: string }) => row.title === duplicateTitle && row.published_at === publishedAt[0]).id
  await choice.selectOption(firstWorkID)
  const manualImport = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await manual.getByRole('button', { name: '确认导入', exact: true }).click()
  expect((await manualImport).ok()).toBeTruthy()
  expect(await api(page, 'GET', `/works/${firstWorkID}/metrics`)).toHaveLength(1)

  const secondRow = (await api(page, 'GET', `/accounts/${account.id}/board`)).find((row: { title: string; published_at: string }) => row.title === duplicateTitle && row.published_at === publishedAt[1])
  const datedCSV = ['标题,发布时间,统计时间,阅读', `"${duplicateTitle}",${publishedAt[1]},${capturedAt(publishedAt[1])},202`].join('\n')
  const datedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-duplicate-published-at.csv', datedCSV)
  const datedPreview = await (await datedResponse).json() as { preview: Array<{ work_id: string | null; matched: boolean }> }
  expect(datedPreview.preview[0].work_id).toBe(secondRow.id)
  const dated = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
  const datedImport = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await dated.getByRole('button', { name: '确认导入', exact: true }).click()
  expect((await datedImport).ok()).toBeTruthy()
  expect(await api(page, 'GET', `/works/${secondRow.id}/metrics`)).toHaveLength(1)
})

test('DEV-QA26 G6 Web 编辑者可预览 CSV 且观察者被拒绝', async ({ page, browser }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs', `qa26-g6-viewer-web-${Date.now()}`)
  const title = `QA26编辑者导入Web-${Date.now()}`
  const publishedAt = await createPublishedXhsWork(page, account.id, title, 8)
  await page.goto(`/a/${account.id}`)
  await openSetting(page, '成员与邀请')
  await page.getByRole('combobox').last().selectOption('viewer')
  const inviteResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
  const invite = await (await inviteResponse).json() as { code: string; role: string }
  expect(invite.role).toBe('viewer')

  const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  let editorContext: import('@playwright/test').BrowserContext | undefined
  try {
    const username = `qa26-g6-viewer-${Date.now()}`
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username, password, invite_code: invite.code },
    })
    expect(joined.ok(), '通过 UI 生成的邀请码注册观察者').toBeTruthy()
    const viewerPage = await viewerContext.newPage()
    await viewerPage.goto(`/a/${account.id}/review`)
    await expect.poll(() => viewerPage.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect.poll(() => viewerPage.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
    await expect(viewerPage.getByRole('button', { name: '导入表格（CSV）', exact: true })).toHaveCount(0)
    const denied = await viewerPage.evaluate(async (accountID) => {
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
    const work = (await api(page, 'GET', `/accounts/${account.id}/board`)).find((row: { title: string }) => row.title === title)
    expect(await api(page, 'GET', `/works/${work.id}/metrics`)).toHaveLength(0)

    await page.getByRole('combobox').last().selectOption('editor')
    const editorInviteResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/workspaces/current/invites') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '生成邀请码', exact: true }).first().click()
    const editorInvite = await (await editorInviteResponse).json() as { code: string; role: string }
    expect(editorInvite.role).toBe('editor')
    editorContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    const editorJoined = await editorContext.request.post('/api/v1/auth/register', {
      data: { username: `qa26-g6-editor-${Date.now()}`, password, invite_code: editorInvite.code },
    })
    expect(editorJoined.ok(), '通过 Web 设置页生成的邀请码注册编辑者').toBeTruthy()
    const editorPage = await editorContext.newPage()
    await editorPage.goto(`/a/${account.id}/review`)
    await expect.poll(() => editorPage.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('editor')
    await expect(editorPage.getByRole('button', { name: '导入表格（CSV）', exact: true })).toBeVisible()
    const editorPreviewResponse = editorPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    const capturedAt = new Date(Date.parse(publishedAt) + 7 * 24 * 60 * 60_000).toISOString()
    await uploadCsv(editorPage, 'editor-confirm.csv', ['标题,发布时间,统计时间,阅读', `"${title}",${publishedAt},${capturedAt},321`].join('\n'))
    const editorPreviewResult = await editorPreviewResponse
    expect(editorPreviewResult.status()).toBe(200)
    const editorPreview = editorPage.getByRole('dialog').filter({ has: editorPage.getByRole('heading', { name: '确认作品匹配', exact: true }) })
    await expect(editorPreview).toBeVisible()
    expect(((await editorPreviewResult.json()) as { preview: Array<{ work_id: string }> }).preview[0].work_id).toBe(work.id)
    const imported = editorPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
    await editorPreview.getByRole('button', { name: '确认导入', exact: true }).click()
    expect((await imported).ok()).toBeTruthy()
    expect(await api(page, 'GET', `/works/${work.id}/metrics`)).toMatchObject([
      { source: 'file', reads: 321, day_offset: 7 },
    ])
  } finally {
    await editorContext?.close()
    await viewerContext.close()
  }
})

test('DEV-QA26 G6 Web CSV 确认、复盘反馈与只读权限', async ({ page, browser }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(180_000)
  const account = await registerAccount(page, '微头条', 'toutiao', `qa26-g6-web-${Date.now()}`)
  await addLocalModel(page)
  const workID = await createOutline(page)
  const title = await enterTitleAndBody(page, workID)
  const { capturedAt } = await packAndMarkPublished(page, workID)

  await page.goto(`/a/${account.id}/review`)
  await page.getByLabel(/使用增强复盘/).uncheck()
  const wrongType = page.waitForResponse((response) => response.url().endsWith('/api/v1/accounts/' + account.id + '/metrics/import') && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-not-csv.txt', '标题,阅读\n123', 'text/plain')
  expect((await wrongType).status()).toBe(422)
  await expect(page.getByText(/请上传 CSV 文件/)).toBeVisible()
  expect(await api(page, 'GET', '/works/' + workID + '/metrics')).toHaveLength(0)
  const badCsv = [
    '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
    `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
    `"不存在的作品",${capturedAt.toISOString()},bad,100,2,1,0,0,0`,
  ].join('\n')
  const parseResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-invalid-row.csv', badCsv)
  expect((await parseResponse).ok()).toBeTruthy()
  const preview = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
  await expect(preview).toBeVisible()
  await expect(preview.getByText('已精确匹配', { exact: true })).toBeVisible()
  await expect(preview.getByText(/无法解析：bad/)).toBeVisible()
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  expect(await api(page, 'GET', `/works/${workID}/metrics`)).toHaveLength(0)

  const validCsv = [
    '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
    `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
  ].join('\n')
  const validPreviewResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-valid.csv', validCsv)
  expect((await validPreviewResponse).ok()).toBeTruthy()
  const confirmedPreview = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
  await expect(confirmedPreview.getByText(title, { exact: true })).toBeVisible()
  const imported = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await confirmedPreview.getByRole('button', { name: '确认导入', exact: true }).click()
  expect((await imported).ok()).toBeTruthy()
  await expect(page.getByText('已导入 1 行', { exact: true })).toBeVisible()
  const savedMetrics = await api(page, 'GET', `/works/${workID}/metrics`)
  expect(savedMetrics).toHaveLength(1)
  expect(savedMetrics[0]).toMatchObject({ source: 'file', reads: 12000, impressions: 33000, likes: 36, favorites: 8, day_offset: 7 })
  const boardRow = page.locator('tbody tr').filter({ has: page.getByRole('link', { name: title, exact: true }) })
  await expect(boardRow).toContainText('1.2万')
  await expect(boardRow).toContainText('33,000')

  const reportPost = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '生成复盘报告', exact: true }).first().click()
  expect((await reportPost).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`)).length).toBe(1)
  const report = (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0] as {
    id: string; work_ids: string[]; adopted: number[]; ignored: number[]
    content: { writing_insights: string[]; topic_suggestions: Array<{ title: string }> }
  }
  expect(report.work_ids).toContain(workID)
  expect(report.content.writing_insights.length).toBeGreaterThan(0)
  expect(report.content.topic_suggestions.length).toBeGreaterThan(0)

  await page.goto('/settings/quality')
  await expect(page.getByRole('heading', { name: 'AI 质量看板', exact: true })).toBeVisible()
  const board30 = await api(page, 'GET', '/quality?days=30&task_type=')
  expect(board30.tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.calls).toBeGreaterThanOrEqual(1)
  await page.getByRole('button', { name: '近 7 天', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/quality?days=7&task_type=')).tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.calls ?? 0).toBeGreaterThanOrEqual(1)
  await page.getByRole('combobox').last().selectOption('review_analysis')
  await expect.poll(async () => (await api(page, 'GET', '/quality?days=7&task_type=review_analysis')).trend.length).toBeGreaterThan(0)
  await page.getByRole('row').filter({ hasText: 'AI 复盘' }).click()
  await expect(page.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible()
  await expect(page.getByText('mock-writer').first()).toBeVisible()
  const calls = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
  expect(calls.some((call: { outcome: string }) => call.outcome === '')).toBeTruthy()
  await page.getByRole('button', { name: '近 90 天', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/quality?days=90&task_type=review_analysis')).tasks.some((task: { task_type: string }) => task.task_type === 'review_analysis')).toBeTruthy()

  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
  const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: `qa26-g6-review-viewer-${Date.now()}`, password, invite_code: invite.code },
    })
    expect(joined.ok(), '观察者通过邀请码加入当前工作区').toBeTruthy()
    const viewer = await viewerContext.newPage()
    await viewer.goto(`/a/${account.id}/review`)
    await expect.poll(() => viewer.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
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
    await viewerContext.close()
  }

  await page.goto(`/a/${account.id}/review`)
  const ownerReport = page.getByTestId(`cx-review-report-${report.id}`)
  const ignoreResponse = page.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/insights/0/ignore`) && response.request().method() === 'POST')
  await ownerReport.getByRole('button', { name: '忽略', exact: true }).first().click()
  expect((await ignoreResponse).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].ignored).toContain(0)
  let feedback = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
  expect(feedback[0]).toMatchObject({ outcome: 'rejected', reasons: ['其他'] })

  const adoptResponse = page.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/suggestions/0/adopt`) && response.request().method() === 'POST')
  await ownerReport.getByRole('button', { name: '采纳', exact: true }).first().click()
  expect((await adoptResponse).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].adopted).toContain(0)
  feedback = await api(page, 'GET', '/quality/calls?task_type=review_analysis')
  expect(feedback.some((call: { outcome: string }) => call.outcome === 'accepted')).toBeTruthy()
  const updatedBoard = await api(page, 'GET', '/quality?days=30&task_type=review_analysis')
  expect(updatedBoard.tasks.find((task: { task_type: string }) => task.task_type === 'review_analysis')?.adopted).toBeGreaterThanOrEqual(1)
})

test('DEV-QA26 G6 Web 复盘反馈20次量化样本', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(300_000)
  const account = await registerAccount(page, '微头条', 'toutiao', `qa26-g6-feedback-samples-web-${Date.now()}`)
  await addLocalModel(page)
  await page.goto(`/a/${account.id}`)
  const workID = await createOutline(page)
  const title = await enterTitleAndBody(page, workID)
  const { capturedAt } = await packAndMarkPublished(page, workID)
  await page.goto(`/a/${account.id}/review`)
  await page.getByLabel(/使用增强复盘/).uncheck()
  const csv = [
    '标题,统计时间,展现,阅读,点赞,收藏,评论,分享,涨粉',
    `"${title}",${capturedAt.toISOString()},33000,12000,36,8,2,5,1`,
  ].join('\n')
  const previewRequest = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await uploadCsv(page, 'qa26-review-feedback-samples.csv', csv)
  expect((await previewRequest).ok()).toBeTruthy()
  const preview = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认作品匹配', exact: true }) })
  const importRequest = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/metrics/import`) && response.request().method() === 'POST')
  await preview.getByRole('button', { name: '确认导入', exact: true }).click()
  expect((await importRequest).ok()).toBeTruthy()
  expect(await api(page, 'GET', `/works/${workID}/metrics`)).toHaveLength(1)

  const samples: number[] = []
  const clicked: Array<{ reportID: string; action: 'ignored' | 'adopted'; index: number }> = []
  const runButton = page.getByRole('button', { name: '生成复盘报告', exact: true }).first()
  for (let sample = 0; sample < 20; sample += 1) {
    await expect(runButton).toBeEnabled()
    const existing = await api(page, 'GET', `/accounts/${account.id}/reviews`) as Array<{ id: string }>
    const oldIDs = new Set(existing.map((report) => report.id))
    const generation = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews`) && response.request().method() === 'POST')
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
    const card = page.getByTestId(`cx-review-report-${report.id}`)
    await expect(card).toBeVisible()
    const isRejected = sample < 8
    const index = 0
    let request: Promise<import('@playwright/test').Response>
    if (isRejected) {
      const insight = report.content.writing_insights[index]
      request = page.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/insights/${index}/ignore`) && response.request().method() === 'POST')
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
      request = page.waitForResponse((response) => response.url().endsWith(`/review-reports/${report.id}/suggestions/${index}/adopt`) && response.request().method() === 'POST')
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
  await page.goto('/settings/quality')
  await expect(page.getByRole('heading', { name: 'AI 质量看板', exact: true })).toBeVisible()
  const qualityRow = page.getByRole('row').filter({ hasText: 'AI 复盘' })
  await expect(qualityRow).toBeVisible()
  await qualityRow.click()
  await expect(page.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible()
  await expect(page.getByText('mock-writer').first()).toBeVisible()

  const sorted = [...samples].sort((a, b) => a - b)
  const nearestRank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
  console.log(`[DEV-QA26-G6-FEEDBACK] ${JSON.stringify({ environment: 'Chromium + 本地 mock', samples: samples.length, failures: 0, p50_ms: nearestRank(0.5), p95_ms: nearestRank(0.95), samples_ms: samples })}`)
})
