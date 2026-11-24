import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

/**
 * OPT-W05：新建作品流（原 nw-p0..p5，位于 Web E2E）的桌面防回归浓缩。
 *
 * 只保留桌面端此前没有覆盖、且一旦回归会造成真实数据/流程损失的核心断言：
 * 1. 新建作品面板：取消不建、空标题可创建、选题带入标题、文章形态默认正确；
 * 2. 新建作品防重：一次性幂等键 + 提交中禁点，重复提交不产生第二篇；
 * 3. H-02/H-03：桌面空作品标题占位、正文空态直达大纲、没有观点不能确认大纲；
 * 4. NW-C5：观点被另一处改写时不静默覆盖，用户明确选择版本；标题回车即保存；
 * 5. 检查回退：打开检查页不自动开始、空正文检查项可回正文、页头可返回创作；
 * 6. 新建模板：模板决定作品形态并显示结构。
 *
 * 未迁入项（已由桌面其它 spec 覆盖或属纯展示）：页头命名、微头条第 4 步内部名称、
 * 图片计数/封面空态文案、首次路径营销文案；这些不涉及数据安全或确认门控。
 */

async function enableDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

async function openCreatePanel(page: Page) {
  await page.getByRole('button', { name: '新建作品', exact: true }).first().click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(panel).toBeVisible()
  return panel
}

test('NW-A1 桌面新建作品：取消不建、空标题可创建、选题带入标题', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '面板里的选题', angle: '从一个小切口开始' })
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}/works`)
  const panel = await openCreatePanel(page)
  await expect(panel.getByPlaceholder('未命名作品')).toHaveValue('')
  await expect(panel.getByRole('radio', { name: '文章', exact: true })).toBeChecked()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(panel).toHaveCount(0)
  // listWorks 直接返回 JSON 数组（分页元数据在响应头），不是 { items }。
  expect(await api(page, 'GET', `/accounts/${account.id}/works`)).toHaveLength(0)
  // 空标题也能创建：作品以「未命名作品」占位，不阻断进入编辑器。
  await page.getByRole('button', { name: '新建作品', exact: true }).first().click()
  await expect(panel).toBeVisible()
  const blank = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/works`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  const blankWork = await blank.then((response) => response.json())
  await page.waitForURL(new RegExp(`/works/${blankWork.id}$`))
  expect(blankWork.title).toBe('')
  await expect(page.getByPlaceholder('未命名作品 · 标题可以最后再定')).toHaveValue('')
  // 从选题开始：选题标题带入，作品记录 topic_id 与归属。
  await page.goto(`/a/${account.id}/works`)
  const second = await openCreatePanel(page)
  const topicSelect = second.getByRole('combobox', { name: /从选题开始（可选）/ })
  await expect(topicSelect.locator('option', { hasText: '面板里的选题' })).toHaveCount(1)
  await topicSelect.selectOption({ label: '面板里的选题' })
  await expect(second.getByPlaceholder('未命名作品')).toHaveValue('面板里的选题')
  const fromTopic = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/works`) && response.request().method() === 'POST')
  await second.getByRole('button', { name: '开始创作', exact: true }).click()
  const topicWork = await fromTopic.then((response) => response.json())
  await page.waitForURL(new RegExp(`/works/${topicWork.id}$`))
  expect(topicWork.topic_id).toBe(topic.id)
  expect(topicWork.assignee_id).toBeTruthy()
  expect(topicWork.created_by).toBeTruthy()
})

test('NW-F1 桌面新建作品：模板决定形态并显示结构', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}/works`)
  const panel = await openCreatePanel(page)
  const templateSelect = panel.getByRole('combobox', { name: /模板（可选）/ })
  await expect(templateSelect.locator('option', { hasText: '观点文（内置）' })).toHaveCount(1)
  await templateSelect.selectOption({ label: '观点文（内置）' })
  await expect(panel.getByText(/提出观点 → 论据一/)).toBeVisible()
  const created = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/works`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  const work = await created.then((response) => response.json())
  await page.waitForURL(new RegExp(`/works/${work.id}$`))
  expect(work.content_format).toBe('long_article')
  expect(work.template_id).toBeTruthy()
})

test('NW-A2 桌面新建作品防重：只发一次带幂等键的创建请求', async ({ page }) => {
  const account = await registerAccount(page)
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}/works`)
  const panel = await openCreatePanel(page)
  await panel.getByPlaceholder('未命名作品').fill('防重验收')
  const pattern = `**/api/v1/accounts/${account.id}/works`
  let posts = 0
  let idempotencyKey = ''
  const handler = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posts++
    idempotencyKey = route.request().headers()['idempotency-key'] ?? ''
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue()
  }
  await page.route(pattern, handler)
  try {
    const created = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/works`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '开始创作', exact: true }).click()
    // 提交中按钮被锁，第二次点击无法再发请求。
    await expect(panel.getByRole('button', { name: '开始创作', exact: true })).toBeDisabled()
    const work = await created.then((response) => response.json())
    expect(posts).toBe(1)
    expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    await page.waitForURL(new RegExp(`/works/${work.id}$`))
    await page.unroute(pattern, handler)
    // 同一个幂等键重放：服务端返回同一篇作品，不会产生第二篇。
    const replay = await page.evaluate(async ({ path, key, body }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': key },
        body: JSON.stringify(body),
      })
      return { status: response.status, work: await response.json() }
    }, { path: `/accounts/${account.id}/works`, key: idempotencyKey, body: { title: '防重验收' } })
    expect(replay.status).toBe(200)
    expect(replay.work.id).toBe(work.id)
    const list = await api(page, 'GET', `/accounts/${account.id}/works`)
    expect(list.filter((item: { id: string }) => item.id === work.id)).toHaveLength(1)
    expect(list).toHaveLength(1)
  } finally {
    await page.unroute(pattern, handler)
  }
})

test('NW-B1/B2/C2 桌面空作品：标题占位、正文空态直达大纲、无观点不能确认大纲', async ({ page }) => {
  const account = await registerAccount(page)
  await enableDesktopPresentation(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '' })
  await page.goto(`/works/${work.id}`)
  await expect(page.getByPlaceholder('未命名作品 · 标题可以最后再定')).toBeVisible()
  await expect(page.getByText('确认大纲后，这里会按大纲生成段落块，然后你可以逐段起草和修改。')).toBeVisible()
  // H-03：桌面正文空态直接打开大纲对话框，不要求用户去别的页签找入口。
  await page.getByRole('button', { name: '去写大纲', exact: true }).click()
  const outline = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '生成与确认大纲', exact: true }) })
  await expect(outline).toBeVisible()
  await outline.getByRole('button', { name: '添加一项', exact: true }).click()
  await outline.getByPlaceholder('段落小标题').fill('第一段')
  const confirm = outline.getByRole('button', { name: '确认大纲', exact: true })
  // H-02：有结构但还没有用户自己的观点时，确认大纲保持禁用并说明原因。
  await expect(confirm).toBeDisabled()
  await expect(outline.getByText('先写下你的核心观点，才能生成或确认大纲。')).toBeVisible()
  await page.locator('#step-viewpoint textarea').first().fill('先有观点，再谈结构。')
  await page.locator('#step-viewpoint textarea').first().blur()
  await expect(confirm).toBeEnabled()
})

test('NW-C5 桌面观点防吞字：外部改写后弹对比，保留我的版本；标题回车即保存', async ({ page }) => {
  const account = await registerAccount(page)
  await enableDesktopPresentation(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '观点冲突验收' })
  await page.goto(`/works/${work.id}`)
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await viewpoint.fill('第一版观点：禁止静默覆盖。')
  const firstSave = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'PATCH')
  await viewpoint.blur()
  expect((await firstSave).status()).toBe(200)
  const fresh = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '另一处保存的观点。', base_revision: fresh.revision })
  await viewpoint.fill('我这一版的观点。')
  await viewpoint.blur()
  const conflict = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '核心观点已在其他地方修改过', exact: true }) })
  await expect(conflict).toBeVisible()
  await expect(conflict).toContainText('另一处保存的观点。')
  await expect(conflict).toContainText('我这一版的观点。')
  await conflict.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).viewpoint).toBe('我这一版的观点。')
  const title = page.locator('#step-title input').first()
  await title.fill('回车即保存的标题')
  const titled = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${work.id}`) && response.request().method() === 'PATCH' && !!response.request().postDataJSON()?.title)
  await title.press('Enter')
  expect((await titled).status()).toBe(200)
  expect((await api(page, 'GET', `/works/${work.id}`)).title).toBe('回车即保存的标题')
})

test('NW-D1/D3/D4 桌面检查页：不自动开始、空正文可回正文、页头可返回创作', async ({ page }) => {
  const account = await registerAccount(page)
  await enableDesktopPresentation(page)
  // 检查页右栏是 lg:sticky 长列；1440×1000 时列表底部链接会被粘性滚动裁在视口外，
  // Playwright 无法把它滚进视口。这里提高桌面视口高度，保持真实用户可点的位置。
  await page.setViewportSize({ width: 1440, height: 1400 })
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '' })
  let checkPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/works/${work.id}/checks`) checkPosts++
  })
  await page.goto(`/works/${work.id}/check`)
  await expect(page.getByRole('heading', { name: '发布前检查', exact: true }).first()).toBeVisible()
  // 打开检查页只是只读预览，不能偷偷开始检查。
  await page.waitForTimeout(800)
  expect(checkPosts).toBe(0)
  expect((await api(page, 'GET', `/works/${work.id}/checks/latest`)).run).toBeNull()
  await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(() => checkPosts).toBe(1)
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}/checks/latest`)).run?.fact_status, { timeout: 30000 }).not.toBe('pending')
  const emptyItem = page.getByRole('button', { name: /还没有正文，先确认大纲并起草/ })
  await expect(emptyItem).toBeVisible()
  // 空正文检查项把用户送回正文，而不是只给一句失败结论。
  const toSections = page.getByRole('link', { name: '去写正文', exact: true })
  await toSections.scrollIntoViewIfNeeded()
  await toSections.click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}#step-sections$`))
  await page.goto(`/works/${work.id}/check`)
  await page.getByRole('link', { name: '返回创作', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
})
