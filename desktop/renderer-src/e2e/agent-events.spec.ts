import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function prepare(page: Page, baseURL: string) {
  expect(baseURL).toBe('http://127.0.0.1:5287')
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw06-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const provider = await call(page, 'POST', '/model-providers', {
    name: 'AW06 本地慢速模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-slow'],
  })
  await call(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await call(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-slow' }])
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
}

async function send(page: Page, text: string) {
  await page.locator('textarea').fill('#text ' + text)
  const pending = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const response = await pending
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  return { response, id: page.url().split('/').pop()! }
}

async function refreshAndRecover(page: Page, baseURL: string, screenshotName: string) {
  await prepare(page, baseURL)
  let messagePosts = 0
  let subscriptions = 0
  page.on('request', (request) => {
    if (/\/agent\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname) && request.method() === 'POST') messagePosts++
  })
  await page.route('**/agent/conversations/*/events?*', async (route) => {
    subscriptions++
    if (subscriptions === 1) await route.abort('connectionreset')
    else await route.continue()
  })
  const reply = 'AW06 可恢复运行。' + '刷新后继续查看同一次运行的完整内容。'.repeat(24) + '恢复验收结束。'
  const { response, id } = await send(page, reply)
  expect(response.status()).toBe(202)
  expect(response.request().postDataJSON().protocol_version).toBe(2)
  const accepted = await response.json()
  await expect.poll(async () => (await call(page, 'GET', `/agent/conversations/${id}`)).partial_output?.text?.length ?? 0).toBeGreaterThan(0)
  await expect.poll(() => subscriptions).toBeGreaterThanOrEqual(2)
  await page.reload()
  await expect(page.getByRole('button', { name: '停止', exact: true }).first()).toBeVisible()
  await expect(page.locator('article').getByText(reply, { exact: true })).toBeVisible({ timeout: 25_000 })
  const detail = await call(page, 'GET', `/agent/conversations/${id}`)
  expect(detail.active_run).toBeNull()
  expect(detail.last_run.id).toBe(accepted.run_id)
  expect(detail.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
  expect(detail.messages.filter((message: { content: string }) => message.content === reply)).toHaveLength(1)
  expect(messagePosts).toBe(1)
  await expect(page.getByTestId('agent-partial-note')).toHaveCount(0)
  await page.locator('textarea').fill('恢复后可以继续发送的新要求')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await page.locator('textarea').fill('')
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshotName}.png`) })
}

async function checkToolActivity(page: Page, screenshotName: string) {
  await page.locator('textarea').fill('#tool get_context {}\n#tool unknown_aw06 {}')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const summary = page.getByRole('button', { name: '工具活动 2 项', exact: true }).last()
  await expect(summary).toBeVisible()
  await summary.click()
  const activity = page.locator(`[id="${await summary.getAttribute('aria-controls')}"]`)
  await expect(activity.getByText('已完成', { exact: true })).toBeVisible()
  await expect(activity.getByText('失败', { exact: true })).toBeVisible()
  const failed = activity.locator('details').filter({ hasText: 'unknown_tool' })
  await failed.locator('summary').click()
  await expect(failed.locator('p')).toBeVisible()
  await expect(failed.locator('p')).toContainText('unknown_tool')
  await expect(activity.getByText(/\d+\.\d 秒/).first()).toBeVisible()
  await expect.poll(async () => (await call(page, 'GET', `/agent/conversations/${page.url().split('/').pop()!}`)).active_run).toBeNull()
  await page.reload()
  const recoveredSummary = page.getByRole('button', { name: '工具活动 2 项', exact: true }).last()
  await recoveredSummary.click()
  const recoveredActivity = page.locator(`[id="${await recoveredSummary.getAttribute('aria-controls')}"]`)
  await expect(recoveredActivity).toHaveCSS('opacity', '1')
  const recoveredFailure = recoveredActivity.locator('details').filter({ hasText: 'unknown_tool' })
  await recoveredFailure.locator('summary').click()
  await expect(recoveredFailure.locator('p')).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshotName}.png`) })
}

async function createInviteCard(page: Page) {
  await page.locator('textarea').fill('#tool load_tool_domain {"domain":"workspace"}\n#tool workspace__create_invite {"role":"editor"}')
  const accepted = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await accepted).status()).toBe(202)
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await call(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const detail = await call(page, 'GET', `/agent/conversations/${id}`)
  expect(detail.actions).toHaveLength(1)
  const action = detail.actions[0]
  const card = page.locator(`#agent-action-${action.id}`)
  await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
  return { id, detail, action, card }
}

test('DEV-AW06 真实Electron刷新恢复持久事件运行', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实Electron验收需要Windows')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw06-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await refreshAndRecover(await app.firstWindow(), baseURL!, 'agent-workbench-aw06-electron-recovery')
    await checkToolActivity(await app.firstWindow(), 'agent-workbench-aw06-electron-tools')
  } finally {
    // 此用例只验证恢复；沿用真实平台Electron测试的专用进程清理方式。
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw06-')) throw new Error('拒绝清理测试目录之外的路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

