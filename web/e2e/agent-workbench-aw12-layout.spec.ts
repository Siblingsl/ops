import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

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
  await page.getByLabel('用户名', { exact: true }).fill('aw12-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW12 窗口验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW12 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  expect((await api(page, 'GET', '/agent/bootstrap')).features.workbench_ui).toBe(true)
}

test('DEV-AW12 Web 1366/1440/1920 保留既有页面样式', async ({ page, baseURL }) => {
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await prepare(page, baseURL!)
  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.desktop-agent-workbench')).toHaveCount(0)
    await expect(page.getByPlaceholder(/发送消息/)).toBeVisible()
    await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/agent-workbench-aw12-web-${width}.png`) })
  }
})


