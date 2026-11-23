import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// FN-12（docs/38 §12.4）：真实 Electron 下从主对话打开旁问，独立标签、独立消息、不污染主对话。
async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('fn12-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const ids = await page.evaluate(async ({ baseURL }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
    const provider = await (await fetch('/api/v1/model-providers', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'FN12 本地 mock', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'] }),
    })).json()
    await fetch(`/api/v1/model-providers/${provider.id}/selftest`, { method: 'POST', headers, body: '{}' })
    await fetch('/api/v1/model-routes', {
      method: 'PUT', headers,
      body: JSON.stringify([{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }]),
    })
    const conversation = await (await fetch('/api/v1/agent/conversations', {
      method: 'POST', headers,
      body: JSON.stringify({
        title: 'FN12 主对话',
        model: { provider_id: provider.id, model: 'mock-agent-tested' },
        request_id: crypto.randomUUID(),
      }),
    })).json()
    void baseURL
    return { conversationID: conversation.id as string }
  }, { baseURL })
  await page.goto(baseURL + '/agent/c/' + ids.conversationID)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  return ids.conversationID
}

async function send(page: Page, text: string) {
  await page.locator('textarea').fill(text)
  const action = page.getByRole('button', { name: /^(发送|提问|生成计划)$/ })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-fn12-before-send.png') })
  console.log('FN12 send action', await action.count(), await action.first().isDisabled().catch(() => 'missing'))
  const accepted = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/(messages|inputs)$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await action.first().click()
  await accepted
}

async function closeApp(app: Awaited<ReturnType<typeof _electron.launch>>) {
  // 主进程退出有“确认退出”原生对话框；测试用 app.exit(0) 直接结束进程树。
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app.close().catch(() => {})
}

test('FN-12 旁问：独立只读会话、标签、从主对话进入且不污染主对话', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-fn12-electron-'))
  const parentMarker = 'FN12 主对话原始请求：分析本周选题'
  const sideMarker = 'FN12 旁问独立讨论，不写回主对话'
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      cwd: resolve(process.cwd(), '../desktop'),
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL!, OPS_DESKTOP_BRIDGE_AUTO_PAIR: '1', OPS_DESKTOP_BRIDGE_PORT: '18766' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 20_000 })

    await send(page, parentMarker)
    await expect(page.locator('.desktop-agent-message').filter({ hasText: parentMarker }).first()).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('desktop-agent-add-menu-trigger').click()
    const created = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || !new URL(response.url()).pathname.endsWith('/agent/conversations')) return false
      return (response.request().postData() ?? '').includes('"kind":"side"')
    })
    await page.getByRole('menuitem', { name: /旁问/ }).click()
    const side = await (await created).json() as { id: string; kind: string; parent_id: string; title: string }
    expect(side.kind).toBe('side')
    expect(side.parent_id).toBeTruthy()
    console.log('FN12 side created', side.id)
    await page.waitForURL(new RegExp(`/agent/c/${side.id}`), { timeout: 20_000 })
    console.log('FN12 side url reached')

    await expect(page.getByTestId('agent-side-chat-badge')).toHaveText('旁问 · 只读')
    await expect(page.getByRole('button', { name: '回到主对话', exact: true })).toBeVisible()
    await expect(page.locator('.desktop-agent-side-tag').first()).toHaveText('旁问')
    // 旁问不提供模式切换（只读会话）。
    await expect(page.locator('.desktop-agent-mode-select')).toHaveCount(0)
    console.log('FN12 side chrome visible', await page.locator('textarea').count(), await page.locator('textarea').first().isDisabled().catch(() => 'missing'))

    await send(page, sideMarker)
    await expect(page.locator('.desktop-agent-message').filter({ hasText: sideMarker }).first()).toBeVisible({ timeout: 20_000 })
    // 等旁问这一轮真实结束后再退出，避免主进程在途模型请求触发“确认退出”对话框。
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 45_000 })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-fn12-side-chat.png') })

    await page.getByRole('button', { name: '回到主对话', exact: true }).click()
    await page.waitForURL(new RegExp(`/agent/c/${side.parent_id}`), { timeout: 20_000 })
    await expect(page.locator('.desktop-agent-message').filter({ hasText: parentMarker })).toHaveCount(1)
    await expect(page.locator('.desktop-agent-message').filter({ hasText: sideMarker })).toHaveCount(0)
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-fn12-parent-clean.png') })
    console.log('FN12 test body complete')
  } finally {
    if (app) await closeApp(app)
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
  }
})
