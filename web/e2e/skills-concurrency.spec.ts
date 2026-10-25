import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('TestSkillInitialImpactCannotSilentlyRebaseAnOlderDefinition', async ({ page }) => {
  await registerAccount(page, '图文笔记', 'xhs', `skill-initial-cas-${Date.now()}`)
  const fields = { name: '载入时发生更新', summary: '并发保护', triggers: '测试时', instructions: '最初读取的正文。', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' }
  const skill = (await api(page, 'POST', '/skills', { scope: 'personal', ...fields })).skill
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { arrived = resolve })
  await page.route(`**/skills/${skill.id}/impact?action=update`, async route => { arrived(); await held; await route.continue() })
  try {
    await page.goto('/settings/skills')
    await page.locator('div.flex.items-start.gap-3.px-5', { hasText: skill.name }).getByTitle('编辑', { exact: true }).click()
    await started
    const impact = await api(page, 'GET', `/skills/${skill.id}/impact?action=update`)
    await api(page, 'PUT', `/skills/${skill.id}`, { ...fields, instructions: '另一个会话的新正文。', base_revision: 1, impact_token: impact.impact_token })
    release()
    const editor = page.getByRole('dialog', { name: '技能编辑', exact: true })
    await expect(editor.getByText(/服务器配置已更新/)).toBeVisible()
    await expect(editor.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled()
    await expect(editor.getByLabel(/^完整指令正文/)).toHaveValue('最初读取的正文。')
    await editor.getByRole('button', { name: '重新载入服务器值', exact: true }).click()
    await expect(editor.getByLabel(/^完整指令正文/)).toHaveValue('另一个会话的新正文。')
    await expect(editor.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled()
  } finally { release() }
})

test('TestSkillPersonalCopyToPublicCancelAndExplicitConfirmation', async ({ page }) => {
  await registerAccount(page, '图文笔记', 'xhs', `skill-public-copy-${Date.now()}`)
  const fields = { name: '本人私有底稿', summary: '另存确认', triggers: '测试时', instructions: '仅在本次单独确认后公开这一份正文。', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' }
  const original = (await api(page, 'POST', '/skills', { scope: 'personal', ...fields })).skill
  await page.goto('/settings/skills')
  const row = page.locator('div.flex.items-start.gap-3.px-5', { hasText: original.name })
  await row.getByRole('button', { name: '另存副本', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '技能编辑', exact: true })
  await editor.getByLabel('保存范围').selectOption('workspace')
  await expect(editor.getByText(/原个人定义保留，公开副本独立/)).toBeVisible()
  await expect(editor.getByRole('button', { name: '创建技能', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  const discard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的技能？', exact: true }) })
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(editor).toBeHidden()
  expect((await api(page, 'GET', '/skills?view=library&scope=workspace')).total).toBe(0)
  await row.getByRole('button', { name: '另存副本', exact: true }).click()
  await editor.getByLabel('保存范围').selectOption('workspace')
  await editor.locator('label', { hasText: '我确认将以上技能内容公开给' }).getByRole('switch').click()
  const posted = page.waitForResponse(r => r.url().endsWith('/api/v1/skills') && r.request().method() === 'POST')
  await editor.getByRole('button', { name: '创建技能', exact: true }).click()
  const response = await posted
  expect(response.status()).toBe(200)
  expect(JSON.stringify(response.request().postDataJSON())).not.toContain(original.id)
  const copied = await api(page, 'GET', '/skills?view=library&scope=workspace')
  expect(copied.total).toBe(1)
  expect((await api(page, 'GET', `/skills/${copied.items[0].id}`)).instructions).toBe(fields.instructions)
  expect((await api(page, 'GET', `/skills/${original.id}`)).revision).toBe(1)
})
