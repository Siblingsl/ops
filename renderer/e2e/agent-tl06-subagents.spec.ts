import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// TL-06（docs/38 §11.3）：真实 Electron 下显式开启“并行协作”，一个父 run 拆成
// 2 个只读子 run 并并行完成；任务面板显示每项范围/模型/耗用，汇总后主对话读取结果。
// 模型调用指令用 #tool 夹具驱动（真实服务端解析，不 mock 委派链路）。
async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('tl06-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const ids = await page.evaluate(async baseURL => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }
    const provider = await (await fetch('/api/v1/model-providers', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'TL06 本地 mock', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'] }),
    })).json()
    await fetch(`/api/v1/model-providers/${provider.id}/selftest`, { method: 'POST', headers, body: '{}' })
    await fetch('/api/v1/model-routes', {
      method: 'PUT', headers,
      body: JSON.stringify([{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }]),
    })
    const conversation = await (await fetch('/api/v1/agent/conversations', {
      method: 'POST', headers,
      body: JSON.stringify({
        title: 'TL06 并行协作',
        model: { provider_id: provider.id, model: 'mock-agent-tested' },
        request_id: crypto.randomUUID(),
      }),
    })).json()
    void baseURL
    return { conversationID: conversation.id as string }
  }, baseURL)
  await page.goto(baseURL + '/agent/c/' + ids.conversationID)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  return ids.conversationID
}

async function closeApp(app: Awaited<ReturnType<typeof _electron.launch>>) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app.close().catch(() => {})
}

test('TL-06 并行协作：菜单开启、2 个子任务并行、任务面板范围、汇总结果', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-tl06-electron-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../desktop/.build/main.js')],
      cwd: resolve(process.cwd(), '../desktop'),
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL!, OPS_DESKTOP_BRIDGE_AUTO_PAIR: '1', OPS_DESKTOP_BRIDGE_PORT: '18767' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 20_000 })

    // 菜单：并行协作在 subagents 开启时可用，点击后 chip + 任务面板同时出现。
    await page.getByTestId('desktop-agent-add-menu-trigger').click()
    const menu = page.getByTestId('desktop-agent-add-menu-list')
    await expect(menu).toBeVisible()
    const subagents = menu.getByRole('menuitem', { name: /并行协作/ })
    await expect(subagents).toBeEnabled()
    await subagents.click()
    await expect(page.getByTestId('agent-subagents-chip')).toContainText('并行协作')
    await expect(page.getByTestId('agent-subagents-chip')).toContainText('本次任务允许拆成 2 个只读子任务')

    const message = '请并行整理竞品结构与选题角度，两个方向各自找证据，最后我来统一取舍。'
    await page.locator('textarea').fill(message)
    const accepted = page.waitForResponse(response => /\/agent\/conversations\/[^/]+\/(messages|inputs)$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.getByRole('button', { name: /^(发送|生成计划)$/ }).first().click()
    await accepted
    console.log('TL06 message accepted')

    const panel = page.getByTestId('delegation-panel').first()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await panel.getByRole('button', { name: /协作任务/ }).click()
    const items = panel.locator('li[data-testid^="delegation-"]')
    await expect(items).toHaveCount(2, { timeout: 20_000 })
    await expect(panel).toContainText('2 项完成', { timeout: 45_000 })
    for (let i = 0; i < 2; i += 1) {
      await expect(items.nth(i)).toHaveAttribute('data-state', 'succeeded', { timeout: 45_000 })
      await expect(items.nth(i)).toContainText('范围：')
      await expect(items.nth(i)).toContainText('2 个工具')
      await expect(items.nth(i)).toContainText('模型 mock-agent-tested')
    }
    await expect(panel).toContainText('子任务已结束')
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-tl06-subagents.png') })

    const adopt = panel.getByTestId(/^delegation-adopt-/)
    await expect(adopt).toBeVisible()
    await adopt.click()
    await expect(panel).toContainText('结果已汇总', { timeout: 20_000 })
    await expect(page.locator('.desktop-agent-message').filter({ hasText: '子任务' }).last()).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-tl06-adopted.png') })
  } finally {
    if (app) await closeApp(app)
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
  }
})
