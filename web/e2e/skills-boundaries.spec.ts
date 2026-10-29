import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const definition = (name: string) => ({ name, summary: '边界验收', triggers: '测试时使用', instructions: '已有草稿正文。', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' })
const modal = (page: Page) => page.getByRole('dialog', { name: '技能编辑', exact: true })
const confirmDialog = (page: Page, name: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name, exact: true }) })

test('TestSkillDraftFailureKeepsFormAndReplacementRequiresConfirmation', async ({ page }) => {
  await registerAccount(page)
  await page.goto('/settings/skills')
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByLabel(/^名称/).fill('已有输入')
  await dialog.getByLabel(/^完整指令正文/).fill('原来的正文不能被失败草稿替换。')
  await dialog.getByPlaceholder('描述你想要的技能，例如：起草小红书笔记开头的方法').fill('请起草方法')
  let calls = 0
  await page.route('**/api/v1/skills/draft', async route => {
    calls++
    await route.fulfill({ contentType: 'text/event-stream', body: 'event: stage\ndata: {"stage":"generating"}\n\nevent: error\ndata: {"error":{"code":"ai_output_invalid","message":"测试模型草拟失败，原输入已保留"}}\n\n' })
  })
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  const replace = confirmDialog(page, '替换当前技能草稿？')
  await replace.getByRole('button', { name: '取消', exact: true }).click()
  expect(calls).toBe(0)
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await replace.getByRole('button', { name: '生成并替换', exact: true }).click()
  await expect(dialog.getByText('测试模型草拟失败，原输入已保留', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('已有输入')
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue('原来的正文不能被失败草稿替换。')
  expect((await api(page, 'GET', '/skills?view=library&scope=personal')).total).toBe(0)
  await page.unroute('**/api/v1/skills/draft')
  await page.route('**/api/v1/skills/draft', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: stage\ndata: {"stage":"generating"}\n\n' }))
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await replace.getByRole('button', { name: '生成并替换', exact: true }).click()
  await expect(dialog.getByText('未取得完整生成结果，当前输入已保留，请重试', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue('原来的正文不能被失败草稿替换。')
})

test('TestSkillDraftActualLocalModelRequiresExplicitSave', async ({ page }) => {
  await registerAccount(page)
  await page.goto('/settings/skills')
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByPlaceholder('描述你想要的技能，例如：起草小红书笔记开头的方法').fill('起草一个简洁写法的技能')
  await dialog.getByRole('button', { name: '生成草稿', exact: true }).click()
  await expect(dialog.getByLabel(/^名称/)).not.toHaveValue('')
  await expect(dialog.getByLabel(/^完整指令正文/)).not.toHaveValue('')
  expect((await api(page, 'GET', '/skills?view=library&scope=personal')).total).toBe(0)
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(dialog).toBeHidden()
  const saved = await api(page, 'GET', '/skills?view=library&scope=personal')
  expect(saved.total).toBe(1)
  expect(saved.items[0].origin).toBe('manual')
})

test('TestSkillFileImportAndAgentOnlyTaskControls', async ({ page }) => {
  await registerAccount(page)
  await page.goto('/settings/skills')
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByLabel('选择技能文件').setInputFiles({ name: 'single.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nformat_version: 1\nname: 文件导入\nsummary: 单文件边界\ntriggers: 测试\ntask_enabled: false\nagent_enabled: true\ntasks: [title]\n---\n完整文件正文。') })
  await expect(dialog.getByLabel('导入 Markdown 内容')).toContainText('完整文件正文。')
  await dialog.getByRole('button', { name: '解析预览', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: '仅智能体', exact: true })).toBeChecked()
  await expect(dialog.getByRole('button', { name: 'title', exact: true })).toBeDisabled()
  await dialog.getByRole('radio', { name: '两者', exact: true }).check()
  await expect(dialog.getByRole('button', { name: 'title', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(dialog).toBeHidden()
  const list = await api(page, 'GET', '/skills?view=library&scope=personal')
  expect(list.items[0]).toMatchObject({ origin: 'imported', task_enabled: true, agent_enabled: true, task_types: ['title'] })
})

test('TestSkillDefinitionQuotaDisablesSaveWithoutChangingScope', async ({ page }) => {
  await registerAccount(page)
  for (let i = 0; i < 50; i++) await api(page, 'POST', '/skills', { scope: 'personal', ...definition(`额度-${i}`) })
  await page.goto('/settings/skills')
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByLabel(/^名称/).fill('不能自动换范围')
  await dialog.getByLabel(/^用途/).fill('额度测试')
  await dialog.getByLabel(/^触发说明/).fill('额度测试')
  await dialog.getByLabel(/^完整指令正文/).fill('保留草稿。')
  await expect(dialog.getByText(/该范围定义额度已满/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '创建技能', exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('保存范围')).toHaveValue('personal')
  await expect(dialog.getByRole('link', { name: '管理已有技能', exact: true })).toBeVisible()
})

test('TestSkillBindingSerializesPartitionAndRetainsFailedIntent', async ({ page }) => {
  const account = await registerAccount(page)
  const ids: string[] = []
  for (const name of ['串行甲', '串行乙']) {
    const skill = (await api(page, 'POST', '/skills', { scope: 'personal', ...definition(name) })).skill
    ids.push(skill.id)
    const before = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)
    await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skill.id}`, { enabled: true, base_revision: before.mine.base_revision })
  }
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/skill-bindings/personal/${ids[0]}`, async route => {
    await held
    await route.fulfill({ status: 409, json: { error: { code: 'stale', message: '测试绑定配置已更新' } } })
  }, { times: 1 })
  const first = page.getByTestId(`skill-binding-${ids[0]}`)
  const second = page.getByTestId(`skill-binding-${ids[1]}`)
  await first.getByRole('switch').click()
  await expect(second.getByRole('switch')).toBeDisabled()
  await expect(second.getByRole('spinbutton')).toBeDisabled()
  release()
  await expect(page.getByText(/服务器值已重新读取/)).toBeVisible()
  await expect(first.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: '重试这一项', exact: true }).click()
  await expect(first).toBeHidden()
  await expect(second.getByRole('switch')).toBeEnabled()
})

test('TestSkillPreviewErrorsAreNotShownAsEmptyAndWorkFormatIsUsed', async ({ page }) => {
  await registerAccount(page)
  const account = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '预览用头条号', content_format: 'long_article', type_note: '' })
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '微头条预览', content_format: 'micro_post' })
  let previewFails = true
  await page.route('**/skill-context?*', route => previewFails ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: '测试预览读取失败' } } }) : route.continue())
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  await expect(page.getByText('测试预览读取失败', { exact: true }).first()).toBeVisible()
  previewFails = false
  await page.getByRole('button', { name: '重试', exact: true }).first().click()
  await expect(page.getByText(/预览装配/)).toBeVisible()
  const request = page.waitForResponse(r => r.url().includes('/skill-context?') && new URL(r.url()).searchParams.get('work_id') === work.id)
  await page.getByLabel('预览作品', { exact: true }).selectOption(work.id)
  const result = await (await request).json()
  expect(result.context.target_format).toBe('micro_post')
  await expect(page.getByLabel('目标形态', { exact: true })).toBeDisabled()
})

test('TestSkillNavigationAndBrowserBackKeepUnsavedDraftOnCancel', async ({ page }) => {
  const account = await registerAccount(page)
  await page.getByRole('button', { name: /^用户菜单/ }).click()
  await page.getByRole('button', { name: '高级设置', exact: true }).click()
  await page.getByRole('menuitem', { name: '写作技能', exact: true }).click()
  const skillsHistoryIndex = await page.evaluate(() => history.state.idx as number)
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByLabel(/^名称/).fill('导航保护草稿')
  // 通过实际主导航发起 SPA 跳转；外层弹窗可访问性层不影响事件路径。
  await page.getByRole('link', { name: '工作台', exact: true }).dispatchEvent('click', { button: 0 })
  const guard = confirmDialog(page, '放弃未保存的技能？')
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('导航保护草稿')
  await page.evaluate(() => history.back())
  // 取消前一次 SPA 跳转会把目标历史项替换回技能页；第一次后退仍是同一路径。
  await expect.poll(() => page.evaluate(() => history.state.idx)).toBe(skillsHistoryIndex)
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('导航保护草稿')
  await page.evaluate(() => history.back())
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(dialog.getByLabel(/^名称/)).toHaveValue('导航保护草稿')
  expect(account.id).toBeTruthy()
})

test('TestSkillExpiredSessionKeepsDraftBeforeLoginRedirect', async ({ page }) => {
  await registerAccount(page)
  await page.goto('/settings/skills')
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  const dialog = modal(page)
  await dialog.getByLabel(/^名称/).fill('会话过期保留')
  await dialog.getByLabel(/^用途/).fill('测试')
  await dialog.getByLabel(/^触发说明/).fill('测试')
  await dialog.getByLabel(/^完整指令正文/).fill('失效会话不能把草稿卸载。')
  await page.route('**/api/v1/skills', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: '会话已失效' } } }) : route.continue())
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(dialog.getByRole('link', { name: '在新窗口登录', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue('失效会话不能把草稿卸载。')
})

test('TestSkillMissingDefinitionCanBecomeNewPersonalDraft', async ({ page }) => {
  await registerAccount(page)
  const skill = (await api(page, 'POST', '/skills', { scope: 'personal', ...definition('对象消失时的草稿') })).skill
  await page.goto('/settings/skills')
  await page.locator('div.flex.items-start.gap-3.px-5', { hasText: skill.name }).getByTitle('编辑', { exact: true }).click()
  const dialog = modal(page)
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue('已有草稿正文。')
  await page.route(`**/api/v1/skills/${skill.id}`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '对象已不可用' } } }) : route.continue())
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await dialog.getByRole('button', { name: '另建为个人草稿', exact: true }).click()
  await dialog.getByLabel(/^名称/).fill('重新建立的个人草稿')
  await expect(dialog.getByLabel(/^完整指令正文/)).toHaveValue('已有草稿正文。')
  await dialog.getByRole('button', { name: '创建技能', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect((await api(page, 'GET', '/skills?view=library&scope=personal')).total).toBe(2)
})

test('TestSkillBindingQuotaStillAllowsSingleCancellationAndReenable', async ({ page }) => {
  const account = await registerAccount(page)
  let revision = (await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)).mine.base_revision
  const ids: string[] = []
  for (let i = 0; i < 21; i++) {
    const skill = (await api(page, 'POST', '/skills', { scope: 'personal', ...definition(`绑定额度-${String(i).padStart(2, '0')}`) })).skill
    ids.push(skill.id)
    if (i < 20) revision = (await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skill.id}`, { enabled: true, base_revision: revision })).base_revision
  }
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  const region = page.getByRole('region', { name: '我的个人技能', exact: true })
  await expect(region.getByText(/绑定额度已满/)).toBeVisible()
  await expect(region.getByRole('button', { name: '启用所选个人技能', exact: true })).toBeDisabled()
  const row = page.getByTestId(`skill-binding-${ids[0]}`)
  await row.getByRole('switch').click()
  await expect(row).toBeHidden()
  await expect(region.getByLabel('选择个人技能', { exact: true })).toBeEnabled()
  await region.getByLabel('选择个人技能', { exact: true }).selectOption(ids[0])
  await region.getByRole('button', { name: '启用所选个人技能', exact: true }).click()
  await expect(row).toBeVisible()
  expect((await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)).mine.count).toBe(20)
})

test('TestSkillAccountSwitchRejectsLatePreviewFromPreviousAccount', async ({ page }) => {
  const first = await registerAccount(page)
  const second = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '迟到响应目标账号', content_format: 'image_note', type_note: '' })
  const secondSkill = (await api(page, 'POST', '/skills', { scope: 'personal', ...definition('当前账号正确技能') })).skill
  const before = await api(page, 'GET', `/accounts/${second.id}/skill-bindings`)
  await api(page, 'PUT', `/accounts/${second.id}/skill-bindings/personal/${secondSkill.id}`, { enabled: true, base_revision: before.mine.base_revision })
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { arrived = resolve })
  await page.route(`**/accounts/${first.id}/skill-context?*`, async route => {
    arrived(); await held
    await route.fulfill({ json: { context_status: 'ok', can_execute: true, budget: 3600, assembled_chars: 1, personal_used_count: 0, items: [{ id: 'old-context', name: '迟到的旧账号内容', scope: 'workspace', revision: 1, selected: true, used: true, chars: 1, reason: null }] } }).catch(() => undefined)
  })
  try {
    await page.goto(`/a/${first.id}/profile?tab=skills`)
    await started
    const me = await api(page, 'GET', '/auth/me')
    await page.locator('header').getByRole('button').filter({ hasText: me.workspace.name }).first().click()
    await page.getByTestId('workspace-account-menu').getByRole('button', { name: second.name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/a/${second.id}/profile`))
    await page.getByRole('button', { name: '写作技能', exact: true }).click()
    await expect(page.getByTestId(`skill-binding-${secondSkill.id}`)).toBeVisible()
    release()
    await expect(page.getByText('迟到的旧账号内容', { exact: true })).toHaveCount(0)
    await expect(page.getByText('当前账号正确技能').first()).toBeVisible()
  } finally { release() }
})

