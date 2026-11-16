import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

// CF-AW-05（docs/17 / docs/34 §3）：AW05 定位卡片 + 产物链路的**真实 Electron** 验收。
// 既有 agent-workbench.spec.ts 的「桌面」AW05 用例用 Electron UA 注入冒充（CF-AW-05 明确禁止）；
// 本用例用 _electron.launch 真实窗口，覆盖：产物页签预览 → 定位操作卡片（焦点）→ 来源作品深链。
// AW06 事件续接已由 agent-events.spec.ts 真实 Electron 用例覆盖（DEV-AW06/DEV-QA26 真实Electron运行恢复、停止与重生成）。

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

async function prepareAW05(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw05-real-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'AW05 真实窗口验收号', content_format: 'long_article', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW05 真实窗口产物验收模型', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'AW05 真实窗口产物来源作品' })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '小步持续改进' })
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const instruction = [
    '生成标题候选，并提出一张等待我单独审阅的标题卡片。',
    `#tool load_tool_domain {"domain":"works"}`,
    `#tool works__list {"accountId":"${account.id}"}`,
    `#tool load_tool_domain {"domain":"writing"}`,
    `#tool works__titles {"id":"${work.id}"}`,
    `#tool works__update {"id":"${work.id}","title":"小步持续改进"}`,
  ].join('\n')
  const sendResponse = page.waitForResponse((item) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(item.url()).pathname) && item.request().method() === 'POST')
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill(instruction)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 20_000 })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await sendResponse).ok()).toBeTruthy()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/, { timeout: 30_000 })
  return { workId: work.id as string }
}

test('DEV-AW05 真实Electron产物页签预览与定位操作卡片', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实Electron验收需要Windows')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw05-real-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    const { workId } = await prepareAW05(page, baseURL!)

    // 等待操作卡片渲染（逐张确认红线：只有一张卡片表单）
    const card = page.locator('[id^="agent-action-"]').first()
    await expect(card).toBeVisible({ timeout: 60_000 })
    const actionId = (await card.getAttribute('id'))!.replace('agent-action-', '')

    // 打开工作视图 → 任务页签「定位操作卡片」→ 焦点落到卡片
    await page.getByRole('button', { name: '工作视图', exact: true }).first().click({ timeout: 15000 })
    const panel = page.getByTestId('desktop-agent-side-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '定位操作卡片', exact: true }).click()
    await expect(page.locator(`#agent-action-${actionId}`)).toBeFocused()

    // 产物页签：标题候选产物与来源作品深链（真实窗口）
    await panel.getByRole('tab', { name: '产物', exact: true }).click()
    await expect(panel.getByText('小步持续改进', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('link', { name: '打开来源作品', exact: true })).toHaveAttribute('href', `/works/${workId}`)

    mkdirSync(resolve(process.cwd(), '../.playwright-results/desktop-renderer'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/desktop-renderer/aw05-real-electron-artifact.png') })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app?.close().catch(() => {})
    if (resolve(userData).startsWith(resolve(tmpdir()) + sep) && userData.startsWith(join(tmpdir(), 'ops-agent-aw05-real-'))) {
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
    }
  }
})
