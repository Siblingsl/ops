import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

const E2E_PASSWORD = 'local-e2e-password-123'

test('ST-07 sensitive words added in settings are flagged by the check page', async ({ page }) => {
  const account = await registerAccount(page)
  const word = `st07-${Date.now()}`
  let wordId = ''
  try {
    await page.goto('/settings/words')
    await page.getByLabel('敏感词').fill(word)
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await expect(page.getByText(`已添加 1 个`, { exact: true })).toBeVisible()
    const fixture = (await api(page, 'GET', '/sensitive-words')).find((entry: { word: string }) => entry.word === word)
    expect(fixture).toBeTruthy()
    wordId = fixture.id

    await page.goto(`/a/${account.id}`)
    const workId = await createOutline(page)
    const work = await api(page, 'GET', `/works/${workId}`)
    const section = work.sections[0]
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `这段正文包含测试词 ${word}，用于确认检查结果会指出具体命中。`,
      base_revision: section.revision,
    })
    await api(page, 'POST', `/works/${workId}/checks`, {})
    await expect.poll(async () => {
      const latest = await api(page, 'GET', `/works/${workId}/checks/latest`)
      return latest.run?.items?.some((item: { category: string; message: string }) => item.category === 'sensitive' && item.message.includes(word)) ?? false
    }).toBe(true)
  } finally {
    if (wordId) await api(page, 'DELETE', `/sensitive-words/${wordId}`)
  }
})

test('ST-07 prompt template save creates a new version', async ({ page }) => {
  await registerAccount(page)
  const templates = await api(page, 'GET', '/prompt-templates')
  const template = templates[0]
  expect(template).toBeTruthy()
  const changed = `${template.content}\n\nST07 保存验证 ${Date.now()}`
  try {
    await page.goto('/settings/prompts')
    const row = page.locator('li').filter({ hasText: template.task_type }).first()
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('任务指令').fill(changed)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('已保存新版本（系统规则不可改）', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const current = (await api(page, 'GET', '/prompt-templates')).find((item: { task_type: string }) => item.task_type === template.task_type)
      return current?.content
    }).toBe(changed)
    const saved = (await api(page, 'GET', '/prompt-templates')).find((item: { task_type: string }) => item.task_type === template.task_type)
    expect(saved.content).toBe(changed)
  } finally {
    await api(page, 'PUT', `/prompt-templates/${template.task_type}`, { content: template.content })
  }
})

test('ST-07 password change invalidates another signed-in session', async ({ page, browser }) => {
  const username = `st07-security-${Date.now()}-${test.info().workerIndex}`
  await registerAccount(page, '图文笔记', 'xhs', username)
  const origin = new URL(page.url()).origin
  const otherContext = await browser.newContext({ baseURL: origin })
  try {
    const otherPage = await otherContext.newPage()
    await otherPage.goto('/login')
    await otherPage.getByLabel('用户名', { exact: true }).fill(username)
    await otherPage.getByLabel('密码', { exact: true }).fill(E2E_PASSWORD)
    await otherPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(otherPage.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()

    await page.goto('/settings/security')
    await page.getByLabel('当前密码').fill(E2E_PASSWORD)
    await page.getByLabel('新密码').fill('local-e2e-password-456')
    await page.getByLabel('再输入一次').fill('local-e2e-password-456')
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await expect(page.getByText('密码已修改，其他设备上的登录已失效', { exact: true })).toBeVisible()
    await expect.poll(async () => (await otherContext.request.get(`${origin}/api/v1/auth/me`)).status()).toBe(401)
  } finally {
    await otherContext.close()
  }
})

test('ST-07 workspace hot source switch is saved', async ({ page }) => {
  await registerAccount(page)
  let selected: string[] = []
  let savedSources: string[] | undefined
  const fixture = {
    enabled: true,
    selected,
    sources: [{ key: 'st07-rss', name: 'ST07 验收来源', kind: 'rss', workspace_id: null, config: {} }],
  }
  await page.route('**/api/v1/hot-sources', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, selected }) })
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { sources: string[] }
      savedSources = body.sources
      selected = body.sources
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    return route.continue()
  })
  await page.goto('/settings/hot-sources')
  await page.getByLabel('ST07 验收来源').check()
  await page.getByRole('button', { name: '保存来源', exact: true }).click()
  await expect(page.getByText('热点来源已保存', { exact: true })).toBeVisible()
  expect(savedSources).toEqual(['st07-rss'])
})
