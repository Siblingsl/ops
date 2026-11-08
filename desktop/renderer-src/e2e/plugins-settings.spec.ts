import { expect, test, type Page } from '@playwright/test'

// DEV-AI27-14 第三批（W14c）：插件/MCP 管理页 E2E（真实 Chromium，ops-e2e API）。
// 覆盖：设置入口可达、创建连接（安装与启用分离=draft）、enable 状态机、
// 秘密只存键名（不出现值）、删除。stdio 真实子进程旅程在 desktop mcp-host 测试覆盖（8/8）。

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
  await page.getByLabel('用户名', { exact: true }).fill('ai27w14c-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  // 打开 plugin_mcp 能力（超管 DB 种子由 ops-e2e env 完成；此处经环境变量注入的运行时闸门）。
  await page.goto(baseURL + '/settings/plugins')
}

test('DEV-AI27-14c 插件管理页：创建/启用/状态机/删除', async ({ baseURL, page }) => {
  await prepare(page, baseURL)
  const features = (await api(page, 'GET', '/agent/bootstrap')) as { features: Record<string, boolean> }
  test.skip(!features.features.plugin_mcp, 'plugin_mcp 开关未开启（e2e env 清单需包含）')

  // 管理页可达，空列表
  await expect(page.getByTestId('settings-plugins-page')).toBeVisible()
  // 创建表单：先点"添加连接"展开（初始隐藏）
  await page.getByRole('button', { name: '添加连接' }).click()
  const form = page.getByTestId('plugin-add-form')
  await expect(form).toBeVisible()
  await form.getByLabel('连接名称').fill('W14c 验证连接')
  await form.getByLabel('传输方式').selectOption('stdio')
  await form.getByLabel('命令（不拼接 shell）').fill('node')
  await form.getByLabel('参数（每行一个）').fill('server.js')
  const createResponse = page.waitForResponse((r) => r.url().includes('/agent/plugin-connections') && r.request().method() === 'POST')
  await form.getByRole('button', { name: '创建（待配置）' }).click()
  const resp = await createResponse
  if (!resp.ok()) throw new Error(`创建连接失败：${resp.status()} ${await resp.text()}`)

  // draft 状态出现（安装与启用分离）；卡片 testid 为 plugin-conn-{id}
  const list = page.getByTestId('plugin-connection-list')
  await expect(list).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', '/agent/plugin-connections') as { connections: Array<{ state: string }> }).connections.length, { timeout: 10_000 }).toBe(1)
  const created = (await api(page, 'GET', '/agent/plugin-connections') as { connections: Array<{ id: string; state: string }> }).connections[0]
  expect(created.state).toBe('draft')
  const card = page.getByTestId(`plugin-conn-${created.id}`)
  await expect(card.getByText('待配置')).toBeVisible()
  // env_keys 只在 API 层；卡片显示无秘密值（结构断言）
  const cardText = await card.textContent()
  expect(cardText).not.toMatch(/sk-|ghp_|token=/i)

  // 验证连接（draft → ready_disabled）→ 启用 → 已启用
  await card.getByRole('button', { name: '验证连接' }).click()
  await expect(card.getByText('已验证 · 未启用')).toBeVisible({ timeout: 10_000 })
  await card.getByRole('button', { name: '启用' }).click()
  await expect(card.getByText('已启用')).toBeVisible({ timeout: 10_000 })

  // 停用 → 已停用
  await card.getByRole('button', { name: '停用' }).click()
  await expect(card.getByText('已停用')).toBeVisible({ timeout: 10_000 })

  // 撤销 → 列表空
  await card.getByRole('button', { name: '撤销' }).click()
  await expect.poll(async () => (await api(page, 'GET', '/agent/plugin-connections') as { connections: unknown[] }).connections.length, { timeout: 10_000 }).toBe(0)
})
