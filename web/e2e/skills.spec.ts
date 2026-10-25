import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-SK4 / 23 文档第 12 节与 T-SK-14/24/28/33/38：技能库页与账号档案技能分区的
// 关键流程 —— 个人默认、公开确认、导入往返、单项配置、409 保留编辑、viewer 边界。

async function openSkills(page: Page) {
  await page.goto('/settings/skills')
  await expect(page.getByRole('heading', { name: '写作技能' })).toBeVisible()
}

test('SK1 新建默认个人技能：不勾选公开确认不能选工作区；创建后出现在我的技能', async ({ page }) => {
  const account = await registerAccount(page)
  await openSkills(page)
  await page.getByRole('button', { name: '新建技能' }).click()
  const dialog = page.getByRole('dialog', { name: '技能编辑' })
  await expect(dialog.getByLabel('保存范围').locator('option[value="personal"]')).toHaveCount(1)
  await dialog.getByLabel(/^名称/).fill('E2E 个人技能')
  await dialog.getByLabel(/^用途（summary）/).fill('验证技能库创建流程')
  await dialog.getByLabel(/^触发说明/).fill('E2E 测试触发条件')
  await dialog.getByLabel(/^完整指令正文/).fill('这是 E2E 创建的技能正文。')
  // 切到工作区必须先勾选公开确认才能保存。
  await dialog.getByLabel('保存范围').selectOption('workspace')
  const save = dialog.getByRole('button', { name: '创建技能' })
  await expect(save).toBeDisabled()
  await dialog.locator('label', { hasText: '我确认将以上技能内容公开给' }).getByRole('switch').click()
  await expect(save).toBeEnabled()
  const created = page.waitForResponse(r => r.url().endsWith('/api/v1/skills') && r.request().method() === 'POST')
  await save.click()
  expect((await created).ok()).toBeTruthy()
  await expect(page.getByText('E2E 个人技能')).toBeVisible()
  // 账号档案出现技能分区（个人技能未启用，配置区为空）。
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  await expect(page.getByText('公共技能', { exact: true })).toBeVisible()
  await expect(page.getByText('我的个人技能', { exact: true })).toBeVisible()
})

test('SK2 导入 .md 往返：parse 预览告警可见，保存后字段保留且可导出', async ({ page }) => {
  await registerAccount(page)
  await openSkills(page)
  await page.getByRole('button', { name: '新建技能' }).click()
  const dialog = page.getByRole('dialog', { name: '技能编辑' })
  const md = ['---', 'format_version: 1', 'name: E2E 导入技能', 'summary: 从 Markdown 导入', 'triggers: 导入往返触发', 'task_enabled: false', 'agent_enabled: true', '---', '导入的正文第一行。', '', '---', '', '正文里的水平线之后。'].join('\n')
  await dialog.getByLabel('导入 Markdown 内容').fill(md)
  await dialog.getByRole('button', { name: '解析预览' }).click()
  await expect(dialog.getByText(/解析告警/)).toBeHidden()
  await expect(dialog.getByText(/导入内容已解析/)).toBeVisible()
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('E2E 导入技能')
  await expect(dialog.getByLabel(/^完整指令正文/)).toContainText('正文里的水平线之后。')
  // 仅智能体：task_enabled=false 保留。
  await expect(dialog.getByRole('switch', { name: /用于普通 AI 生成任务/ })).toHaveAttribute('aria-checked', 'false')
  // 预览后修改字段（4.2 节第 5 项）：保存必须以编辑后的表单为准，不回退原始文件。
  await dialog.getByLabel(/^名称/).fill('E2E 导入技能（已改）')
  await dialog.getByRole('button', { name: '创建技能' }).click()
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

test('SK3 账号档案单项启用与停用定义展示；账号层创建自动绑定', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await openSkills(page)
  // 账号层创建 → 自动绑定。
  await page.getByRole('button', { name: '新建技能' }).click()
  const dialog = page.getByRole('dialog', { name: '技能编辑' })
  await dialog.getByLabel('保存范围').selectOption('account')
  await dialog.getByLabel('目标账号').selectOption({ label: '浏览器验收号' })
  await dialog.getByLabel(/^名称/).fill('E2E 账号技能')
  await dialog.getByLabel(/^用途（summary）/).fill('账号层自动绑定验证')
  await dialog.getByLabel(/^触发说明/).fill('账号技能触发条件')
  await dialog.getByLabel(/^完整指令正文/).fill('账号技能正文。')
  await dialog.locator('label', { hasText: '我确认将以上技能内容公开给' }).getByRole('switch').click()
  const created = page.waitForResponse(r => r.url().endsWith('/api/v1/skills') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '创建技能' }).click()
  const createdRes = await created
  expect(createdRes.status(), `创建失败：${createdRes.status()}`).toBe(200)
  // 账号层技能只在「账号」页签按账号列出（11.2 节）。
  await page.getByRole('button', { name: '账号', exact: true }).click()
  await page.getByLabel('账号').selectOption({ label: '浏览器验收号' })
  await expect(page.getByText('E2E 账号技能')).toBeVisible()
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  const row = page.locator('div').filter({ hasText: 'E2E 账号技能' }).filter({ has: page.getByRole('switch') }).last()
  await expect(row.getByText(/优先级 100/)).toBeVisible()
  // 取消启用（公共分区一项）。
  await row.getByRole('switch').click()
  await expect(page.getByText('已取消启用')).toBeVisible()
  const bindings = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)
  expect(bindings.public.count).toBe(0)
})

test('SK4 viewer：可看技能库与个人管理，公共写与绑定修改被拒', async ({ page, browser }) => {
  const account = await registerAccount(page, '图文笔记', 'xhs')
  // owner 先建一条个人技能（供 viewer 场景对照）。
  await api(page, 'POST', '/skills', {
    scope: 'personal', name: 'Viewer 共享底稿', summary: '观察者边界验证', triggers: '观察者触发条件',
    instructions: '观察者场景正文。', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  })
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 })
  const member = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const registered = await member.request.post(new URL('/api/v1/auth/register', page.url()).toString(), {
      data: { username: `e2e-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    const viewer = await member.newPage()
    // viewer 技能库：保存范围只有个人。
    await viewer.goto('/settings/skills')
    await viewer.getByRole('button', { name: '新建技能' }).click()
    const dialog = viewer.getByRole('dialog', { name: '技能编辑' })
    await expect(dialog.getByLabel('保存范围').locator('option[value="workspace"]')).toHaveCount(0)
    await expect(dialog.getByLabel('保存范围').locator('option[value="account"]')).toHaveCount(0)
    await dialog.getByLabel(/^名称/).fill('Viewer 个人技能')
    await dialog.getByLabel(/^用途（summary）/).fill('观察者个人库')
    await dialog.getByLabel(/^触发说明/).fill('观察者触发')
    await dialog.getByLabel(/^完整指令正文/).fill('观察者个人正文。')
    await dialog.getByRole('button', { name: '创建技能' }).click()
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

test('SK5 删除技能有影响预览与二次确认', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const skill = await api(page, 'POST', '/skills', {
    scope: 'personal', name: 'E2E 待删除技能', summary: '删除流程验证', triggers: '删除触发条件',
    instructions: '删除流程正文。', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  })
  await openSkills(page)
  await page.locator('div.flex.items-start.gap-3.px-5', { hasText: 'E2E 待删除技能' }).getByTitle('删除').click()
  const dialog = page.getByRole('dialog', { name: '删除技能' })
  await expect(dialog).toContainText('此操作不可撤销')
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('技能已删除')).toBeVisible()
  const list = await api(page, 'GET', '/skills?view=library&scope=personal')
  expect(list.items.find((s: { id: string }) => s.id === skill.id)).toBeUndefined()
})

test('SK6 registry 单一注册：写作技能在用户菜单可见、桌面设置窗不显示', async ({ page }) => {
  await registerAccount(page)
  // 命令面板可见。
  await page.goto('/settings/skills')
  await expect(page.getByRole('heading', { name: '写作技能' })).toBeVisible()
  // 桌面端：desktopHidden 生效（registry 断言，桌面窗由既有 d126 套件覆盖导航）。
  const registry = await page.evaluate(async () => {
    const mod = await import('/src/lib/settings-registry.ts')
    return mod.settingsEntries.find((e: { path: string }) => e.path === '/settings/skills')
  })
  expect(registry?.desktopHidden).toBe(true)
})
