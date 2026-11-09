import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function api(page: import('@playwright/test').Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

test('DEV-CX11 桌面标题诊断保留未保存标题并逐项采用候选', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx11-title-diagnosis-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    const username = `cx11-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'wechat_mp', name: 'CX11 Electron 验收号', content_format: 'long_article' }) as { id: string }
    await api(page, origin, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['内容'], target_audience: '希望快速理解内容的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '保存的旧标题' }) as { id: string; revision: number }
    await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '按可信材料给读者清楚步骤', base_revision: work.revision })
    const current = await api(page, origin, 'GET', `/works/${work.id}`) as { revision: number }
    const outlined = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: current.revision,
      items: [{ heading: '当前章节', key_point: '根据正文说明步骤', material_ids: [] }],
    }) as { sections: Array<{ id: string; revision: number }> }
    await api(page, origin, 'PATCH', `/sections/${outlined.sections[0].id}`, {
      content_md: '这段正文解释三天内可以完成的具体步骤。', base_revision: outlined.sections[0].revision,
    })
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX11 Electron 本地模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx11-e2e-key', models: ['mock-writer'],
    }) as { id: string }
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_title_diagnose', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`${origin}/works/${work.id}`)
    if (!(await page.locator('#step-title').isVisible())) await page.keyboard.press('F11')
    await expect(page.locator('#step-title')).toBeVisible()
    const title = page.locator('#step-title .desktop-title-main input')
    await title.fill('三天内看懂内容')
    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/diagnose-title`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '诊断标题', exact: true }).click()
    expect((await generated).ok()).toBeTruthy()
    const report = page.getByTestId('title-diagnosis-report')
    await expect(report).toBeVisible()
    await expect(report.getByText('规则 50/60')).toBeVisible()
    await expect(report.getByText('语义 32/40')).toBeVisible()
    await expect(report.getByText('临时标题')).toBeVisible()
    const savedBeforeAdoption = await api(page, origin, 'GET', `/works/${work.id}`)
    expect(savedBeforeAdoption.title).toBe('保存的旧标题')
    await report.getByRole('button', { name: '采用候选：先说明核心，再展开步骤' }).click()
    await expect(title).toHaveValue('先说明核心，再展开步骤')
    expect((await api(page, origin, 'GET', `/works/${work.id}`)).title).toBe('保存的旧标题')
    await report.getByRole('button', { name: '撤销采用' }).click()
    await expect(title).toHaveValue('三天内看懂内容')
    const history = await api(page, origin, 'GET', `/works/${work.id}/diagnoses?kind=title`)
    expect(history.items).toHaveLength(1)
    expect(history.items[0].result.input_scope).toBe('unsaved')
    expect(history.items[0].stale).toBe(false)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})

// DEV-CX13-D：登记上下文窗口后，发送前预算闸门在调模型前返回 409 context_budget_exceeded，
// 桌面窗口内出现缩小范围提示。与 Web 用例覆盖同一服务端闸门（aicore 发送前检查）。
test('DEV-CX13-D 桌面上下文窗口登记后标题候选 409 的界面呈现', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx13-budget-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`cx13-budget-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'wechat_mp', name: 'CX13 预算验收号', content_format: 'long_article' }) as { id: string }
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, {}) as { id: string; revision: number }
    const current = await api(page, origin, 'GET', `/works/${work.id}`) as { revision: number }
    const changed = await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '上下文预算闸门验收', base_revision: current.revision })
    const outlined = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: changed.revision,
      items: [{ heading: '预算段落', key_point: '长正文', material_ids: [] }],
    }) as { sections: Array<{ id: string; revision: number }> }
    const longBody = '把反馈周期缩短到当天可见，写一句话也能积累素材，这种渐进的积累比一次性长文更容易保持动力，也更容易在回读时发现值得展开的线索。'.repeat(32)
    await api(page, origin, 'PATCH', `/sections/${outlined.sections[0].id}`, { content_md: longBody, base_revision: outlined.sections[0].revision })
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: '桌面预算登记模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx13-budget-key', models: ['mock-writer'], context_window_tokens: 1200,
    }) as { id: string }
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'title', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`${origin}/works/${work.id}`)
    await expect(page.locator('#step-title')).toBeVisible({ timeout: 15_000 })
    // 桌面纸感编辑器隐藏标题区「候选」按钮（原型设计），生成标题入口在命令面板。
    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/titles`) && response.request().method() === 'POST')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板' })
    await expect(palette).toBeVisible()
    await palette.getByRole('textbox').fill('生成标题')
    await palette.getByRole('button', { name: /生成标题/ }).first().click()
    const response = await generated
    expect(response.status()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('context_budget_exceeded')
    await expect(page.getByText(/接近上限/).first()).toBeVisible()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
