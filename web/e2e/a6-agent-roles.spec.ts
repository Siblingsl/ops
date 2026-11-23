import { expect, test, type Page } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// Agent 页的角色选择只在 can_use=true 时可操作；先完成一次模拟模型能力自检。
async function prepareUsableModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A6 角色验收模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-a6-roles-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, { model: 'mock-agent-tested' })
}

async function dismissAgentPrivacy(page: Page) {
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await page.getByRole('button', { name: '我知道了', exact: true }).click({ timeout: 5_000 }).catch(() => undefined)
  await expect(privacy).toHaveCount(0)
}

test('REF41 A6 Web：设置页角色管理 CRUD 与 Agent 页角色选择', async ({ page }) => {
  test.setTimeout(60_000)
  await registerAccount(page, '图文笔记', 'xhs', `a6-roles-web-${Date.now()}`)
  await prepareUsableModel(page)

  await page.goto('/agent')
  await dismissAgentPrivacy(page)
  await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const roleSelect = page.getByTestId('agent-role-select')
  await expect(roleSelect).toBeVisible()
  await roleSelect.selectOption({ index: 1 })
  expect(await roleSelect.inputValue()).not.toBe('')
  await page.keyboard.press('Escape')

  await page.goto('/settings/agent')
  const manager = page.getByTestId('agent-role-manager')
  await expect(manager).toBeVisible()
  const initial = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string; name: string; builtin_key: string; status: string }> }
  const builtin = initial.roles.find((role) => role.builtin_key)
  expect(builtin, JSON.stringify(initial)).toBeTruthy()
  await expect(manager.getByText('内置', { exact: true }).first()).toBeVisible()
  await expect(manager.getByTestId(`agent-role-delete-${builtin!.id}`)).toHaveCount(0)

  await manager.getByTestId('agent-role-create').click()
  const form = page.getByTestId('agent-role-form')
  await expect(form).toBeVisible()
  await form.getByTestId('agent-role-name').fill('E2E 只读核对员')
  await form.getByTestId('agent-role-persona').fill('只核对作品事实与发布回读，不执行写操作。')
  await form.getByTestId('agent-role-tools').fill('works__get\nreview__')
  await form.getByTestId('agent-role-rounds').fill('5')
  await form.getByTestId('agent-role-seconds').fill('120')
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/agent-roles') && r.request().method() === 'POST')
  await page.getByTestId('agent-role-save').click()
  expect((await created).ok()).toBeTruthy()
  await expect(form).toBeHidden()

  const afterCreate = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string; name: string; persona: string; tool_allowlist: string[]; max_rounds: number; max_seconds: number; status: string }> }
  const custom = afterCreate.roles.find((role) => role.name === 'E2E 只读核对员')
  expect(custom, JSON.stringify(afterCreate)).toBeTruthy()
  expect(custom).toMatchObject({ max_rounds: 5, max_seconds: 120, status: 'active' })
  expect(custom!.tool_allowlist).toEqual(['works__get', 'review__'])
  const row = manager.getByTestId(`agent-role-row-${custom!.id}`)
  await expect(row).toContainText('E2E 只读核对员')
  await expect(row).toContainText('works__get')
  await expect(row).toContainText('轮数 5 / 秒数 120')

  await manager.getByTestId(`agent-role-edit-${custom!.id}`).click()
  await expect(form).toBeVisible()
  await form.getByTestId('agent-role-name').fill('E2E 只读核对员-改')
  const patched = page.waitForResponse((r) => r.url().endsWith(`/api/v1/agent-roles/${custom!.id}`) && r.request().method() === 'PATCH')
  await page.getByTestId('agent-role-save').click()
  expect((await patched).ok()).toBeTruthy()
  await expect(row).toContainText('E2E 只读核对员-改')

  const toggled = page.waitForResponse((r) => r.url().endsWith(`/api/v1/agent-roles/${custom!.id}`) && r.request().method() === 'PATCH')
  await manager.getByTestId(`agent-role-toggle-${custom!.id}`).click()
  expect((await toggled).ok()).toBeTruthy()
  await expect(row).toContainText('已停用')
  const disabled = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string; status: string }> }
  expect(disabled.roles.find((role) => role.id === custom!.id)?.status).toBe('disabled')

  page.once('dialog', (dialog) => void dialog.accept())
  const deleted = page.waitForResponse((r) => r.url().endsWith(`/api/v1/agent-roles/${custom!.id}`) && r.request().method() === 'DELETE')
  await manager.getByTestId(`agent-role-delete-${custom!.id}`).click()
  expect((await deleted).ok()).toBeTruthy()
  await expect(row).toHaveCount(0)
  const finalRoles = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string }> }
  expect(finalRoles.roles.some((role) => role.id === custom!.id)).toBe(false)
  await page.screenshot({ path: '../.playwright-results/web/a6-agent-roles.png', fullPage: true })
})
