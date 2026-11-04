import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('DEV-QA26 G4-01 Web 已发布旧文逐项标签、筛选与 viewer 只读', async ({ page, browser }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '导入旧文', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '导入已发布旧文', exact: true }) })
  await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('请填写作品标题')
  await dialog.getByLabel('作品标题').fill('QA26 Web 已发布旧文标签')
  await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('请粘贴包含正文的旧文')
  await dialog.getByLabel('发布日期').fill('2024-06-15')
  await dialog.getByLabel('旧文正文').fill('## 操作记录\n\n这篇文章用于验证已发布作品仍可编辑自由标签。')
  await dialog.getByRole('button', { name: '预览分段', exact: true }).click()
  await expect(dialog.getByTestId('import-preview-section')).toHaveCount(1)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('这里还没有作品', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '导入旧文', exact: true }).click()
  const retry = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '导入已发布旧文', exact: true }) })
  await retry.getByLabel('作品标题').fill('QA26 Web 已发布旧文标签')
  await retry.getByLabel('发布日期').fill('2024-06-15')
  await retry.getByLabel('旧文正文').fill('## 操作记录\n\n这篇文章用于验证已发布作品仍可编辑自由标签。')
  await retry.getByRole('button', { name: '预览分段', exact: true }).click()
  await retry.getByRole('button', { name: '确认导入为已发布作品', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const workId = page.url().split('/').pop()!
  const imported = await api(page, 'GET', `/works/${workId}`)
  expect(imported.status).toBe('published')
  expect(imported.locked).toBe(true)
  const revision = imported.revision

  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '编辑作品标签' }).click()
  const tags = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑作品标签', exact: true }) })
  await tags.getByLabel('新增标签').fill('QA26标签')
  await tags.getByRole('button', { name: '添加', exact: true }).click()
  const tagUpdate = page.waitForResponse(response => response.url().endsWith(`/api/v1/works/${workId}`) && response.request().method() === 'PATCH')
  await tags.getByRole('button', { name: '保存标签', exact: true }).click()
  const response = await tagUpdate
  expect(response.status(), await response.text()).toBe(200)
  const tagged = await api(page, 'GET', `/works/${workId}`)
  expect(tagged.tags).toContain('QA26标签')
  expect(tagged.revision).toBe(revision)
  expect(tagged.locked).toBe(true)

  await page.reload()
  await page.getByLabel('按标签筛选').selectOption('QA26标签')
  await expect(page).toHaveURL(/tag=QA26/)
  await expect(page.getByTestId('work-row-link').filter({ hasText: 'QA26 Web 已发布旧文标签' })).toBeVisible()

  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
  const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const username = `qa26-g4-viewer-${Date.now()}`
    const joined = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(joined.ok(), 'viewer 使用 owner 创建的邀请码加入工作区').toBeTruthy()
    const viewer = await viewerContext.newPage()
    await viewer.goto(`/a/${account.id}/works`)
    await expect.poll(() => viewer.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('viewer')
    const viewerRow = viewer.getByTestId('work-row-link').filter({ hasText: 'QA26 Web 已发布旧文标签' })
    await expect(viewerRow).toContainText('QA26标签')
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
    expect(unchanged.tags).toEqual(['QA26标签'])
    expect(unchanged.revision).toBe(revision)
  } finally {
    await viewerContext.close()
  }
})
