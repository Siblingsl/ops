import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

/**
 * OPT-W05：从原 Web 技能库主用例精准迁入桌面形态。
 *
 * 与既有桌面技能 spec 的分工：
 * - skills-boundaries：桌面可直接打开技能库与账号档案技能页（入口/边界）；
 * - skills-electron：真实 Electron 窗口里绑定技能后的生成与私有回执；
 * - skills-procedure：流程技能回放只建计划；
 * - 本文件与 completion/concurrency/history：CRUD 门控、导入往返、账号层自动绑定、
 *   viewer 权限、删除影响预览，以及并发与回执，补足桌面端此前因技能管理被拦截而缺失的断言。
 *
 * 桌面形态适配：全部用例运行在假 Electron UA 的桌面呈现下，技能库从桌面设置窗进入，
 * 不使用 Web 专属的“在浏览器中管理技能”出口。
 */

async function enableDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

async function openSkills(page: Page) {
  await page.goto('/settings/skills')
  await expect(page.getByTestId('desktop-settings-window')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建技能', exact: true })).toBeVisible()
}

const editor = (page: Page) => page.getByRole('dialog', { name: '技能编辑', exact: true })
const rowOf = (page: Page, name: string) => page.locator('div.flex.items-start.gap-3.px-5', { hasText: name })

test('SK1 桌面新建默认个人技能：公开确认门控与账号档案分区', async ({ page }) => {
  const account = await registerAccount(page)
  await enableDesktopPresentation(page)
  await openSkills(page)
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = editor(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('保存范围').locator('option[value="personal"]')).toHaveCount(1)
  await dialog.getByLabel(/^名称/).fill('E2E 个人技能')
  await dialog.getByLabel(/^用途（summary）/).fill('验证技能库创建流程')
  await dialog.getByLabel(/^触发说明/).fill('E2E 测试触发条件')
  await dialog.getByLabel(/^完整指令正文/).fill('这是 E2E 创建的技能正文。')
  // 桌面端同样要求：切到工作区必须先勾选公开确认才能保存。
  await dialog.getByLabel('保存范围').selectOption('workspace')
  const save = dialog.getByRole('button', { name: '创建技能', exact: true })
  await expect(save).toBeDisabled()
  await dialog.locator('label', { hasText: '我确认将以上技能内容公开给' }).getByRole('switch').click()
  await expect(save).toBeEnabled()
  const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/skills') && response.request().method() === 'POST')
  await save.click()
  expect((await created).ok()).toBeTruthy()
  await expect(page.getByText('E2E 个人技能')).toBeVisible()
  // 账号档案的技能分区在桌面端同样可见（个人技能未启用，配置区为空）。
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  await expect(page.getByText('公共技能', { exact: true })).toBeVisible()
  await expect(page.getByText('我的个人技能', { exact: true })).toBeVisible()
})

test('SK2 桌面导入 .md 往返：解析预览、预览后改名、导出字段保留', async ({ page }) => {
  await registerAccount(page)
  await enableDesktopPresentation(page)
  await openSkills(page)
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = editor(page)
  const md = [
    '---', 'format_version: 1', 'name: E2E 导入技能', 'summary: 从 Markdown 导入',
    'triggers: 导入往返触发', 'task_enabled: false', 'agent_enabled: true', '---',
    '导入的正文第一行。', '', '---', '', '正文里的水平线之后。',
  ].join('\n')
  await dialog.getByLabel('导入 Markdown 内容').fill(md)
  await dialog.getByRole('button', { name: '解析预览', exact: true }).click()
  await expect(dialog.getByText(/解析告警/)).toBeHidden()
  await expect(dialog.getByText(/导入内容已解析/)).toBeVisible()
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('E2E 导入技能')
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue(/正文里的水平线之后。/)
  // 仅智能体：task_enabled=false 保留。
  await expect(dialog.getByRole('radio', { name: '仅智能体', exact: true })).toBeChecked()
  // 预览后修改字段：保存必须以编辑后的表单为准，不回退原始文件。
  await dialog.getByLabel(/^名称/).fill('E2E 导入技能（已改）')
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(page.getByText('E2E 导入技能（已改）')).toBeVisible()
  // export → 后端 parse：行为字段保留（含预览后编辑的名称）。
  const skills = await api(page, 'GET', '/skills?view=library&scope=personal&q=E2E%20%E5%AF%BC%E5%85%A5')
  expect(skills.total).toBe(1)
  expect(skills.items[0].name).toBe('E2E 导入技能（已改）')
  expect(skills.items[0].origin).toBe('imported')
  expect(skills.items[0].task_enabled).toBe(false)
  expect(skills.items[0].agent_enabled).toBe(true)
  const exported = await page.request.get(`/api/v1/skills/${skills.items[0].id}/export`)
  const text = await exported.text()
  expect(text).toContain('task_enabled: false')
  expect(text).toContain('agent_enabled: true')
  expect(text).toContain('---\n\n正文里的水平线之后。')
})

test('SK3 桌面账号层技能创建自动绑定与单项停用', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await enableDesktopPresentation(page)
  await openSkills(page)
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = editor(page)
  await dialog.getByLabel('保存范围').selectOption('account')
  await dialog.getByLabel('目标账号').selectOption({ label: '浏览器验收号' })
  await dialog.getByLabel(/^名称/).fill('E2E 账号技能')
  await dialog.getByLabel(/^用途（summary）/).fill('账号层自动绑定验证')
  await dialog.getByLabel(/^触发说明/).fill('账号技能触发条件')
  await dialog.getByLabel(/^完整指令正文/).fill('账号技能正文。')
  await dialog.locator('label', { hasText: '我确认将以上技能内容公开给' }).getByRole('switch').click()
  const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/skills') && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  const createdRes = await created
  expect(createdRes.status(), `创建失败：${createdRes.status()}`).toBe(200)
  const skillId = (await createdRes.json()).skill.id as string
  // 账号层技能只在「账号」页签按账号列出。
  await page.getByRole('button', { name: '账号', exact: true }).click()
  await page.getByLabel('账号').selectOption({ label: '浏览器验收号' })
  await expect(page.getByText('E2E 账号技能')).toBeVisible()
  // 账号档案里已自动绑定，优先级默认 100；单项停用后公共绑定归零。
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  const row = page.getByTestId(`skill-binding-${skillId}`)
  await expect(row.getByText(/优先级 100/)).toBeVisible()
  await row.getByRole('switch').click()
  await expect(page.getByText('已取消启用')).toBeVisible()
  const bindings = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)
  expect(bindings.public.count).toBe(0)
})

test('SK4 桌面 viewer：技能库只可管理个人，公共写与绑定修改被拒', async ({ page, browser }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs')
  await api(page, 'POST', '/skills', {
    scope: 'personal', name: 'Viewer 共享底稿', summary: '观察者边界验证', triggers: '观察者触发条件',
    instructions: '观察者场景正文。', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  })
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 })
  const member = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await member.request.post('/api/v1/auth/register', {
      data: { username: `e2e-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    await member.addInitScript(() => {
      const userAgent = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    })
    const viewer = await member.newPage()
    // viewer 技能库：保存范围只有个人。
    await viewer.goto('/settings/skills')
    await expect(viewer.getByTestId('desktop-settings-window')).toBeVisible()
    await viewer.getByRole('button', { name: '新建技能', exact: true }).click()
    const dialog = editor(viewer)
    await expect(dialog.getByLabel('保存范围').locator('option[value="workspace"]')).toHaveCount(0)
    await expect(dialog.getByLabel('保存范围').locator('option[value="account"]')).toHaveCount(0)
    await dialog.getByLabel(/^名称/).fill('Viewer 个人技能')
    await dialog.getByLabel(/^用途（summary）/).fill('观察者个人库')
    await dialog.getByLabel(/^触发说明/).fill('观察者触发')
    await dialog.getByLabel(/^完整指令正文/).fill('观察者个人正文。')
    await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
    await expect(viewer.getByText('Viewer 个人技能')).toBeVisible()
    // viewer 账号档案技能分区：只读提示。
    await viewer.goto(`/a/${account.id}/profile?tab=skills`)
    await expect(viewer.getByText('观察者不可修改绑定').first()).toBeVisible()
    // viewer 不能创建公共技能（HTTP 403）。
    const denied = await viewer.request.post(new URL('/api/v1/skills', page.url()).toString(), {
      data: { scope: 'workspace', name: 'x', summary: 'y', triggers: 'z', instructions: 'w', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true },
    })
    expect(denied.status()).toBe(403)
  } finally {
    // 页面可能在导航中被应用关闭；清理失败不影响断言结果。
    await member.close().catch(() => undefined)
  }
})

test('SK5 桌面删除技能：影响预览与二次确认', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const skill = await api(page, 'POST', '/skills', {
    scope: 'personal', name: 'E2E 待删除技能', summary: '删除流程验证', triggers: '删除触发条件',
    instructions: '删除流程正文。', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  })
  await enableDesktopPresentation(page)
  await openSkills(page)
  await rowOf(page, 'E2E 待删除技能').getByTitle('删除', { exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除技能', exact: true }) })
  await expect(dialog).toContainText('此操作不可撤销')
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByText('技能已删除')).toBeVisible()
  const list = await api(page, 'GET', '/skills?view=library&scope=personal')
  expect(list.items.find((item: { id: string }) => item.id === skill.id)).toBeUndefined()
})
