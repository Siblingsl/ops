import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function localApi(page: Page, method: string, path: string, body?: unknown) {
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

async function launchAgent(baseURL: string) {
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-ot06-'))
  const pageErrors: string[] = []
  const app = await _electron.launch({
    executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`ot06-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()
  return { app, page, userData, pageErrors }
}

async function closeAgent(app: ElectronApplication, userData: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app.close()
  if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-ot06-')) throw new Error('拒绝清理测试目录之外路径')
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

test('OT-06 workbench_ui 关闭时回到旧形态且无报错', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const { app, page, userData, pageErrors } = await launchAgent(baseURL!)
  try {
    const bootstrap = await localApi(page, 'GET', '/agent/bootstrap')
    expect(bootstrap.features.workbench_ui).toBe(false)
    expect(bootstrap.features.artifacts).toBe(true)
    expect(bootstrap.features.run_control).toBe(true)

    // 旧形态：有旧会话头，没有工作台主类、任务面板按钮或工作台页签。
    await expect(page.locator('.desktop-agent-chat-header')).toBeVisible()
    await expect(page.locator('.desktop-agent-workbench')).toHaveCount(0)
    await expect(page.locator('.desktop-agent-panel-button')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /任务面板/ })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '有什么可以帮你？', exact: true })).toBeVisible()
    expect(pageErrors).toEqual([])

    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-ot06-workbench-off.png') })
  } finally {
    await closeAgent(app, userData)
  }
})

test('OT-06 agent_capabilities 读取失败不影响 AI 对话主流程', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const { app, page, userData, pageErrors } = await launchAgent(baseURL!)
  try {
    await page.route('**/api/v1/agent/capabilities', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"capabilities unavailable"}' }))
    await page.goto(`${baseURL}/settings/capabilities`)
    await expect(page.getByRole('alert')).toContainText('加载失败')
    await expect(page.getByRole('alert').getByRole('button', { name: '重试', exact: true })).toBeVisible()
    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-ot06-capabilities-fail.png') })
    await expect(page.getByRole('alert').getByRole('button', { name: '重试', exact: true })).toBeVisible()

    await page.goto(`${baseURL}/agent`)
    await expect(page.getByRole('heading', { name: '有什么可以帮你？', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '请先完成模型能力自检' })).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await closeAgent(app, userData)
  }
})
