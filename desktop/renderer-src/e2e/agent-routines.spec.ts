import { _electron, expect, test, type Page } from '@playwright/test'
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

async function prepareRoutine(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw10-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW10 例行任务验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW10 工作台 mock 模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const bootstrap = await api(page, 'GET', '/agent/bootstrap')
  expect(bootstrap.features.routines).toBe(true)
  return account
}

async function routineJourney(page: Page, baseURL: string, screenshotName: string) {
  const account = await prepareRoutine(page, baseURL)
  const materialName = `AW10 例行公开引用 ${Date.now()}`
  const material = await api(page, 'POST', '/materials', {
    account_id: account.id, kind: 'case', content: `${materialName}：经授权的公开运营背景资料。`, source: '本地端到端测试',
  })
  await page.getByRole('button', { name: '例行任务', exact: true }).last().click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '受限例行任务', exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '服务器模型', exact: true }).locator('option')).toHaveCount(2)
  await expect(dialog.getByRole('combobox', { name: '运营账号', exact: true })).toHaveValue(account.id)
  const name = `AW10 私有报告 ${Date.now()}`
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByLabel('任务提示（最多 4000 字）', { exact: true }).fill('按只读权限核对账号表现并生成报告。\n#text 本次例行报告：只读查询已完成。')
  await dialog.getByRole('button', { name: '添加引用', exact: true }).click()
  const picker = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '引用工作区资料', exact: true }) })
  await picker.getByRole('textbox', { name: '搜索资料', exact: true }).fill(materialName)
  const candidate = picker.getByRole('button', { name: new RegExp(materialName) })
  await expect(candidate).toBeVisible()
  await candidate.click()
  await picker.getByRole('button', { name: '预览并校验', exact: true }).click()
  await expect(picker.getByText(`${materialName}：经授权的公开运营背景资料。`, { exact: true })).toBeVisible()
  await picker.getByRole('button', { name: '添加引用', exact: true }).click()
  await expect(dialog.getByText(materialName, { exact: false })).toBeVisible()
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/routines' && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '创建并启用', exact: true }).click()
  expect((await createdResponse).status()).toBe(200)
  const routineList = await api(page, 'GET', '/agent/routines')
  const routine = routineList.items.find((item: { name: string }) => item.name === name)
  expect(routine).toBeTruthy()
  expect(routine.model.provider_id).toBeTruthy()
  expect(routine.status).toBe('enabled')
  expect(routine.public_context_refs).toHaveLength(1)
  expect(routine.public_context_refs[0].id).toBe(material.id)
  const task = dialog.locator('article').filter({ hasText: name })
  await task.getByRole('button', { name: '立即运行一次', exact: true }).click()
  const occurrencePath = `/agent/routines/${routine.id}/occurrences`
  await expect.poll(async () => {
    const result = await api(page, 'GET', occurrencePath)
    return result.items[0]?.status
  }, { timeout: 60_000 }).toBe('completed')
  const occurrence = (await api(page, 'GET', occurrencePath)).items[0]
  expect(occurrence.run_id).toBeTruthy()
  await task.getByRole('button', { name: '执行记录', exact: true }).click()
  await expect(task.getByText(/手动运行 · 已完成/)).toBeVisible()

  const conversations = await api(page, 'GET', `/agent/conversations?q=${encodeURIComponent(`例行任务：${name}`)}`)
  const reportConversation = conversations.items.find((item: { title: string }) => item.title === `例行任务：${name}`)
  expect(reportConversation).toBeTruthy()
  const artifacts = await api(page, 'GET', `/agent/conversations/${reportConversation.id}/artifacts`)
  expect(artifacts.items.some((item: { source_run_id?: string }) => item.source_run_id === occurrence.run_id)).toBe(true)
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshotName}.png`) })
}

test('DEV-AW10 Windows Electron配置受限例行任务、手动运行并查看私有报告', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw10-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await routineJourney(await app.firstWindow(), baseURL!, 'agent-workbench-aw10-electron')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw10-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

