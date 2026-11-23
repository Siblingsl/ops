import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openDesktopAccountSwitcher } from './support'

// CF-P2-MEM-01（27 §11.1.1 / docs/34 §14.1）：上下文页挂「本会话记忆覆盖」开关。
// 开→PATCH memory_use_override=on；关→off；文案明示仅本会话、无「全部确认」。
// 注入语义（关→不注入 / 开→恢复注入）由服务端 TestW13M01 定向覆盖；这里验收 UI 旅程。

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('mem-ovr-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'MEM 覆盖 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const features = (await api(page, 'GET', '/agent/bootstrap')) as { features: Record<string, boolean> }
  expect(features.features.personal_memories).toBe(true)
}

test('DEV-P2-MEM-01 上下文页会话记忆覆盖开关：开→on、关→off、全局关不可越过', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-memovr-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)

    // 新建会话：先建账号并切换（发送需要账号+模型），再发一条消息产生会话（mock 模型）
    await api(page, 'POST', '/accounts', { platform: 'xhs', name: '记忆覆盖验收号', content_format: 'image_note', type_note: '' })
    await page.goto(baseURL! + '/agent')
    const privacyAgain = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    if (await privacyAgain.isVisible().catch(() => false)) await privacyAgain.getByRole('button', { name: '我知道了', exact: true }).click()
    await openDesktopAccountSwitcher(page)
    const picker = page.getByTestId('desktop-context-menu')
    await picker.getByRole('tab', { name: /小红书/ }).click()
    await picker.getByRole('button', { name: '记忆覆盖验收号', exact: true }).click()
    await page.goto(baseURL! + '/agent')
    await expect(page.locator('.desktop-agent-header')).toContainText('记忆覆盖验收号')
    const composer = page.getByRole('textbox', { name: '发送消息' })
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('记忆覆盖验收：这条消息用于建立会话')
    const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 20_000 })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    expect((await sendResponse).ok()).toBeTruthy()
    await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/, { timeout: 30_000 })

    // 打开工作视图 → 上下文页签
    await page.locator('.desktop-agent-panel-button').first().click({ timeout: 15000 })
    const panel = page.getByRole('complementary', { name: '任务面板' })
    await expect(panel).toBeVisible()
    await panel.getByRole('tab', { name: /^上下文/ }).click()

    const override = panel.getByTestId('memory-override')
    await expect(override).toBeVisible()
    // 无「全部确认」类批量控件；文案明示仅本会话
    await expect(override).toContainText('仅本会话')
    await expect(override).not.toContainText('全部确认')

    // 默认继承全局双开：use 勾选为真
    const useSwitch = override.getByTestId('memory-override-use')
    await expect(useSwitch).toBeChecked({ timeout: 10_000 })

    // 关 → PATCH off，服务端覆盖生效
    await useSwitch.click()
    await expect(useSwitch).not.toBeChecked({ timeout: 10_000 })
    await expect.poll(async () => {
      const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
      const settings = (await api(page, 'GET', `/agent/memory-settings?conversation_id=${convs.items[0].id}`)) as { overrides: Record<string, string> }
      return settings.overrides.memory_use_override
    }).toBe('off')

    // 开 → PATCH on
    await useSwitch.click()
    await expect(useSwitch).toBeChecked({ timeout: 10_000 })
    await expect.poll(async () => {
      const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
      const settings = (await api(page, 'GET', `/agent/memory-settings?conversation_id=${convs.items[0].id}`)) as { overrides: Record<string, string> }
      return settings.overrides.memory_use_override
    }).toBe('on')

    // 全局关 → 会话 on 不能越过：UI 如实显示未勾选 + 提示。
    // 通过会话覆盖开关本身触发重取（点击会 PATCH+重 GET，带最新全局值）。
    await api(page, 'PATCH', '/agent/memory-settings', { use_enabled: false, expected_revision: 1 })
    await expect.poll(async () => {
      const convs = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
      const settings = (await api(page, 'GET', `/agent/memory-settings?conversation_id=${convs.items[0].id}`)) as { use_enabled: boolean; global_use_enabled: boolean }
      return settings.global_use_enabled
    }).toBe(false)
    // 会话覆盖已经是 on；把 capture 开关切一下强制 UI 重取（capture 覆盖不动：off→off 不产生语义变化）。
    const captureSwitch = override.getByTestId('memory-override-capture')
    const captureBefore = await captureSwitch.isChecked()
    await captureSwitch.click()
    await captureSwitch.setChecked(captureBefore)
    await expect(useSwitch).not.toBeChecked({ timeout: 10_000 })
    await expect(override).toContainText('全局「使用记忆」已关闭')

    // 还原：全局开（revision 随上面 PATCH 递增；先读再写）
    const globalNow = (await api(page, 'GET', '/agent/memory-settings')) as { revision: number }
    await api(page, 'PATCH', '/agent/memory-settings', { use_enabled: true, expected_revision: globalNow.revision })
    // 会话覆盖恢复 off，避免残留 on 影响其他用例判断
    const convsNow = (await api(page, 'GET', '/agent/conversations')) as { items: Array<{ id: string }> }
    await api(page, 'PATCH', '/agent/memory-settings', { conversation_id: convsNow.items[0].id, memory_use_override: 'off', memory_capture_override: '' })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
})
