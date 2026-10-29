import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

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

async function modesJourney(page: Page, baseURL: string, screenshot: string) {
  expect(baseURL).toBe('http://127.0.0.1:5287')
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw07-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  // Web和原生桌面首次账号入口不同；通过真实API建立本用例的账号前置数据。
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '模式验收号', content_format: 'image_note', type_note: '' })
  await page.goto(`${baseURL}/a/${account.id}`)
  await expect(page.getByRole('main')).toContainText('模式验收号')
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW07 模式验证模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) }).getByRole('button', { name: '我知道了', exact: true }).click()
  const accountButton = page.getByRole('button', { name: '选择操作账号', exact: true })
  if (await accountButton.count()) await accountButton.click()
  else await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  await settings.getByRole('combobox', { name: '选择账号', exact: true }).selectOption(account.id)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  const selector = page.getByRole('combobox', { name: '对话模式', exact: true })
  await expect(selector).toHaveValue('execute')
  expect((await selector.boundingBox())!.width).toBeLessThanOrEqual(130)
  await selector.selectOption('plan')
  const prompt = '模式边界验收：这是一条用户提出的记忆。\n#tool load_tool_domain {"domain":"profile"}\n' +
    `#tool memory__create ${JSON.stringify({ accountId: account.id, text: '模式边界验收：这是一条用户提出的记忆。' })}`
  const first = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.locator('textarea').fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const response = await first
  expect(response.status()).toBe(202)
  expect(response.request().postDataJSON().mode).toBe('plan')
  const accepted = await response.json()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const planned = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(planned.actions).toHaveLength(0)
  expect(planned.last_run.config_snapshot.mode).toBe('plan')
  expect(planned.last_run.config_snapshot.actual_model).toMatchObject({ channel: 'server', model: 'mock-agent-tested' })
  await expect(page.getByTestId('agent-runtime-config')).toContainText('计划 · 服务器模型通道')
  await page.reload()
  await expect(selector).toHaveValue('plan')
  await selector.selectOption('execute')
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).conversation.mode).toBe('execute')
  const next = page.waitForResponse((res) => res.url().endsWith(`/agent/conversations/${id}/messages`) && res.request().method() === 'POST')
  await page.locator('textarea').fill(prompt)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await next).status()).toBe(202)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${id}`)).active_run).toBeNull()
  const executed = await api(page, 'GET', `/agent/conversations/${id}`)
  expect(executed.actions).toHaveLength(1)
  expect(executed.actions[0]).toMatchObject({ status: 'pending', tool_name: 'memory__create' })
  expect(executed.last_run.mode).toBe('execute')
  // 改下一次模式不改写此前运行；卡片仍等待用户逐张执行。
  expect(executed.last_run.id).not.toBe(accepted.run_id)
  const card = page.locator(`#agent-action-${executed.actions[0].id}`)
  await expect(card.getByRole('button', { name: '执行', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '全部执行', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('agent-runtime-config')).toContainText('执行 · 服务器模型通道')
  await card.scrollIntoViewIfNeeded()
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshot}.png`) })
}

test('DEV-AW07 真实Electron模式切换仍逐卡确认', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw07-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await modesJourney(await app.firstWindow(), baseURL!, 'agent-workbench-aw07-electron-modes')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw07-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

