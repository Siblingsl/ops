import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const mockModelBaseURL = process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1'

// 桌面 Agent 页角色选择仅在 can_use=true 时可操作；先完成一次模拟模型能力自检。
async function prepareUsableModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'A6 桌面角色验收模拟模型', base_url: mockModelBaseURL, api_key: 'local-a6-roles-desktop-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, { model: 'mock-agent-tested' })
}

async function openAgentSettings(page: Page) {
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await page.getByRole('button', { name: '我知道了', exact: true }).click({ timeout: 5_000 }).catch(() => undefined)
  await expect(privacy).toHaveCount(0)
  await page.getByRole('button', { name: '对话设置', exact: true }).click()
  return page.getByTestId('agent-role-select')
}

test('REF41 A6 桌面：角色管理持久化、启停与内置角色只读', async ({ page }) => {
  test.setTimeout(60_000)
  await registerAccount(page, '图文笔记', 'xhs', `a6-roles-desktop-${Date.now()}`)
  await prepareUsableModel(page)

  // 桌面 agent workspace 的角色选择来自同一份 GET /agent-roles；设置页保存后刷新应仍可见。
  const select = await openAgentSettings(page)
  await expect(select).toBeVisible()
  await select.selectOption({ index: 1 })
  expect(await select.inputValue()).not.toBe('')
  await page.keyboard.press('Escape')

  await page.goto('/settings/agent')
  await expect(page.getByRole('heading', { name: '智能体设置', exact: true })).toBeVisible()
  const manager = page.getByTestId('agent-role-manager')
  await expect(manager).toBeVisible()
  const before = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string; name: string; builtin_key: string }> }
  const builtin = before.roles.find((role) => role.builtin_key)
  expect(builtin, JSON.stringify(before)).toBeTruthy()
  // 内置角色没有删除入口，但仍可停用。
  await expect(manager.getByTestId(`agent-role-delete-${builtin!.id}`)).toHaveCount(0)
  await expect(manager.getByTestId(`agent-role-toggle-${builtin!.id}`)).toBeVisible()

  await manager.getByTestId('agent-role-create').click()
  const form = page.getByTestId('agent-role-form')
  await expect(form).toBeVisible()
  await form.getByTestId('agent-role-name').fill('桌面发布巡检员')
  await form.getByTestId('agent-role-persona').fill('巡检发布任务状态，只读回报，不代点发布。')
  await form.getByTestId('agent-role-tools').fill('publish_task__')
  await form.getByTestId('agent-role-rounds').fill('6')
  await form.getByTestId('agent-role-seconds').fill('240')
  const createResponse = page.waitForResponse((r) => r.url().endsWith('/api/v1/agent-roles') && r.request().method() === 'POST')
  await page.getByTestId('agent-role-save').click()
  expect((await createResponse).ok()).toBeTruthy()
  await expect(form).toBeHidden()

  const afterCreate = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string; name: string; persona: string; tool_allowlist: string[]; max_rounds: number; max_seconds: number; status: string }> }
  const role = afterCreate.roles.find((item) => item.name === '桌面发布巡检员')
  expect(role, JSON.stringify(afterCreate)).toBeTruthy()
  expect(role).toMatchObject({ max_rounds: 6, max_seconds: 240, status: 'active' })
  expect(role!.tool_allowlist).toEqual(['publish_task__'])
  const row = manager.getByTestId(`agent-role-row-${role!.id}`)
  await expect(row).toContainText('publish_task__')

  // 桌面设置页走 useSettingsDraft；保存后刷新页面，角色仍在列表中。
  await page.reload()
  await expect(page.getByTestId('agent-role-manager')).toBeVisible()
  await expect(page.getByTestId(`agent-role-row-${role!.id}`)).toContainText('桌面发布巡检员')

  await page.getByTestId(`agent-role-edit-${role!.id}`).click()
  await page.getByTestId('agent-role-persona').fill('巡检发布任务状态，只读回报；不授予发布执行工具。')
  const patchPersona = page.waitForResponse((r) => r.url().endsWith(`/api/v1/agent-roles/${role!.id}`) && r.request().method() === 'PATCH')
  await page.getByTestId('agent-role-save').click()
  expect((await patchPersona).ok()).toBeTruthy()
  await expect(page.getByTestId(`agent-role-row-${role!.id}`)).toContainText('不授予发布执行工具')

  await page.getByTestId(`agent-role-toggle-${role!.id}`).click()
  await expect(page.getByTestId(`agent-role-row-${role!.id}`)).toContainText('已停用')
  const disabledValue = await page.getByTestId(`agent-role-row-${role!.id}`).getByText('已停用', { exact: true }).textContent()
  expect(disabledValue).toBe('已停用')
  await page.getByTestId(`agent-role-toggle-${role!.id}`).click()
  await expect(page.getByTestId(`agent-role-row-${role!.id}`)).toContainText('生效')

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId(`agent-role-delete-${role!.id}`).click()
  await expect(page.getByTestId(`agent-role-row-${role!.id}`)).toHaveCount(0)
  const finalRoles = await api(page, 'GET', '/agent-roles') as { roles: Array<{ id: string }> }
  expect(finalRoles.roles.some((item) => item.id === role!.id)).toBe(false)

  // 回到 Agent 页，已删除角色不能继续出现在选择器里。
  const emptySelect = await openAgentSettings(page)
  await expect(emptySelect).toBeVisible()
  await expect(emptySelect.locator(`option[value="${role!.id}"]`)).toHaveCount(0)
  await page.screenshot({ path: '../.playwright-results/desktop-renderer/a6-agent-roles.png', fullPage: true })
})
