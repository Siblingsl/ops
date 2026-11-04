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

test('DEV-QA26 G6 Web CSV 确认与非空复盘质量看板', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(180_000)
  const account = await registerAccount(page, '微头条', 'toutiao', `qa26-g6-web-${Date.now()}`)
  await addLocalModel(page)
  const workID = await createOutline(page)
  const title = await enterTitleAndBody(page, workID)
  const { capturedAt } = await packAndMarkPublished(page, workID)

  await page.goto(`/a/${account.id}/review`)
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
  expect((await api(page, 'GET', `/accounts/${account.id}/reviews`))[0].work_ids).toContain(workID)

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
})
