import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function api(page: import('@playwright/test').Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  const response = await page.evaluate(async ({ url, method, data, csrf }) => {
    const result = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await result.text()
    if (!result.ok) throw new Error(`${method} ${url}: ${result.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
  return response
}

test('DEV-CX11 桌面选题体检显示来源与分层评分，角度须经作者编辑保存', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx11-topic-diagnosis-'))
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
    const username = `cx11-topic-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'wechat_mp', name: 'CX11 选题体检号', content_format: 'long_article' }) as { id: string }
    await api(page, origin, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['写作', '内容'], target_audience: '刚开始写作的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const created = await api(page, origin, 'POST', `/accounts/${account.id}/topics`, {
      title: '新手写作如何搭建稳定计划', angle: '从具体执行步骤说明',
    }) as { topic: { id: string; title: string; angle: string; updated_at: string; score_fit: number | null; status: string } }
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX11 选题体检本地模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx11-topic-e2e-key', models: ['mock-writer'],
    }) as { id: string }
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_topic_diagnose', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`${origin}/a/${account.id}/topics`)
    await expect(page.getByTestId('desktop-topic-details')).toContainText(created.topic.title)
    const requested = page.waitForResponse((response) => response.url().includes(`/topics/${created.topic.id}/diagnose`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '体检选题', exact: true }).click()
    expect((await requested).ok()).toBeTruthy()

    const report = page.getByTestId('topic-diagnosis-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('规则 55/55')
    await expect(report).toContainText('AI 35/45')
    await expect(report).toContainText('综合 90/100')
    await expect(report).toContainText('账号定位')
    await expect(report).toContainText('模拟读者反应')
    const questionAngle = '从读者最常遇到的问题切入'
    const adopt = report.getByRole('button', { name: `放入切入角度：${questionAngle}` })
    await adopt.click()
    const edit = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑选题卡', exact: true }) })
    const angleEditor = edit.getByRole('textbox', { name: '切入角度', exact: true })
    await expect(angleEditor).toHaveValue(questionAngle)
    const beforeSave = await api(page, origin, 'GET', `/accounts/${account.id}/topics`) as Array<{ id: string; angle: string }>
    expect(beforeSave.find((topic) => topic.id === created.topic.id)?.angle).toBe(created.topic.angle)
    await angleEditor.fill(`${questionAngle}，先列出常见卡点`)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(report).toContainText('依据已变化 · 本报告已过期')
    const topics = await api(page, origin, 'GET', `/accounts/${account.id}/topics`) as Array<{ id: string; title: string; angle: string; status: string; score_fit: number | null }>
    const saved = topics.find((topic) => topic.id === created.topic.id)!
    expect(saved.title).toBe(created.topic.title)
    expect(saved.angle).toBe(`${questionAngle}，先列出常见卡点`)
    expect(saved.status).toBe(created.topic.status)
    expect(saved.score_fit).toBe(created.topic.score_fit)
    const history = await api(page, origin, 'GET', `/topics/${created.topic.id}/diagnoses`)
    expect(history.items).toHaveLength(1)
    expect(history.items[0].stale).toBe(true)

    await api(page, origin, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: [], target_audience: '刚开始写作的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const partialRequest = page.waitForResponse((response) => response.url().includes(`/topics/${created.topic.id}/diagnose`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '体检选题', exact: true }).click()
    expect((await partialRequest).ok()).toBeTruthy()
    await expect(report).toContainText('规则 35/55')
    await expect(report).toContainText('部分覆盖，可用上限 35')
    await expect(report).toContainText('AI 未完成')
    await expect(report).toContainText('综合分不可用')
    await expect(report).toContainText('账号定位标签未配置')
    const reports = await api(page, origin, 'GET', `/topics/${created.topic.id}/diagnoses`)
    expect(reports.items).toHaveLength(2)
    expect(reports.items.filter((item: { stale: boolean }) => item.stale)).toHaveLength(1)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
