import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

const password = 'local-e2e-password-123'
const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1]

test('DEV-QA26 G4-16 Web 标签保存、失败/取消、筛选视图、搜索与 editor', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const title = `QA26 OPT36 Web 标签 ${Date.now()}`
  const otherTitle = `QA26 OPT36 Web 另一标签 ${Date.now()}`
  const first = await api(page, 'POST', `/accounts/${account.id}/works`, { title })
  const other = await api(page, 'POST', `/accounts/${account.id}/works`, { title: otherTitle })
  await api(page, 'PATCH', `/works/${first.id}`, { tags: ['QA26主题A'], viewpoint: '标签修改不应改变作品正文和检查状态。' })
  await api(page, 'PATCH', `/works/${other.id}`, { tags: ['QA26主题B'] })
  const before = await api(page, 'GET', `/works/${first.id}`)

  const journeyStartedAt = Date.now()
  await page.goto(`/a/${account.id}/works`)
  const firstLink = page.getByTestId('work-row-link').filter({ hasText: title })
  await expect(firstLink).toBeVisible()
  let patchRequests = 0
  page.on('request', request => {
    if (request.url().endsWith(`/api/v1/works/${first.id}`) && request.method() === 'PATCH') patchRequests++
  })

  const editButton = () => firstLink.locator('xpath=..').getByRole('button', { name: '编辑作品标签' })
  await editButton().click()
  let dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑作品标签', exact: true }) })
  await dialog.getByLabel('新增标签').fill('QA26取消标签')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(patchRequests, '取消编辑不得发出标签写入').toBe(0)
  expect((await api(page, 'GET', `/works/${first.id}`)).tags).toEqual(['QA26主题A'])

  await editButton().click()
  dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑作品标签', exact: true }) })
  await dialog.getByRole('button', { name: '移除标签 QA26主题A' }).click()
  await dialog.getByLabel('新增标签').fill('QA26主题C')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  const workRoute = `**/api/v1/works/${first.id}`
  await page.route(workRoute, async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟标签保存暂不可用' }) })
    } else await route.continue()
  })
  const rejectedSave = page.waitForResponse(response => response.url().endsWith(`/api/v1/works/${first.id}`) && response.request().method() === 'PATCH')
  await dialog.getByRole('button', { name: '保存标签', exact: true }).click()
  expect((await rejectedSave).status()).toBe(503)
  await expect(dialog).toBeVisible()
  const afterRejectedSave = await api(page, 'GET', `/works/${first.id}`)
  expect(afterRejectedSave.tags).toEqual(['QA26主题A'])
  expect(afterRejectedSave.revision).toBe(before.revision)
  await page.unroute(workRoute)

  const successfulSave = page.waitForResponse(response => response.url().endsWith(`/api/v1/works/${first.id}`) && response.request().method() === 'PATCH')
  await dialog.getByRole('button', { name: '保存标签', exact: true }).click()
  const saveResponse = await successfulSave
  expect(saveResponse.status(), await saveResponse.text()).toBe(200)
  expect(saveResponse.request().postDataJSON()).toEqual({ tags: ['QA26主题C'] })
  await expect(page.getByText('标签已保存', { exact: true })).toBeVisible()
  const saved = await api(page, 'GET', `/works/${first.id}`)
  expect(saved.tags).toEqual(['QA26主题C'])
  expect(saved.revision).toBe(before.revision)
  expect(saved.status).toBe(before.status)
  expect(saved.sections).toEqual(before.sections)

  await page.reload()
  await expect(firstLink).toContainText('QA26主题C')
  const tagFilter = page.getByLabel('按标签筛选')
  await tagFilter.selectOption('QA26主题C')
  await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe('QA26主题C')
  await expect(firstLink).toBeVisible()
  await expect(page.getByTestId('work-row-link').filter({ hasText: otherTitle })).toHaveCount(0)
  await page.reload()
  await expect(tagFilter).toHaveValue('QA26主题C')
  await expect(firstLink).toBeVisible()

  await page.getByRole('button', { name: '保存当前筛选为视图' }).click()
  await page.getByPlaceholder('视图名称').fill('QA26标签视图')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const savedView = page.getByRole('button', { name: 'QA26标签视图', exact: true })
  await expect(savedView).toBeVisible()
  await tagFilter.selectOption('QA26主题B')
  await expect(page.getByTestId('work-row-link').filter({ hasText: otherTitle })).toBeVisible()
  await savedView.click()
  await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe('QA26主题C')
  await expect(firstLink).toBeVisible()
  await page.reload()
  await expect(savedView).toBeVisible()
  await expect(tagFilter).toHaveValue('QA26主题C')

  const latencies: number[] = []
  for (let index = 0; index < 20; index++) {
    const selectedTag = index % 2 === 0 ? 'QA26主题C' : 'QA26主题B'
    const expectedTitle = index % 2 === 0 ? title : otherTitle
    const hiddenTitle = index % 2 === 0 ? otherTitle : title
    const started = Date.now()
    await tagFilter.selectOption(selectedTag)
    await expect.poll(() => new URL(page.url()).searchParams.get('tag')).toBe(selectedTag)
    await expect(page.getByTestId('work-row-link').filter({ hasText: expectedTitle })).toBeVisible()
    await expect(page.getByTestId('work-row-link').filter({ hasText: hiddenTitle })).toHaveCount(0)
    latencies.push(Date.now() - started)
  }
  console.log(`G4-16 Web 标签筛选：n=${latencies.length} p50=${percentile(latencies, 0.5)}ms p95=${percentile(latencies, 0.95)}ms failures=0`)
  await testInfo.attach('g4-16-web-tag-filter-latencies', { body: JSON.stringify({ samples: latencies, failures: 0 }), contentType: 'application/json' })

  await tagFilter.selectOption('QA26主题C')
  await page.getByRole('button', { name: '搜索 Ctrl K' }).click()
  const palette = page.getByRole('dialog', { name: '命令面板' })
  const paletteSearch = palette.getByPlaceholder('搜索作品、选题、素材，或输入命令（支持拼音首字母）')
  const searchResponse = page.waitForResponse(response => {
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
  const editorContext = await browser.newContext({ baseURL: new URL(baseURL!).origin })
  try {
    const editorUsername = `qa26-opt36-editor-${Date.now()}`
    const editor = await editorContext.newPage()
    await editor.goto('/register')
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
    await editor.goto(`/a/${account.id}/works`)
    const editorLink = editor.getByTestId('work-row-link').filter({ hasText: title })
    const editorButton = editorLink.locator('xpath=..').getByRole('button', { name: '编辑作品标签' })
    await expect(editorButton).toBeVisible()
    await editorButton.click()
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
  } finally {
    await editorContext.close()
  }
  console.log(`G4-16 Web 标签保存/筛选/搜索/editor旅程 ${(Date.now() - journeyStartedAt) / 1000}s`)
})
