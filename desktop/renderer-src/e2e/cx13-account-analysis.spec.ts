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

test('DEV-CX13-D 真实 Electron 账号分析、编辑与逐条反馈', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx13-account-analysis-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    const username = `cx13-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'xhs', name: 'CX13 Electron 验收号', content_format: 'image_note', type_note: '' }) as { id: string }
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX13 Electron 本地模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx13-e2e-key',
      models: ['mock-writer'],
    })
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_account_analyze', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`${origin}/a/${account.id}/profile?tab=analysis`)
    const panel = page.getByTestId('account-analysis-tab')
    await expect(panel).toBeVisible()
    await expect(panel.getByText(/账号资料与当前定位始终纳入/)).toBeVisible()
    await panel.getByRole('button', { name: '预览本次依据与模型' }).click()
    const preview = page.getByTestId('account-analysis-preview')
    await expect(preview).toBeVisible()
    await expect(preview.getByText('cx_account_analyze')).toBeVisible()
    const generated = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/account-analysis`) && response.request().method() === 'POST')
    await preview.getByRole('button', { name: '生成账号分析' }).click()
    expect((await generated).ok()).toBeTruthy()
    const report = page.getByTestId('account-analysis-report')
    await expect(report).toBeVisible()
    await expect(report.getByText('检查主页介绍是否清楚表达内容方向')).toBeVisible()
    await report.getByRole('button', { name: '编辑报告' }).click()
    await report.getByLabel('分析摘要').fill('我按实际账号情况编辑后的摘要')
    const saved = page.waitForResponse((response) => response.url().includes('/account-analysis') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '保存报告' }).click()
    expect((await saved).ok()).toBeTruthy()
    await expect(report.getByText('我按实际账号情况编辑后的摘要')).toBeVisible()
    const adopted = page.waitForResponse((response) => response.url().includes('/account-analysis') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '标记采用' }).click()
    expect((await adopted).ok()).toBeTruthy()
    await expect(report.getByText('已标记采用')).toBeVisible()
    const history = await api(page, origin, 'GET', `/accounts/${account.id}/analyses?kind=account_analysis`)
    expect(history.items[0].result_revision).toBe(3)
    expect(history.items[0].result.action_states).toEqual([{ action_index: 0, status: 'adopted' }])
    expect(history.items[0].result.analysis.overview).toBe('我按实际账号情况编辑后的摘要')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})

test('DEV-CX13-D 真实 Electron 主页资料来源、人工确认与文字模拟', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx13-profile-check-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    const username = `cx13-profile-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'xhs', name: 'CX13 Electron 主页自检号', content_format: 'image_note', type_note: '' }) as { id: string }
    await api(page, origin, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['写作'], target_audience: '关注写作的读者', persona_tone: '克制清楚',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX13 Electron 主页自检模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx13-profile-e2e-key',
      models: ['mock-writer'],
    })
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_profile_simulate', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`${origin}/a/${account.id}/profile?tab=profile-check`)
    const panel = page.getByTestId('profile-check-tab')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('当前账号定位与内容方案')).toBeVisible()
    await panel.getByLabel('昵称').fill('写作助手')
    await panel.getByRole('textbox', { name: '简介', exact: true }).fill('分享写作经验，记录真实过程')
    await panel.getByLabel('头像引用').fill('本人平台主页头像')
    await panel.getByLabel('背景信息（人工补充）').fill('长期记录写作过程')
    await panel.getByLabel('置顶内容说明（人工补充）').fill('置顶一篇写作方法说明')
    for (const [label, note] of [
      ['简介层次', '能说明主题和经验来源'],
      ['头像可识别', '本人平台主页中的头像主体清晰'],
      ['背景补充信息', '补充了长期写作经历'],
      ['置顶内容', '展示了写作方法'],
    ] as const) {
      await panel.getByLabel(`${label}判断依据`).fill(note)
      await panel.getByLabel(`${label}状态`).selectOption('pass')
    }
    const generated = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/profile-check`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '保存并模拟文字第一印象' }).click()
    expect((await generated).ok()).toBeTruthy()
    const result = page.getByTestId('profile-check-result')
    await expect(result).toBeVisible()
    await expect(result.getByText('已完成 6/7')).toBeVisible()
    await expect(result.getByText('AI 模拟推断，不代表真实读者测试、受众反馈或内容效果。')).toBeVisible()
    await expect(result.getByText('缺少已采用内容方案或所选本人作品，不能判断内容支柱覆盖')).toBeVisible()
    const saved = await api(page, origin, 'GET', `/accounts/${account.id}/profile-check`)
    expect(saved.profile_check.inputs.nickname).toEqual({ source: 'manual', value: '写作助手' })
    expect(saved.profile_check.inputs.background_info.value).toBe('长期记录写作过程')
    expect(saved.profile_check.items.find((item: { key: string }) => item.key === 'pillar_coverage').status).toBe('unknown')
    expect(saved.profile_check.ai_is_simulated).toBe(true)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
