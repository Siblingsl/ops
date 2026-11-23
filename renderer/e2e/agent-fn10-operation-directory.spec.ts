import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

test('FN-10 运营目录真实 Electron：480 只读抽屉、五类资料逐条引用且不改变 880 阅读宽度', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-fn10-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    const username = `fn10-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const me = await localApi(page, 'GET', '/auth/me')

    // 真实数据：一个工作作品、一个选题、一条素材，再由日历按今日排期暴露。
    const account = await localApi(page, 'POST', '/accounts', {
      platform: 'xhs', name: 'FN10 验收号', content_format: 'image_note',
    })
    const work = await localApi(page, 'POST', `/accounts/${account.id}/works`, {
      title: 'FN10 验收作品', content_format: 'image_note',
    })
    await localApi(page, 'PATCH', `/works/${work.id}`, { planned_date: localDate() })
    const topic = await localApi(page, 'POST', `/accounts/${account.id}/topics`, {
      title: 'FN10 验收选题', angle: '从真实目录逐条引用',
    })
    await localApi(page, 'PATCH', `/topics/${topic.topic.id}`, { planned_date: localDate() })
    await localApi(page, 'POST', '/materials', {
      account_id: account.id, kind: 'case', content: 'FN10 验收素材', source: 'E2E', tags: ['fn10'],
    })

    const userKey = me.user_id ?? me.username ?? username
    await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
      key: `ops.currentAccount.v2:${userKey}:${me.workspace.id}`, id: account.id,
    })
    const provider = await localApi(page, 'POST', '/model-providers', {
      name: 'FN10 验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
    })
    await localApi(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
    await localApi(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])

    await page.goto(`${baseURL}/agent`)
    const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
    await expect(privacy).toBeVisible()
    await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
    await expect(privacy).toBeHidden()

    const bootstrap = await localApi(page, 'GET', '/agent/bootstrap')
    expect(bootstrap.features.operations_directory).toBe(true)
    expect(bootstrap.features.workbench_ui).toBe(true)

    const messageColumn = page.locator('.desktop-agent-compose')
    await expect(messageColumn).toBeVisible()
    const beforeWidth = await messageColumn.evaluate((el) => el.getBoundingClientRect().width)
    expect(beforeWidth).toBeLessThanOrEqual(880)
    expect(beforeWidth).toBeGreaterThan(700)

    const trigger = page.getByTestId('desktop-agent-add-menu-trigger')
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await page.getByTestId('desktop-agent-add-menu-list').getByRole('menuitem', { name: /运营目录/ }).click()

    const drawer = page.getByTestId('agent-operation-directory')
    await expect(drawer).toBeVisible()
    const panel = page.getByRole('dialog').filter({ has: drawer })
    const box = await panel.boundingBox()
    expect(Math.round(box!.width)).toBe(480)
    await expect(drawer.getByRole('tab', { name: '作品', exact: true })).toBeVisible()
    await expect(drawer.getByRole('tab', { name: '选题', exact: true })).toBeVisible()
    await expect(drawer.getByRole('tab', { name: '素材', exact: true })).toBeVisible()
    await expect(drawer.getByRole('tab', { name: '图片', exact: true })).toBeVisible()
    await expect(drawer.getByRole('tab', { name: '日历', exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '引用作品 FN10 验收作品', exact: true })).toBeVisible()
    await drawer.getByRole('tab', { name: '素材', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '引用素材 FN10 验收素材', exact: true })).toBeVisible()
    await drawer.getByRole('tab', { name: '作品', exact: true }).click()

    await drawer.getByRole('button', { name: '引用作品 FN10 验收作品', exact: true }).click()
    await expect(drawer.getByRole('button', { name: /引用作品 FN10 验收作品/ })).toBeDisabled()

    await drawer.getByRole('tab', { name: '日历', exact: true }).click()
    await expect(drawer.getByRole('button', { name: `引用日历 ${localDate()} FN10 验收选题`, exact: true })).toBeVisible()
    await drawer.getByRole('button', { name: `引用日历 ${localDate()} FN10 验收选题`, exact: true }).click()

    const afterWidth = await messageColumn.evaluate((el) => el.getBoundingClientRect().width)
    expect(afterWidth).toBe(beforeWidth)
    expect(page.locator('input[type=checkbox]')).toHaveCount(0)

    mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-fn10-directory.png') })

    // 抽屉关闭后，两个引用只落在输入台，不自动发送。
    await panel.getByRole('button', { name: '关闭' }).click()
    await expect(drawer).toBeHidden()
    const chips = page.getByTestId('agent-context-ref-chip')
    await expect(chips.filter({ hasText: 'FN10 验收作品' })).toHaveCount(1)
    await expect(chips.filter({ hasText: 'FN10 验收选题' })).toHaveCount(1)
    const composer = page.locator('.desktop-agent-compose textarea, .desktop-agent-compose [contenteditable=true]').first()
    if (await composer.count()) {
      const value = await composer.evaluate((el) => ('value' in el ? (el as HTMLTextAreaElement).value : el.textContent) ?? '')
      expect(value).not.toContain('FN10 验收作品')
    }
    await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-fn10-refs.png') })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    await rm(userData, { recursive: true, force: true }).catch(() => undefined)
  }
})
