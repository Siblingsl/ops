import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, finishChecks, registerAccount } from './support'

/** Web 形态的顶部「工作区 · 账号」触发器没有 aria-label，按工作区名定位（dense 页头按钮很少）。 */
async function openAccountMenu(page: Page) {
  const me = await api(page, 'GET', '/auth/me')
  await page.locator('header').getByRole('button').filter({ hasText: me.workspace.name }).first().click()
  return page.getByTestId('workspace-account-menu')
}

/** 标题卡里的标题输入框（`Field` 的 label 包住了字数计数，只能按容器取第一个文本框）。 */
function titleInput(page: Page) {
  return page.locator('#step-title').getByRole('textbox').first()
}

/** 公众号标题超过 32 字时编辑器 flush 会抛错，用来验证「保存失败就不切换」。 */
async function makeFlushFail(page: Page) {
  const title = titleInput(page)
  await expect(title).toBeVisible()
  await title.fill('这是一条超过三十二个字的公众号标题用来验证切换前必须先保存成功的分支')
  await title.blur()
  await expect(title).toHaveValue('这是一条超过三十二个字的公众号标题用来验证切换前必须先保存成功的分支')
}

test('DB-02/DB-03 待回填与待办列给"查看全部"，不再静默截断', async ({ page }) => {
  const account = await registerAccount(page)
  // 造 4 篇作品（drafting），验证"全部作品待办"分组在超过 6 条时给"查看全部（N）"。
  for (let i = 0; i < 7; i++) await api(page, 'POST', `/accounts/${account.id}/works`, { title: `作品${i}` })
  await page.goto(`/a/${account.id}`)
  const allTodos = page.getByRole('heading', { name: '全部作品待办' })
  await expect(allTodos).toBeVisible()
  // "进行中"分组有 7 条，超过 6 条必须给可点的"查看全部（N）"。
  const viewAll = page.getByRole('link', { name: /查看全部（\d+）/ })
  await expect(viewAll.first()).toBeVisible()
  await expect(viewAll.first()).toHaveAttribute('href', /\/works\?status=/)

  // 待回填区块：没有待回填时不出现"查看全部待回填"，也不显示三级路径文案。
  await expect(page.getByText('展开「更多工作台信息')).toHaveCount(0)
})

test('WL-01 可发布状态的行点击进入发布页，而不是编辑器', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  let work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { title: '可发布的作品', base_revision: work.revision })
  work = await api(page, 'GET', `/works/${id}`)
  for (const section of work.sections) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: '这一段写清楚了结论和理由。', base_revision: section.revision })
  }
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600; canvas.height = 600
    canvas.getContext('2d')!.fillStyle = '#f4e3c1'; canvas.getContext('2d')!.fillRect(0, 0, 600, 600)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const me = await api(page, 'GET', '/auth/me')
  const upload = await page.request.post(`/api/v1/works/${id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'wl01.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } },
  })
  expect(upload.ok()).toBeTruthy()
  await finishChecks(page, id)
  expect((await api(page, 'GET', `/works/${id}`)).status).toBe('ready')

  await page.goto(`/a/${account.id}/works`)
  // 只取作品列表里的行（侧栏"最近打开"也链到同一篇）。
  const row = page.getByTestId('work-row-link').filter({ hasText: '可发布的作品' }).first()
  await expect(row).toHaveAttribute('href', new RegExp(`/works/${id}/pack$`))
  const publishAction = page.getByRole('button', { name: '去发布', exact: true }).first()
  await expect(publishAction).toBeVisible()
  await publishAction.click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/pack$`))
})

test('GL-01 375px 移动端更多菜单两次点击可到达一级页面与设置', async ({ page }) => {
  const account = await registerAccount(page)
  await page.setViewportSize({ width: 375, height: 812 })
  const targets: { label: string; path: string; optional?: boolean }[] = [
    { label: '选题池', path: `/a/${account.id}/topics` },
    { label: '内容日历', path: `/a/${account.id}/calendar` },
    { label: '素材库', path: `/a/${account.id}/materials` },
    { label: '复盘', path: `/a/${account.id}/review` },
    { label: '运营', path: `/a/${account.id}/ops` },
    { label: '账号档案', path: `/a/${account.id}/profile` },
    { label: '图片库', path: '/images' },
    { label: 'AI 对话', path: '/agent', optional: true },
    { label: '偏好设置', path: '/settings/preferences' },
  ]
  for (const target of targets) {
    await page.goto(`/a/${account.id}`)
    await page.getByRole('button', { name: '更多导航' }).click()
    const drawer = page.getByRole('dialog', { name: '更多导航' })
    const link = drawer.getByRole('link', { name: target.label, exact: true })
    if (target.optional && await link.count() === 0) continue
    await expect(link).toBeVisible()
    await link.click()
    await expect.poll(() => new URL(page.url()).pathname).toBe(target.path)
  }
})

test('ED-04 预览页按状态给下一步，不再固定"发布前检查"', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  await page.goto(`/works/${id}`)
  await page.goto(`/works/${id}/preview`)
  // drafting：给"去检查"。
  await expect(page.getByRole('button', { name: '去检查' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步：发布前检查' })).toHaveCount(0)
})

/** GL-04：切工作区前先 flush 当前作品，成功后 SPA 内跳转（不再整页 reload）。 */
test('GL-04 切换工作区先保存当前作品，并在 SPA 内跳转', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const second = await api(page, 'POST', '/workspaces', { name: 'GL-04 切换目标工作区', switch: false })
  await page.reload()
  const id = await createOutline(page)

  // 整页刷新会丢掉 window 上的标记；SPA 跳转不会。
  await page.evaluate(() => { (window as unknown as { __opsSpa?: number }).__opsSpa = 1 })
  const order: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (request.method() === 'PATCH' && url.includes(`/api/v1/works/${id}`)) order.push('flush')
    if (request.method() === 'POST' && url.endsWith(`/api/v1/workspaces/${second.id}/switch`)) order.push('switch')
  })
  await titleInput(page).fill('切换工作区之前必须先保存的标题')
  const menu = await openAccountMenu(page)
  await menu.getByRole('button', { name: second.name, exact: true }).click()

  await expect.poll(() => api(page, 'GET', '/auth/me').then((me) => me.workspace.id)).toBe(second.id)
  // 保存发生在切换之前，且全程没有整页刷新。
  expect(order).toContain('flush')
  expect(order.indexOf('flush')).toBeLessThan(order.indexOf('switch'))
  expect(await page.evaluate(() => (window as unknown as { __opsSpa?: number }).__opsSpa)).toBe(1)
  await expect(page).not.toHaveURL(new RegExp(`/works/${id}`))
})

/** GL-04：flush 失败时提示并留在原工作区，不发出切换请求。 */
test('GL-04 切换工作区时保存失败就留在原工作区', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const second = await api(page, 'POST', '/workspaces', { name: 'GL-04 保存失败工作区', switch: false })
  await page.reload()
  const id = await createOutline(page)
  const workspaceBefore = (await api(page, 'GET', '/auth/me')).workspace.id
  await makeFlushFail(page)

  const switched: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/v1/workspaces/${second.id}/switch`)) switched.push(request.url())
  })
  const menu = await openAccountMenu(page)
  await menu.getByRole('button', { name: second.name, exact: true }).click()

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '切换前保存失败：公众号标题超过 32 字' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/works/${id}$`))
  expect((await api(page, 'GET', '/auth/me')).workspace.id).toBe(workspaceBefore)
  expect(switched).toHaveLength(0)
})

/** GL-05：作品页切账号先确认；取消与保存失败都不切换，留在当前作品。 */
test('GL-05 作品页切账号先确认，取消或保存失败都不切换', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const other = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'GL-05 第二个公众号', content_format: 'long_article' })
  await page.reload()
  const id = await createOutline(page)
  const workspaceBefore = (await api(page, 'GET', '/auth/me')).workspace.id

  // 取消：留在当前作品继续编辑。
  let menu = await openAccountMenu(page)
  await menu.getByRole('button', { name: other.name, exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '切换账号？' }) })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('当前作品属于原账号')
  await dialog.getByRole('button', { name: '不切换，继续当前作品' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '账号未切换；当前作品仍属于原账号。' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/works/${id}$`))

  // 保存失败：提示失败原因，账号仍未切换。
  await makeFlushFail(page)
  menu = await openAccountMenu(page)
  await menu.getByRole('button', { name: other.name, exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '切换账号？' }) })
    .getByRole('button', { name: '切换并回到作品列表' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '保存当前作品失败，账号未切换：公众号标题超过 32 字' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/works/${id}$`))
  expect((await api(page, 'GET', '/auth/me')).workspace.id).toBe(workspaceBefore)
})

/** GL-05：确认后跳到新账号的作品列表。 */
test('GL-05 作品页切账号成功后回到新账号的作品列表', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const other = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'GL-05 目标公众号', content_format: 'long_article' })
  await page.reload()
  const id = await createOutline(page)

  const menu = await openAccountMenu(page)
  await menu.getByRole('button', { name: other.name, exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '切换账号？' }) })
    .getByRole('button', { name: '切换并回到作品列表' }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${other.id}/works$`))
  await expect(page).not.toHaveURL(new RegExp(`/works/${id}`))
})
