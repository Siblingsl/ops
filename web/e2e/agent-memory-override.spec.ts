import { expect, test, type Page } from '@playwright/test'
import { mockModelBaseUrl } from './support'

// CF-P2-MEM-03（27 §11.1.1 / docs/34 §14.1）：Web 端本会话记忆覆盖。
// 「对话设置」Dialog 内挂同等开关（与桌面 MemoryOverrideSwitch 同一服务端契约）；
// 开→PATCH on / 关→off；全局关 + 会话 on 时如实显示未开启与提示。无「全部确认」。

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

test('DEV-P2-MEM-03 Web 对话设置挂会话记忆覆盖开关：on/off 与全局关不可越过', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`memovr-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '记忆覆盖验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'MEM 覆盖 Web mock', base_url: mockModelBaseUrl(), api_key: 'secret-placeholder', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) }).getByRole('button', { name: '我知道了', exact: true }).click()
  const bootstrap = (await api(page, 'GET', '/agent/bootstrap')) as { features: Record<string, boolean> }
  expect(bootstrap.features.personal_memories).toBe(true)

  // 选择账号后发消息建立会话
  const accountButton = page.getByRole('button', { name: '选择操作账号', exact: true })
  if (await accountButton.count()) await accountButton.click()
  else await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  await settings.getByRole('combobox', { name: '选择账号', exact: true }).selectOption(account.id)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  const first = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.locator('textarea').fill('MEM-03 验收：这条消息用于建立会话')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await first).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)

  // 打开对话设置：开关可见、默认继承全局开
  await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  const override = dialog.getByTestId('web-memory-override')
  await expect(override).toBeVisible()
  await expect(override).toContainText('仅本会话')
  await expect(override).not.toContainText('全部确认')
  const useSwitch = override.getByRole('switch', { name: '本会话使用记忆' })
  await expect(useSwitch).toBeChecked({ timeout: 10_000 })

  // 关 → 服务端覆盖 off
  await useSwitch.click()
  await expect(useSwitch).not.toBeChecked({ timeout: 10_000 })
  await expect.poll(async () => {
    const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
    const s = (await api(page, 'GET', `/agent/memory-settings?conversation_id=${convs.items[0].id}`)) as { overrides: Record<string, string> }
    return s.overrides.memory_use_override
  }).toBe('off')

  // 开 → 服务端覆盖 on
  await useSwitch.click()
  await expect(useSwitch).toBeChecked({ timeout: 10_000 })
  await expect.poll(async () => {
    const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
    const s = (await api(page, 'GET', `/agent/memory-settings?conversation_id=${convs.items[0].id}`)) as { overrides: Record<string, string> }
    return s.overrides.memory_use_override
  }).toBe('on')

  // 全局关：会话 on 不能越过。开关重取经再次切换（capture off→off 同值写回触发重取）。
  const current = (await api(page, 'GET', '/agent/memory-settings')) as { revision: number }
  await api(page, 'PATCH', '/agent/memory-settings', { use_enabled: false, expected_revision: current.revision })
  const captureSwitch = override.getByRole('switch', { name: '本会话允许提炼记忆' })
  const captureBefore = await captureSwitch.evaluate((el) => el.getAttribute('aria-checked') === 'true')
  await captureSwitch.click()
  if (captureBefore) await captureSwitch.click()
  await expect(useSwitch).not.toBeChecked({ timeout: 10_000 })
  await expect(override).toContainText('全局「使用记忆」已关闭')

  // 还原：全局开 + 会话覆盖清空
  const now = (await api(page, 'GET', '/agent/memory-settings')) as { revision: number }
  await api(page, 'PATCH', '/agent/memory-settings', { use_enabled: true, expected_revision: now.revision })
  const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
  await api(page, 'PATCH', '/agent/memory-settings', { conversation_id: convs.items[0].id, memory_use_override: 'off', memory_capture_override: '' })
})
