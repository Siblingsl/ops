import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { _electron } from '@playwright/test'
import { api, createOutline, electronLocalSettingsClick, electronLocalSettingsEvaluate, electronLocalSettingsReadStatus, electronLocalSettingsSetValue, electronLocalSettingsWaitIdle, electronLocalSettingsWaitPanel, registerAccount, selectDesktopSetting } from './support'

async function enableElectronPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

/**
 * 桌面形态的「添加账号」入口在顶栏账号下拉里（web/src/layout/Shell.tsx:766-775 的 title="添加账号" 图标按钮），
 * 而 /settings/accounts 的桌面分支只渲染当前账号详情卡片（web/src/pages/settings/Accounts.tsx:459-512），
 * 页面内没有「添加账号」按钮。因此按角色断言这个真实入口，而不是在设置页里找按钮。
 * 注意：设置窗打开时遮罩层（z-index 45）会盖住顶栏，必须先在下拉可点用的页面上调用。
 */
async function expectDesktopAddAccountEntry(page: Page, allowed: boolean) {
  const trigger = page.getByRole('button', { name: '切换工作区与账号', exact: true })
  await trigger.click()
  const menu = page.getByTestId('desktop-context-menu')
  await expect(menu).toBeVisible()
  const entry = menu.getByRole('button', { name: '添加账号', exact: true })
  if (allowed) await expect(entry).toBeVisible()
  else await expect(entry).toHaveCount(0)
  // 再点一次触发器收起菜单：Escape 会被设置窗的按键处理接走并关掉整个设置窗。
  await trigger.click()
  await expect(menu).toHaveCount(0)
}

/**
 * 桌面设置窗内的账号详情：只有所有者可以编辑，非所有者看到只读提示。
 * 依据 web/src/pages/settings/Accounts.tsx:251（CardHeader desc）与 :265-266（账号名称 Input disabled）。
 */
async function expectDesktopAccountEditable(page: Page, editable: boolean) {
  const settingsWindow = page.getByTestId('desktop-settings-window')
  await expect(settingsWindow.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
  const nameInput = settingsWindow.getByLabel('账号名称', { exact: true })
  const readOnlyNotice = settingsWindow.getByText('编辑者可查看账号，修改由所有者操作。', { exact: true })
  if (editable) {
    await expect(nameInput).toBeEnabled()
    await expect(readOnlyNotice).toHaveCount(0)
  } else {
    await expect(nameInput).toBeDisabled()
    await expect(readOnlyNotice).toBeVisible()
    // ST-05：禁用控件统一带悬停说明。
    await expect(nameInput).toHaveAttribute('title', '只有工作区所有者可以修改')
  }
}

test('Electron 专属创作空间的标题栏、主题、动效、工作台与 AI 双栏布局', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    Object.defineProperty(window, '__desktopIntents', { configurable: true, value: [] as string[] })
    Object.defineProperty(window, 'open', { configurable: true, value: (url: string) => { (window as any).__desktopIntents.push(url); return null } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}`)

  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-presentation', 'ops-creative-desktop')
  await expect(page.getByRole('banner', { name: 'OPS 应用标题栏' })).toBeVisible()
  await expect(page.locator('.desktop-titlebar-brand-name, .desktop-titlebar-brand')).toHaveCount(0)
  await expect(page.locator('.desktop-rail-brand-name')).toHaveText('灵感空间')
  await expect(page.locator('.desktop-titlebar')).toHaveCSS('height', '38px')
  await expect.poll(() => page.locator('#main-navigation').evaluate((element) => element.getBoundingClientRect().top)).toBe(38)
  await expect.poll(() => page.locator('header.sticky').evaluate((element) => element.getBoundingClientRect().top)).toBe(38)
  await expect(page.locator('.desktop-titlebar-context')).toHaveCount(0)
  await expect(page.locator('.desktop-titlebar-menus')).toContainText('客户端')
  await expect(page.getByRole('button', { name: '切换工作区与账号', exact: true })).toBeVisible()
  await expect(page.locator('.desktop-workspace-trigger, .desktop-account-trigger')).toHaveCount(0)
  await page.getByRole('button', { name: '切换工作区与账号', exact: true }).click()
  const contextMenu = page.getByTestId('desktop-context-menu')
  await expect(contextMenu.getByRole('tab', { name: /小红书/ })).toHaveAttribute('aria-selected', 'true')
  await expect(contextMenu.getByRole('tabpanel')).toContainText('浏览器验收号')
  await expect(contextMenu.getByRole('button', { name: '管理平台账号', exact: true })).toHaveCount(0)
  await expect(contextMenu.getByText('成员与邀请', { exact: true })).toHaveCount(0)
  await expect(contextMenu.getByRole('button', { name: '创建工作区', exact: true })).toBeVisible()
  await contextMenu.getByRole('tab', { name: /公众号/ }).click()
  await expect(contextMenu.getByRole('tabpanel')).toContainText('暂无公众号账号')
  await expect(contextMenu.getByRole('tabpanel')).not.toContainText('浏览器验收号')
  await contextMenu.getByRole('tab', { name: /小红书/ }).click()
  await expect(contextMenu.getByRole('tabpanel')).toContainText('浏览器验收号')
  await contextMenu.getByRole('tab', { name: /小红书/ }).click({ button: 'right' })
  const platformMenu = page.getByRole('menu')
  await expect(platformMenu.getByRole('menuitem', { name: '添加账号', exact: true })).toBeVisible()
  await expect(platformMenu.getByRole('menuitem', { name: '查看全部', exact: true })).toHaveCount(0)
  await expect(platformMenu.getByRole('menuitem', { name: '邀请成员', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '切换工作区与账号', exact: true }).click()
  await contextMenu.getByRole('tabpanel').getByRole('button', { name: '浏览器验收号' }).click({ button: 'right' })
  const accountContextMenu = page.getByRole('menu')
  await expect(accountContextMenu.getByRole('menuitem', { name: '打开 / 选中', exact: true })).toBeVisible()
  await expect(accountContextMenu.getByRole('menuitem', { name: '添加同平台账号', exact: true })).toBeVisible()
  await expect(accountContextMenu.getByRole('menuitem', { name: '成员与邀请', exact: true })).toHaveCount(0)
  await expect(accountContextMenu.getByRole('menuitem', { name: '编辑账号', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(contextMenu).toHaveCount(0)
  await page.getByRole('button', { name: '切换工作区与账号', exact: true }).click({ button: 'right' })
  const workspaceContextMenu = page.getByRole('menu')
  await expect(workspaceContextMenu.getByRole('menuitem', { name: '创建工作区', exact: true })).toBeVisible()
  await expect(workspaceContextMenu.getByRole('menuitem', { name: '添加账号', exact: true })).toBeVisible()
  await expect(workspaceContextMenu.getByRole('menuitem', { name: '管理平台账号', exact: true })).toHaveCount(0)
  await expect(workspaceContextMenu.getByRole('menuitem', { name: '成员与邀请', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.desktop-nav-back')).toBeVisible()
  await expect.poll(() => page.locator('.desktop-titlebar').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('-webkit-app-region')
  )).toBe('drag')
  await expect(page.getByTestId('desktop-statusbar')).toBeVisible()
  await expect(page.getByTestId('desktop-statusbar')).toHaveCSS('height', '26px')
  await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
  await expect(page.getByRole('heading', { name: '今天，给灵感一点空间。' })).toBeVisible()

  const creationFeature = page.locator('.creation-feature')
  const firstValueGuide = page.getByTestId('desktop-first-value-disclosure')
  const homeExtras = page.getByTestId('desktop-home-extras')
  await expect(creationFeature).toBeVisible()
  await expect(homeExtras).toBeVisible()
  await expect(homeExtras).toHaveJSProperty('open', false)
  await expect(firstValueGuide).toBeHidden()
  expect(await creationFeature.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThan(900)
  await expect(page.locator('#root > div > aside')).toHaveCSS('width', '88px')
  const homeOrder = await page.locator('.desktop-dashboard').evaluate((element) =>
    Array.from(element.children).map((child) => child.classList[0])
  )
  expect(homeOrder.slice(0, 3)).toEqual(['creative-welcome', 'creative-main-grid', 'creative-footer'])
  const leftOrder = await page.locator('.creative-left').evaluate((element) =>
    Array.from(element.children).map((child) => child.classList[0])
  )
  expect(leftOrder).toEqual(['creation-feature', 'journey-row', 'creative-section', 'inspiration-strip'])
  const rightOrder = await page.locator('.creative-right').evaluate((element) =>
    Array.from(element.children).map((child) => child.classList[0])
  )
  expect(rightOrder).toEqual(['today-panel', 'assistant-invite', 'creative-usage'])
  await expect(page.getByRole('heading', { name: '最近打开' })).toBeVisible()
  // DB-05：右栏摘要与主线列表统一成「今天的主线」；页面里另有一处同名的 MainLine 卡片标题，
  // 因此限定在 .today-panel 内断言，避免 strict mode 命中两个 heading。
  await expect(page.locator('.today-panel').getByRole('heading', { name: '今天的主线' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '一个想法，也可以聊聊' })).toBeVisible()
  expect(await page.locator('#main-navigation .desktop-nav-group-label').allTextContents()).toEqual(['创作', '资源', '运营'])
  await expect(page.locator('.desktop-rail-brand')).toBeVisible()
  await expect(page.locator('.desktop-rail-create-shell, .desktop-rail-create')).toHaveCount(0)
  await page.getByRole('button', { name: /记下一条灵感/ }).click()
  const collectDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '随手记' }) })
  await expect(collectDialog).toBeVisible()
  await collectDialog.getByRole('button', { name: '取消' }).click()
  await homeExtras.locator('summary').first().click()
  await expect(firstValueGuide).toBeVisible()
  await expect(firstValueGuide).toHaveJSProperty('open', false)
  await firstValueGuide.locator('summary').click()
  // 实现文案是 CardHeader 的「从第一篇作品开始」（web/src/components/first-value-guide.tsx:35）。
  await expect(firstValueGuide.getByRole('heading', { name: '从第一篇作品开始' })).toBeVisible()
  await expect(firstValueGuide.getByRole('link').first()).toBeVisible()
  await firstValueGuide.locator('summary').click()

  const pageUrl = page.url()
  await page.getByRole('button', { name: '切换到深色主题' }).click()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  expect(page.url()).toBe(pageUrl)
  expect(await page.evaluate(() => (window as any).__desktopIntents)).toContain('ops-desktop://ui/theme/dark')

  await page.keyboard.press('Control+k')
  const commandPalette = page.getByRole('dialog', { name: '命令面板' })
  await expect(commandPalette).toBeVisible()
  expect(await commandPalette.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(43, 39, 57)')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '减少动态效果' }).click()
  await expect(root).toHaveAttribute('data-reduced-motion', 'true')
  await expect(page.getByRole('button', { name: '关闭手动减少动态效果' })).toHaveAttribute('aria-pressed', 'true')

  await page.setViewportSize({ width: 960, height: 640 })
  await page.mouse.move(500, 200)
  const accountNav = page.getByRole('complementary', { name: '主导航' })
  await expect(accountNav).toBeVisible()
  const agentNavigation = accountNav.locator('.desktop-sidebar-bottom a[href="/agent"]')
  await expect(agentNavigation).toBeVisible()
  await expect(agentNavigation).toHaveText('AI 对话')
  await expect(page.getByRole('navigation', { name: '底部导航' })).toBeHidden()
  await agentNavigation.click()
  const privacyNotice = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacyNotice).toBeVisible()
  await privacyNotice.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(page.getByTestId('desktop-agent-list')).toBeHidden()
  const openConversationList = page.getByRole('button', { name: '打开对话列表', exact: true })
  await expect(openConversationList).toBeVisible()
  await openConversationList.click()
  await expect(page.getByRole('heading', { name: '对话', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索对话' }).last()).toBeVisible()
  await page.getByRole('button', { name: '关闭对话列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '对话', exact: true })).toHaveCount(0)
  const widths = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: Array.from(document.querySelectorAll('body *')).map((element) => {
      const rect = element.getBoundingClientRect()
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
    }).filter((element) => element.right > innerWidth + 1).sort((a, b) => b.right - a.right).slice(0, 10),
  }))
  expect(widths.document, JSON.stringify(widths.offenders)).toBeLessThanOrEqual(widths.viewport)
  await page.setViewportSize({ width: 740, height: 640 })
  await expect(accountNav).toBeVisible()
  await expect(page.getByRole('navigation', { name: '底部导航' })).toBeHidden()
  await expect(page.getByTestId('desktop-statusbar')).toBeVisible()

  await page.goto('/settings/accounts')
  await expect(page.getByRole('heading', { name: '平台账号与凭证' })).toBeVisible()
  await page.goto('/settings/members')
  await expect(page.getByRole('heading', { name: '成员与邀请' })).toBeVisible()
})

test('Electron 选题池按原型呈现搜索筛选、选题列表与详情双栏', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '找回节奏的一个小办法', angle: '从每天留出一段不被安排的时间开始。' })
  await enableElectronPresentation(page)
  await page.goto(`/a/${account.id}/topics`)

  await expect(page.getByTestId('desktop-topics-layout')).toBeVisible()
  await expect(page.getByTestId('desktop-topic-list')).toBeVisible()
  await expect(page.getByTestId('desktop-topic-details')).toBeVisible()
  await expect(page.getByTestId('desktop-page-frame')).toHaveCSS('padding-left', '32px')
  await expect(page.getByRole('textbox', { name: '搜索选题' })).toBeVisible()
  await expect(page.getByLabel('选题来源')).toBeVisible()
  await expect(page.getByRole('button', { name: /待定/ })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索选题' }).fill('找回节奏')
  await page.getByRole('button', { name: '找回节奏的一个小办法' }).click()
  await expect(page.getByTestId('desktop-topic-details')).toContainText('找回节奏的一个小办法')
  await expect(page.getByTestId('desktop-topic-list')).toContainText('留出一段不被安排的时间')
  await page.getByRole('textbox', { name: '搜索选题' }).fill('')
  const columns = await page.getByTestId('desktop-topics-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns)
  expect(columns.split(' ').at(-1)).toBe('300px')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/17-electron-topics-light.png') })
  await page.getByRole('textbox', { name: '搜索选题' }).fill('无匹配项')
  await expect(page.getByTestId('desktop-topic-list')).toContainText('没有符合筛选条件的选题')
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/18-electron-topics-empty-light.png') })
})

test('Web 工作区与账号菜单保留原有管理入口', async ({ page }) => {
  const account = await registerAccount(page)
  const accountTrigger = page.getByRole('button').filter({ hasText: account.name })
  await accountTrigger.click()
  const menu = page.getByTestId('workspace-account-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByText('成员与邀请', { exact: true })).toBeVisible()
  await expect(menu.getByText('管理平台账号', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await accountTrigger.click({ button: 'right' })
  const contextMenu = page.getByRole('menu')
  await expect(contextMenu.getByRole('menuitem', { name: '成员与邀请', exact: true })).toBeVisible()
  await expect(contextMenu.getByRole('menuitem', { name: '管理平台账号', exact: true })).toBeVisible()
})

test('Electron 作品与素材库沿用原型的表格与列表详情结构', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: '留给重要的事' })
  await api(page, 'POST', '/materials', {
    account_id: account.id,
    kind: 'experience',
    content: '每周三早上我会关掉消息提醒，留一小时只写作。',
    source: '个人写作记录',
    tags: ['时间管理'],
  })
  await enableElectronPresentation(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto(`/a/${account.id}/works`)
  await expect(page.getByTestId('desktop-works-table')).toBeVisible()
  await expect(page.getByTestId('desktop-works-table')).toContainText('留给重要的事')
  await expect(page.getByTestId('desktop-works-table')).toContainText('计划发布')
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/30-electron-works-table-light.png') })

  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByTestId('desktop-materials-layout')).toBeVisible()
  await expect(page.getByTestId('desktop-material-list')).toContainText('每周三早上我会关掉消息提醒')
  await expect(page.getByTestId('desktop-material-details')).toContainText('个人写作记录')
  await expect(page.getByTestId('desktop-material-details')).toContainText('时间管理')
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/31-electron-materials-detail-light.png') })

  await page.setViewportSize({ width: 960, height: 640 })
  for (const path of [`/a/${account.id}/works`, `/a/${account.id}/materials`]) {
    await page.goto(path)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(dimensions.scrollWidth, `${path} 在 960px 出现横向溢出`).toBeLessThanOrEqual(dimensions.width + 1)
  }
})

test('Electron 运营页用原型选项卡组织六类运营工具', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/ops`)

  const tabs = page.getByRole('tablist', { name: '账号运营功能' })
  await expect(tabs.getByRole('tab')).toHaveCount(6)
  await expect(page.getByTestId('desktop-ops-main')).toBeVisible()
  await expect(page.getByRole('complementary', { name: '创作节奏' })).toBeVisible()
  await page.getByRole('tab', { name: '内容大纲' }).click()
  await expect(page.getByRole('tab', { name: '内容大纲' })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/32-electron-ops-layout-light.png') })

  await page.setViewportSize({ width: 960, height: 640 })
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1)
})

test('Electron 复盘页显示真实数据汇总，图片库支持按描述搜索', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route(`**/api/v1/accounts/${account.id}/board`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'review-work-one', title: '把时间留给自己', status: 'published', published_at: '2026-10-10T09:00:00Z', d7: { day_offset: 7, reads: 1200, favorites: 40, shares: 18, follows_gained: 2 }, nodes: [1, 3, 7], points: 1 },
      { id: 'review-work-two', title: '周末留白', status: 'published', published_at: '2026-10-11T09:00:00Z', d7: { day_offset: 7, reads: 34, favorites: 6, shares: 4, follows_gained: 3 }, nodes: [7], points: 1 },
    ]),
  }))
  await page.route('**/api/v1/assets**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'image-one', work_id: 'work-one', mime: 'image/svg+xml', width: 1200, height: 900, bytes: 512, position: 0, alt_text: '窗边的写作时间', url: '/api/v1/assets/image-one/file', account_id: account.id, account_name: '知行笔记', work_title: '把时间留给自己', ai_generated: false },
      { id: 'image-two', work_id: 'work-two', mime: 'image/svg+xml', width: 1200, height: 900, bytes: 512, position: 0, alt_text: '一页周末清单', url: '/api/v1/assets/image-two/file', account_id: account.id, account_name: '知行笔记', work_title: '周末留白', ai_generated: true },
    ]),
  }))

  await page.goto(`/a/${account.id}/review`)
  await expect(page.getByTestId('desktop-review-stats')).toBeVisible()
  await expect(page.getByTestId('desktop-review-stats')).toContainText('近 7 天阅读')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('粉丝净增')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('1,234')
  await expect(page.getByTestId('desktop-review-stats')).toContainText('46')

  await page.goto('/images')
  await expect(page.getByTestId('desktop-image-search')).toBeVisible()
  await expect(page.getByTestId('desktop-image-grid').getByRole('button')).toHaveCount(2)
  await page.getByTestId('desktop-image-search').fill('窗边')
  await expect(page.getByTestId('desktop-image-grid').getByRole('button')).toHaveCount(1)
  await expect(page.getByTestId('desktop-image-grid')).toContainText('把时间留给自己')
  await page.setViewportSize({ width: 960, height: 640 })
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1)
})

test('Electron 编辑器按原型断点呈现步骤、文稿与工具栏', async ({ page }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const workId = await createOutline(page)
  await page.setViewportSize({ width: 960, height: 640 })
  await page.goto(`/works/${workId}`)

  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-steps')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-content')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-tools')).toBeHidden()
  await expect(page.getByTestId('desktop-editor-layout')).toHaveCSS('grid-template-columns', /136px/)
  await expect(page.getByTestId('desktop-editor-steps')).toContainText('文稿目录')

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByTestId('desktop-editor-tools')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-layout')).toHaveCSS('grid-template-columns', /^166px .* 274px$/)
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/19-electron-editor-light.png') })
})

test('真实 Electron 业务窗按客户端主题与动效呈现', async () => {
  test.skip(process.platform !== 'win32', '仅在 Windows Electron 客户端验收环境运行。')
  expect(process.env.OPS_E2E_PROD).not.toBe('1')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-electron-ui-e2e-'))
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined

  try {
    electronApp = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5179' },
      timeout: 60_000,
    })
    const business = await electronApp.firstWindow()
    await expect.poll(() => electronApp!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().startsWith('http://127.0.0.1:5179') && window.isVisible()
      )
    )).toBe(true)
    await expect.poll(() => business.locator('.desktop-titlebar').evaluate((element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region')
    )).toBe('drag')
    await expect.poll(() => business.locator('.desktop-titlebar-menus a').first().evaluate((element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region')
    )).toBe('no-drag')
    const screenshotDir = resolve(process.cwd(), '../output/playwright/desktop-creative')
    await mkdir(screenshotDir, { recursive: true })
    await business.route('**/api/v1/auth/me', async (route) => {
      const response = await route.fetch()
      const me = await response.json()
      await route.fulfill({ response, json: { ...me, dev: false } })
    })
    await business.route('**/api/v1/desktop/policy', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      // The local E2E server disables the global gate by default; this case covers the enabled policy UI.
      await route.fulfill({ response, json: { ...await response.json(), global_enabled: true } })
    })
    const username = `electron-e2e-${Date.now()}`
    await business.goto('http://127.0.0.1:5179/register')
    await business.getByLabel('用户名', { exact: true }).fill(username)
    await business.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await business.getByRole('button', { name: '创建账号', exact: true }).click()
    const picker = business.getByTestId('desktop-context-menu')
    await expect(picker).toBeVisible()
    await picker.getByRole('tab', { name: /小红书/ }).click()
    await picker.getByRole('button', { name: '添加小红书账号', exact: true }).click()
    const dialog = business.getByRole('dialog').filter({ has: business.getByRole('heading', { name: '添加平台账号', exact: true }) })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('小红书', { exact: true })).toBeVisible()
    await dialog.getByLabel('账号名称').fill('Electron 实际窗口验收号')
    await dialog.getByRole('radio', { name: /^图文笔记/ }).check()
    const created = business.waitForResponse((response) => response.url().endsWith('/api/v1/accounts') && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
    const account = await (await created).json() as { id: string }
    await business.goto(`http://127.0.0.1:5179/a/${account.id}`)

    const businessTheme = business.locator('html')
    await expect(businessTheme).toHaveAttribute('data-presentation', 'ops-creative-desktop')
    await expect(business.getByTestId('desktop-statusbar')).toBeVisible()
    await expect(business.getByTestId('desktop-dashboard')).toBeVisible()
    await business.getByRole('button', { name: '切换工作区与账号', exact: true }).click()
    const workspaceAccountMenu = business.getByTestId('desktop-context-menu')
    await expect(workspaceAccountMenu.getByRole('button', { name: '管理平台账号', exact: true })).toHaveCount(0)
    await expect(workspaceAccountMenu.getByText('成员与邀请', { exact: true })).toHaveCount(0)
    await expect(workspaceAccountMenu.getByRole('button', { name: '创建工作区', exact: true })).toBeVisible()
    await business.keyboard.press('Escape')
    await business.setViewportSize({ width: 1440, height: 900 })
    await expect(business.locator('.creation-feature')).toBeVisible()
    await expect(business.locator('.today-panel')).toBeVisible()
    const homeExtras = business.getByTestId('desktop-home-extras')
    await expect(homeExtras).toBeVisible()
    await expect(homeExtras).toHaveJSProperty('open', false)
    const firstValueGuide = business.getByTestId('desktop-first-value-disclosure')
    await expect(firstValueGuide).toBeHidden()
    await homeExtras.locator('summary').first().click()
    await expect(firstValueGuide).toBeVisible()
    await expect(firstValueGuide).toHaveJSProperty('open', false)
    await firstValueGuide.locator('summary').click()
    // 实现文案是 CardHeader 的「从第一篇作品开始」（web/src/components/first-value-guide.tsx:35）。
    await expect(firstValueGuide.getByRole('heading', { name: '从第一篇作品开始' })).toBeVisible()
    await firstValueGuide.locator('summary').click()
    await homeExtras.locator('summary').first().click()
    await business.locator('main').evaluate((element) => element.scrollTo(0, 0))
    const homePositions = await business.evaluate(() => ({
      featureTop: document.querySelector('.creation-feature')!.getBoundingClientRect().top,
      agendaTop: document.querySelector('.today-panel')!.getBoundingClientRect().top,
      featureBottom: document.querySelector('.creation-feature')!.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
    }))
    expect(Math.abs(homePositions.featureTop - homePositions.agendaTop)).toBeLessThan(40)
    expect(homePositions.featureBottom).toBeLessThan(homePositions.viewportHeight)
    await expect(business.locator('.creation-feature')).not.toContainText('把时间留给真正重要的事')
    await expect(business.locator('.creation-feature').getByRole('button', { name: '新建第一篇作品', exact: true })).toBeVisible()
    const primaryNav = business.getByRole('complementary', { name: '主导航' })
    await expect(primaryNav.getByRole('link', { name: 'AI 对话', exact: true })).toBeVisible()
    expect(await business.evaluate(() => document.documentElement.scrollHeight)).toBe(await business.evaluate(() => innerHeight))
    expect(await primaryNav.locator('nav a span').evaluateAll((spans) => spans.filter((span) => span.scrollWidth > span.clientWidth).map((span) => span.textContent))).toEqual([])
    const railWidth = await primaryNav.evaluate((element) => element.getBoundingClientRect().width)
    await primaryNav.getByRole('link', { name: '图片库', exact: true }).hover()
    await expect(primaryNav).toHaveCSS('width', `${railWidth}px`)
    await primaryNav.getByRole('link', { name: '图片库', exact: true }).click()
    await expect(business).toHaveURL('http://127.0.0.1:5179/images')
    await expect(business.getByRole('heading', { name: '图片库', exact: true })).toBeVisible()
    await primaryNav.getByRole('link', { name: '工作台', exact: true }).click()
    await expect(business.getByTestId('desktop-dashboard')).toBeVisible()
    await business.screenshot({ path: join(screenshotDir, '12-electron-dashboard-light.png') })
    await business.goto(`http://127.0.0.1:5179/a/${account.id}/topics`)
    await expect(business.getByTestId('desktop-topics-layout')).toBeVisible()
    await expect(business.getByTestId('desktop-topic-list')).toBeVisible()
    await expect(business.getByTestId('desktop-topic-details')).toBeVisible()
    await business.screenshot({ path: join(screenshotDir, '20-electron-topics-empty-light.png') })
    await business.goto(`http://127.0.0.1:5179/a/${account.id}`)
    await expect(business.locator('.desktop-toolbar-actions').getByRole('button', { name: '搜索与命令（Ctrl+K）', exact: true })).toBeVisible()
    await expect(business.locator('.desktop-toolbar-actions').getByRole('button', { name: '切换到深色主题', exact: true })).toBeVisible()
    await business.getByRole('button', { name: '切换到深色主题' }).click()
    await expect(businessTheme).toHaveAttribute('data-theme', 'dark')
    await business.screenshot({ path: join(screenshotDir, '13-electron-dashboard-dark.png') })
    await expect.poll(() => electronApp!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    await business.getByRole('button', { name: /用户菜单/ }).click()
    await business.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settings = business.getByTestId('desktop-settings-window')
    await selectDesktopSetting(business, '桌面 AI 策略')
    const policySwitch = settings.getByRole('switch', { name: '允许此工作区使用桌面 AI', exact: true })
    await expect(policySwitch).toBeEnabled()
    if (await policySwitch.getAttribute('aria-checked') !== 'true') await policySwitch.click()
    const policySaved = business.waitForResponse((response) => response.url().endsWith('/api/v1/desktop/policy') && response.request().method() === 'PUT')
    await settings.getByRole('button', { name: '保存工作区策略', exact: true }).click()
    const reauthPrompt = business.getByRole('dialog').filter({ has: business.getByRole('heading', { name: '确认是你本人', exact: true }) })
    if (await reauthPrompt.count()) {
      await reauthPrompt.getByPlaceholder('登录密码').fill('local-e2e-password-123')
      await reauthPrompt.getByRole('button', { name: '确认', exact: true }).click()
    }
    expect((await policySaved).ok()).toBeTruthy()

    await selectDesktopSetting(business, '客户端连接')
    await expect(settings.getByRole('heading', { name: '客户端连接', exact: true })).toBeVisible()
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    // 本机设置视图是 WebContentsView，切换面板时主进程才异步 loadURL（desktop/src/settings-view.ts 的 show()）。
    // 先等这个 webContents 出现，否则 electronLocalSettingsEvaluate 会报「找不到统一设置中的本机面板」。
    await electronLocalSettingsWaitPanel(electronApp!, 'connection')
    const settingsTheme = () => electronLocalSettingsEvaluate<string>(electronApp!, 'document.documentElement.dataset.theme')
    await expect.poll(settingsTheme).toBe('dark')
    const connectionPanel = await electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[]; localBridge: boolean }>(electronApp,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel),localBridge:typeof window.opsDesktopSettings==='object'})`)
    expect(connectionPanel).toEqual({ panel: 'connection', visiblePanels: ['connection'], localBridge: true })
    expect(await business.evaluate(() => typeof (window as any).opsDesktopSettings)).toBe('undefined')

    // 切面板前必须等本机设置空闲：忙的时候离开面板会被拦住（「正在保存设置，请稍候再离开」）。
    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '本机 AI 配置')
    await electronLocalSettingsWaitPanel(electronApp!, 'ai')
    const aiPanel = await electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[] }>(electronApp,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel)})`)
    expect(aiPanel).toEqual({ panel: 'ai', visiblePanels: ['models', 'selftest', 'routes'] })
    await electronLocalSettingsClick(electronApp, '#refresh-models')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('本机配置已刷新。')
    await electronLocalSettingsClick(electronApp, '#clear-form')
    expect(await electronLocalSettingsEvaluate<string>(electronApp, `document.querySelector('#model-name').value`)).toBe('')
    await electronLocalSettingsClick(electronApp, '#start-model-test')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('请先选择本机模型。')
    await electronLocalSettingsClick(electronApp, '#refresh-routes')

    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '账号与设备')
    await electronLocalSettingsWaitPanel(electronApp!, 'account-device')
    const accountPanel = await electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[] }>(electronApp,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel)})`)
    expect(accountPanel).toEqual({ panel: 'account-device', visiblePanels: ['account'] })
    await electronLocalSettingsSetValue(electronApp, '#password', 'local-e2e-password-123')
    await electronLocalSettingsClick(electronApp, '#reauth')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('账号已重新认证，有效期 5 分钟。')

    // reauth 的状态文案先到，activeOperations 还要再跑几百毫秒才归零；此时切面板会被离开保护拦住。
    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '本机 AI 配置')
    await electronLocalSettingsWaitPanel(electronApp!, 'ai')
    await electronLocalSettingsSetValue(electronApp, '#model-name', 'Electron 验收本机模型')
    await electronLocalSettingsSetValue(electronApp, '#base-url', 'http://127.0.0.1:1234/v1/')
    expect(await electronLocalSettingsEvaluate<boolean>(electronApp, `document.querySelector('#model-proxy-mode').disabled`)).toBe(true)
    await electronLocalSettingsSetValue(electronApp, '#model-names', 'e2e-local-model')
    await electronLocalSettingsClick(electronApp, '#save-model')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('配置已保存。密钥未返回页面。')
    const localModelId = await electronLocalSettingsEvaluate<string>(electronApp,
      `Array.from(document.querySelector('#model-select').options).find((option)=>option.value)?.value ?? ''`)
    expect(localModelId).not.toBe('')
    await electronLocalSettingsClick(electronApp, '#clear-form')
    await electronLocalSettingsSetValue(electronApp, '#model-select', localModelId)
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(electronApp, `!document.querySelector('#delete-model').hidden`)).toBe(true)
    await electronApp.evaluate(({ dialog }) => {
      const nativeDialog = dialog as unknown as {
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
        showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath: string }>
      }
      nativeDialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      nativeDialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
    })
    await electronLocalSettingsClick(electronApp, '#delete-model')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('已取消。')
    const testModelValue = (await electronLocalSettingsEvaluate<string[]>(electronApp,
      `Array.from(document.querySelector('#test-model').options).map((option)=>option.value).filter(Boolean)`))[0]
    await electronLocalSettingsSetValue(electronApp, '#test-model', testModelValue)
    // 脚本的完成值会被 IPC 结构化克隆：Object.defineProperty 返回 window，克隆会抛
    // 「An object could not be cloned」，所以包一层 IIFE 显式返回 true。
    await electronLocalSettingsEvaluate(electronApp, `(()=>{Object.defineProperty(window,'confirm',{configurable:true,value:()=>false});return true})()`)
    await electronLocalSettingsClick(electronApp, '#start-model-test')
    expect(await electronLocalSettingsEvaluate<string>(electronApp, `document.querySelector('#test-result').textContent`)).toBe('')
    await electronLocalSettingsClick(electronApp, '#save-routes')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toContain('本机映射草稿已保存')

    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '账号与设备')
    await electronLocalSettingsWaitPanel(electronApp!, 'account-device')
    await electronLocalSettingsClick(electronApp, '#refresh-devices')
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(electronApp, `!!document.querySelector('#device-list .device-item')`)).toBe(true)
    await electronLocalSettingsEvaluate(electronApp, `(()=>{Object.defineProperty(window,'confirm',{configurable:true,value:()=>false});return true})()`)
    await electronLocalSettingsClick(electronApp, '#device-list .device-item button')
    await expect.poll(() => electronLocalSettingsEvaluate<number>(electronApp, `document.querySelectorAll('#device-list .device-item').length`)).toBe(1)
    await electronLocalSettingsClick(electronApp, '#clear-account-data')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('已取消清理。')

    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '诊断与关于')
    await electronLocalSettingsWaitPanel(electronApp!, 'diagnostics')
    const diagnosticsPanel = await electronLocalSettingsEvaluate<{ panel: string; visiblePanels: string[]; about: string }>(electronApp,
      `({panel:document.body.dataset.embeddedPanel,visiblePanels:Array.from(document.querySelectorAll('[data-settings-panel]')).filter((item)=>!item.hidden).map((item)=>item.dataset.settingsPanel),about:document.querySelector('#about-title').textContent})`)
    expect(diagnosticsPanel).toEqual({ panel: 'diagnostics', visiblePanels: ['diagnostics'], about: '关于 OPS' })
    await electronLocalSettingsClick(electronApp, '#export-diagnostics')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('已取消导出。')

    await electronLocalSettingsWaitIdle(electronApp!)
    await selectDesktopSetting(business, '客户端连接')
    await electronLocalSettingsWaitPanel(electronApp!, 'connection')
    await electronLocalSettingsClick(electronApp, '#connect-ai')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('WSS 通道已连接；尚未发起模型自检或启用业务路由。')
    await expect.poll(() => electronLocalSettingsEvaluate<string>(electronApp, `document.querySelector('#channel-state').textContent`)).toContain('WSS 通道已连接')
    await electronLocalSettingsClick(electronApp, '#disconnect-ai')
    await expect.poll(() => electronLocalSettingsReadStatus(electronApp!)).toBe('客户端 AI 通道已断开。')
    // apply-mode 的「已取消。」只存在一瞬：settings.js 的处理器紧接着 await loadInfo()，
    // 而 loadInfo() 收尾会用 setStatus('') 清空 #action-status。所以先挂 MutationObserver 记录状态流，
    // 再点按钮，最后在记录里断言，而不是赌轮询时机。
    await electronLocalSettingsEvaluate(electronApp,
      `(()=>{window.__statusLog=[];const node=document.querySelector('#action-status');new MutationObserver(()=>window.__statusLog.push(node.textContent)).observe(node,{childList:true,characterData:true,subtree:true});return true})()`)
    await electronLocalSettingsClick(electronApp, '#apply-mode')
    await expect.poll(() => electronLocalSettingsEvaluate<string[]>(electronApp, `window.__statusLog`)).toContain('已取消。')
    // 取消后执行模式不变：仍然是可读的「当前模式：…」，且下拉仍可用。
    await expect.poll(() => electronLocalSettingsEvaluate<string>(electronApp, `document.querySelector('#current-mode').textContent`)).toContain('当前模式：')
    await expect.poll(() => electronLocalSettingsEvaluate<boolean>(electronApp, `document.querySelector('#apply-mode').disabled`)).toBe(false)

    // 设置窗的遮罩（web/src/styles/desktop-settings.css 的 .desktop-settings-overlay，z-index 45）
    // 盖住业务窗顶栏，指针点不到主题按钮。先关闭设置窗，用真实点击切浅深主题，
    // 再重开设置窗验证本机设置视图跟随客户端主题。
    await settings.getByRole('button', { name: '关闭设置' }).click()
    await expect(settings).toBeHidden()
    await business.getByRole('button', { name: '切换到浅色主题' }).click()
    await expect(businessTheme).toHaveAttribute('data-theme', 'light')
    await business.getByRole('button', { name: '切换到深色主题' }).click()
    await expect(businessTheme).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => electronApp!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    // 动效按钮在底部状态栏，标签随状态切换（web/src/layout/DesktopStatusBar.tsx）。
    await business.getByRole('button', { name: '减少动态效果', exact: true }).click()
    await expect(businessTheme).toHaveAttribute('data-reduced-motion', 'true')
    await business.getByRole('button', { name: '关闭手动减少动态效果', exact: true }).click()
    await expect(businessTheme).toHaveAttribute('data-reduced-motion', 'false')
    await business.getByRole('button', { name: /用户菜单/ }).click()
    await business.getByRole('menuitem', { name: '设置…', exact: true }).click()
    await expect(settings).toBeVisible()
    await selectDesktopSetting(business, '客户端连接')
    await electronLocalSettingsWaitPanel(electronApp!, 'connection')
    await expect.poll(settingsTheme).toBe('dark')
    await business.screenshot({ path: join(screenshotDir, '14-electron-client-settings-dark.png') })
    await settings.getByRole('button', { name: '关闭设置' }).click()
    await expect(settings).toBeHidden()
    await business.setViewportSize({ width: 960, height: 640 })
    await business.getByRole('complementary', { name: '主导航' }).getByRole('link', { name: 'AI 对话' }).click()
    await expect(business.getByTestId('desktop-agent-list')).toBeVisible()
    const privacyNotice = business.getByRole('dialog').filter({ has: business.getByRole('heading', { name: '智能体隐私说明' }) })
    if (await privacyNotice.isVisible()) await privacyNotice.getByRole('button', { name: '我知道了' }).click()
    await expect(privacyNotice).toBeHidden()
    await business.locator('main').evaluate((element) => element.scrollTo(0, 0))
    await business.waitForTimeout(220)
    await business.screenshot({ path: join(screenshotDir, '15-electron-agent-dark.png'), animations: 'disabled' })
    const widths = await business.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    expect(widths.document).toBeLessThanOrEqual(widths.viewport)

    await business.goto(`http://127.0.0.1:5179/a/${account.id}`)
    const workId = await createOutline(business)
    await expect(business.getByText('大纲已确认，可以逐段起草了')).toBeHidden({ timeout: 12_000 })
    await business.setViewportSize({ width: 1440, height: 900 })
    await expect(business.getByTestId('desktop-editor-steps')).toBeVisible()
    await expect(business.getByTestId('desktop-editor-tools')).toBeVisible()
    await expect(business.getByTestId('desktop-editor-layout')).toHaveCSS('grid-template-columns', /^166px .* 274px$/)
    await business.locator('main').evaluate((element) => element.scrollTo(0, 0))
    await business.waitForTimeout(220)
    await business.screenshot({ path: join(screenshotDir, '16-electron-editor-light.png'), animations: 'disabled' })
    const readWork = () => business.evaluate(async (id) => {
      const response = await fetch(`/api/v1/works/${id}`, { credentials: 'include' })
      if (!response.ok) throw new Error(`读取作品失败：HTTP ${response.status}`)
      return response.json()
    }, workId)
    const savedWork = await readWork()
    expect(savedWork.outline_confirmed_at).toBeTruthy()
    expect(savedWork.sections.length).toBeGreaterThan(0)
    await business.reload()
    const reloadedWork = await readWork()
    expect(reloadedWork).toMatchObject({ id: workId, outline_confirmed_at: savedWork.outline_confirmed_at })
    expect(reloadedWork.sections).toHaveLength(savedWork.sections.length)
    await business.setViewportSize({ width: 960, height: 640 })
    await business.getByRole('button', { name: `用户菜单：${username}`, exact: true }).click()
    await business.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settingsWindow = business.getByTestId('desktop-settings-window')
    const settingsWindowBox = await settingsWindow.boundingBox()
    expect(settingsWindowBox!.y + settingsWindowBox!.height).toBeLessThanOrEqual(await business.evaluate(() => innerHeight))
    await selectDesktopSetting(business, '每日推荐设置')
    await expect(business).toHaveURL('http://127.0.0.1:5179/settings/daily')
    await business.goto(`http://127.0.0.1:5179/works/${workId}`)
    const stepLinks = business.getByTestId('desktop-editor-steps').locator('a')
    await expect(stepLinks).toHaveCount(5)
    for (const step of await stepLinks.all()) {
      expect((await step.boundingBox())!.height).toBeLessThanOrEqual(32)
    }
    // ED-05：左栏是「内容进度」，页头流程条是「发布进度」，两套语义必须都能被区分。
    await expect(business.getByTestId('creation-progress')).toHaveText('2/5')
    await expect(business.getByTestId('desktop-work-layout').getByRole('navigation', { name: '发布进度' })).toBeVisible()
    await expect(business.getByTestId('desktop-work-layout').locator('.desktop-workbar-flow-label')).toHaveText('发布进度：内容写完后按状态推进')
    await expect(business.getByRole('navigation', { name: '发布进度' }).locator('a').first()).toHaveAttribute('aria-current', 'page')
    await business.setViewportSize({ width: 1440, height: 900 })
    await primaryNav.getByRole('link', { name: '作品', exact: true }).click()
    await expect(business.getByTestId('desktop-work-row')).toHaveCount(1)
    await business.getByTestId('desktop-work-row').getByRole('button', { name: '更多', exact: true }).click()
    const workMenu = business.getByRole('menu')
    await expect(workMenu.getByRole('menuitem', { name: '复制为新草稿', exact: true })).toBeFocused()
    const workMenuBox = await workMenu.boundingBox()
    expect(workMenuBox).not.toBeNull()
    expect(workMenuBox!.x).toBeGreaterThanOrEqual(0)
    expect(workMenuBox!.x + workMenuBox!.width).toBeLessThanOrEqual(await business.evaluate(() => innerWidth))
    expect(await workMenu.evaluate((element) => element.parentElement === document.body)).toBe(true)
    await workMenu.getByRole('menuitem', { name: '复制为新草稿', exact: true }).click()
    await expect(business).toHaveURL(/\/works\/[a-f0-9-]+$/)
    expect(business.url().endsWith(workId)).toBe(false)
    await expect(business.getByTestId('desktop-editor-layout')).toBeVisible()
    await business.locator('.desktop-work-more').getByRole('button', { name: '更多', exact: true }).click()
    await expect(business.getByRole('menuitem', { name: '口述 / 要点扩写', exact: true })).toBeVisible()
    const editorMenuBox = await business.getByRole('menu').boundingBox()
    expect(editorMenuBox!.y).toBeGreaterThan(40)
    expect(editorMenuBox!.y + editorMenuBox!.height).toBeLessThanOrEqual(await business.evaluate(() => innerHeight))
    await business.keyboard.press('Escape')
    await expect(business.getByRole('menu')).toBeHidden()
    await expect(business.locator('.desktop-work-more').getByRole('button', { name: '更多', exact: true })).toBeFocused()
  } finally {
    if (electronApp) {
      try { execFileSync('taskkill', ['/PID', String(electronApp.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
      await Promise.race([electronApp.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 2000))])
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('Electron 呈现分支逐页直达功能路由并通过常用屏幕尺寸矩阵', async ({ page }) => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // 注册流程先用原 Web 页面完成，再对相同业务会话启用 Electron 呈现分支。
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  const root = page.locator('html')
  const workId = await createOutline(page)
  const createdWork = await api(page, 'GET', `/works/${workId}`)
  expect(createdWork.outline_confirmed_at).toBeTruthy()
  expect(createdWork.sections.length).toBeGreaterThan(0)
  await page.reload()
  const reloadedWork = await api(page, 'GET', `/works/${workId}`)
  expect(reloadedWork.sections).toHaveLength(createdWork.sections.length)

  const guestRoutes = ['/login', '/register', '/setup', '/preview/desktop-expired-token']
  for (const path of guestRoutes) {
    await test.step(`访客/公开路由 ${path}`, async () => {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(root).toHaveAttribute('data-presentation', 'ops-creative-desktop')
      await expect(page.locator('body')).toBeVisible()
    })
  }

  const accountRoutes = ['topics', 'calendar', 'works', 'materials', 'review', 'profile', 'ops']
  const settingsRoutes = [
    'preferences', 'accounts', 'members', 'models', 'agent', 'usage', 'quality', 'words', 'prompts',
    'export', 'logs', 'trash', 'security', 'admin', 'crawl', 'hot-sources', 'daily',
  ]
  const appRoutes = [
    `/`,
    `/a/${account.id}`,
    ...accountRoutes.map((path) => `/a/${account.id}/${path}`),
    '/search', '/share', '/images', '/agent', `/agent/c/${crypto.randomUUID()}`,
    `/works/${workId}`, `/works/${workId}/compare`, `/works/${workId}/preview`, `/works/${workId}/check`,
    `/works/${workId}/check/report`, `/works/${workId}/push`, `/works/${workId}/pack`,
    ...settingsRoutes.map((path) => `/settings/${path}`),
  ]

  await page.setViewportSize({ width: 960, height: 640 })
  for (const path of appRoutes) {
    await test.step(`Electron 页面 ${path}`, async () => {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(root).toHaveAttribute('data-presentation', 'ops-creative-desktop')
      await expect(page.locator('body')).toBeVisible()
      const sizing = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      expect(sizing.scrollWidth, `${path} 在 ${sizing.width}px 出现页面横向溢出`).toBeLessThanOrEqual(sizing.width + 1)
    })
  }

  // owner 不具备系统管理员权限时，系统管理路由必须回到账号设置。
  // 桌面形态下 DesktopSettingsHost 会把 /settings/accounts 补成当前账号的深链
  // （/settings/accounts?id={accountId}，见 web/src/layout/DesktopSettingsHost.tsx:146-150），
  // 因此这里允许可选的 ?id= 查询参数。
  const accountsSettingsURL = /\/settings\/accounts(?:\?id=[^&#]+)?$/
  await page.goto('/settings/admin')
  await expect(page).toHaveURL(accountsSettingsURL)
  await page.goto('/settings/crawl')
  await expect(page).toHaveURL(accountsSettingsURL)
  await page.goto('/settings')
  await expect(page.getByTestId('desktop-settings-window').getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()

  const responsiveRoutes = [
    `/a/${account.id}`, `/a/${account.id}/topics`, `/a/${account.id}/calendar`, `/a/${account.id}/works`,
    `/a/${account.id}/materials`, `/a/${account.id}/ops`, `/a/${account.id}/review`, `/a/${account.id}/profile`, `/works/${workId}`, `/works/${workId}/check`,
    '/agent', '/images',
  ]
  // 设置路由在桌面形态下以设置窗呈现（web/src/layout/DesktopSettingsHost.tsx:272 用 backdrop 顶替
  // 背景路由），Shell 与状态栏都不渲染，因此这些路径断言设置窗而不是状态栏。
  const responsiveSettingsRoutes = ['/settings/accounts', '/settings/models']
  const viewports = [
    [960, 640], [1024, 768], [1280, 800], [1440, 900], [1920, 1080],
  ] as const
  const visualRoutes = new Map([
    [`/a/${account.id}/works`, '21-electron-works-light.png'],
    [`/a/${account.id}/calendar`, '22-electron-calendar-light.png'],
    [`/a/${account.id}/materials`, '23-electron-materials-light.png'],
    ['/images', '24-electron-images-light.png'],
    [`/a/${account.id}/ops`, '25-electron-ops-light.png'],
    [`/a/${account.id}/review`, '26-electron-review-light.png'],
    [`/a/${account.id}/profile`, '27-electron-profile-light.png'],
    ['/settings/accounts', '28-electron-settings-light.png'],
    ['/settings/models', '29-electron-models-light.png'],
  ])
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    for (const path of responsiveRoutes) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(root).toHaveAttribute('data-presentation', 'ops-creative-desktop')
      if (path.startsWith('/settings/')) {
        await expect(page.getByTestId('desktop-settings-window')).toBeVisible()
      } else {
        await expect(page.getByTestId('desktop-statusbar')).toBeVisible()
      }
      const sizing = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      expect(sizing.scrollWidth, `${path} 在 ${width}×${height} 出现页面横向溢出`).toBeLessThanOrEqual(sizing.width + 1)
      if (width === 1440 && visualRoutes.has(path)) {
        await page.waitForTimeout(250)
        await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative', visualRoutes.get(path)!), animations: 'disabled' })
      }
    }
    for (const path of responsiveSettingsRoutes) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(root).toHaveAttribute('data-presentation', 'ops-creative-desktop')
      const settingsWindow = page.getByTestId('desktop-settings-window')
      await expect(settingsWindow).toBeVisible()
      const sizing = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      expect(sizing.scrollWidth, `${path} 在 ${width}×${height} 出现页面横向溢出`).toBeLessThanOrEqual(sizing.width + 1)
      const bounds = await settingsWindow.boundingBox()
      expect(bounds, `${path} 在 ${width}×${height} 没有可见的设置窗`).toBeTruthy()
      expect(bounds!.x + bounds!.width, `${path} 在 ${width}×${height} 超出视口`).toBeLessThanOrEqual(width + 1)
      if (width === 1440 && visualRoutes.has(path)) {
        await page.waitForTimeout(250)
        await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative', visualRoutes.get(path)!), animations: 'disabled' })
      }
    }
  }

  // 页面错误态仍有可见重试入口，并能回到真实服务端数据。
  await page.setViewportSize({ width: 960, height: 640 })
  const dashboardEndpoint = `/api/v1/accounts/${account.id}/dashboard`
  let failing = true
  const matchDashboard = (url: URL) => url.pathname === dashboardEndpoint
  await page.route(matchDashboard, (route) => failing
    ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Electron 工作台临时故障，请重试' } } })
    : route.continue())
  await page.goto(`/a/${account.id}`, { waitUntil: 'domcontentloaded' })
  const alert = page.locator('main').getByRole('alert')
  await expect(alert.getByText('Electron 工作台临时故障，请重试')).toBeVisible()
  const retry = alert.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeVisible()
  await expect(retry).toBeEnabled({ timeout: 6_000 })
  failing = false
  await retry.click()
  await expect(page.getByTestId('desktop-dashboard')).toBeVisible()
  await page.unroute(matchDashboard)

  expect(pageErrors).toEqual([])
})

test('Electron 呈现分支保留 owner、editor 与 viewer 的页面操作权限', async ({ page, browser }) => {
  const account = await registerAccount(page)
  await enableElectronPresentation(page)
  await page.goto(`/a/${account.id}`)
  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
  await expect(page.getByRole('button', { name: '新建作品', exact: true }).first()).toBeVisible()
  // 顶栏下拉里的「添加账号」只在非设置页可点（设置窗遮罩 z-index 45 盖住顶栏 z-30）。
  await expectDesktopAddAccountEntry(page, true)
  await page.goto('/settings/accounts')
  await expectDesktopAccountEditable(page, true)

  const viewerInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const editorInvite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 })
  const origin = new URL(page.url()).origin
  const memberContexts = await Promise.all([
    browser.newContext({ baseURL: origin }),
    browser.newContext({ baseURL: origin }),
  ])
  const [viewerContext, editorContext] = memberContexts
  try {
    await Promise.all(memberContexts.map((context) => context.addInitScript(() => {
      const userAgent = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    })))
    const viewerRegistration = await viewerContext.request.post('/api/v1/auth/register', {
      data: { username: `desktop-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: viewerInvite.code },
    })
    const editorRegistration = await editorContext.request.post('/api/v1/auth/register', {
      data: { username: `desktop-editor-${Date.now()}`, password: 'local-e2e-password-123', invite_code: editorInvite.code },
    })
    expect(viewerRegistration.ok()).toBeTruthy()
    expect(editorRegistration.ok()).toBeTruthy()

    const viewer = await viewerContext.newPage()
    await viewer.goto(`/a/${account.id}`)
    await expect(viewer.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
    expect((await api(viewer, 'GET', '/auth/me')).role).toBe('viewer')
    await expect(viewer.getByRole('button', { name: '新建作品', exact: true })).toHaveCount(0)
    await expectDesktopAddAccountEntry(viewer, false)
    await viewer.goto('/settings/accounts')
    await expectDesktopAccountEditable(viewer, false)

    const editor = await editorContext.newPage()
    await editor.goto(`/a/${account.id}`)
    await expect(editor.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
    expect((await api(editor, 'GET', '/auth/me')).role).toBe('editor')
    await expect(editor.getByRole('button', { name: '新建作品', exact: true }).first()).toBeVisible()
    await expectDesktopAddAccountEntry(editor, false)
    await editor.goto('/settings/accounts')
    await expectDesktopAccountEditable(editor, false)
  } finally {
    await Promise.all(memberContexts.map((context) => context.close()))
  }
})
