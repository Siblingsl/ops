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

// DEV-CX09 桌面交付构建：已确认计划 → options.cards 采用 → 本机渲染 PNG → ZIP → 服务端逐张校验。
// Q-CX-03/04 已拍板（90 D-165）：纯净组图构建 complete 直接置 built；下载按门禁四态开放。
test('DEV-CX09 桌面组图交付构建逐张校验与隐私门禁', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(180_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx09-cards-build-'))
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
    const username = `cx09-cards-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'xhs', name: 'CX09 Electron 交付构建号', content_format: 'image_note', type_note: '',
    }) as { id: string }
    await api(page, origin, 'PUT', `/accounts/${account.id}/visual-dna`, {
      base_version: 0,
      tokens: {
        schema: 'ops.visual-dna/v1',
        palette: { primary: '#1B5E20', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
        font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
        watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
        card_template_default: 'editorial', card_ratio_default: '3:4', end_copy: '关注后继续阅读',
      },
    })
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '桌面组图交付构建验收' }) as { id: string; revision: number }
    await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '把要做的事情拆成可检查的小步骤', base_revision: work.revision })
    const current = await api(page, origin, 'GET', `/works/${work.id}`) as { revision: number }
    const outlined = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: current.revision,
      items: [
        { heading: '先准备材料', key_point: '列出要用到的材料，避免中途反复寻找。', material_ids: [] },
        { heading: '设定顺序', key_point: '先安排依赖关系，再开始执行各个步骤。', material_ids: [] },
        { heading: '逐步完成', key_point: '一次完成一个步骤，并检查实际结果。', material_ids: [] },
      ],
    }) as { sections: Array<{ id: string; revision: number }> }
    const sectionTexts = [
      '先列出要用到的材料，避免中途反复寻找。第一步完成后，再确认材料是否齐全。',
      '先安排依赖关系，再开始执行各个步骤。依赖未满足时应先补齐。',
      '一次完成一个步骤，并检查实际结果。完成后再进入下一步。',
    ]
    for (const [index, section] of outlined.sections.entries()) {
      await api(page, origin, 'PATCH', `/sections/${section.id}`, { content_md: sectionTexts[index], base_revision: section.revision })
    }
    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX09 Electron 交付构建模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx09-build-e2e-key', models: ['mock-writer'],
    }) as { id: string }
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_visual_plan', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`${origin}/works/${work.id}`)
    const panel = page.getByTestId('visual-plan-panel')
    await expect(panel).toBeVisible()
    await panel.getByLabel('模板').selectOption('editorial')
    await panel.getByLabel('比例').selectOption('3:4')
    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: 'AI 编排', exact: true }).click()
    expect((await generated).ok()).toBeTruthy()

    const report = page.getByTestId('visual-plan-report')
    await expect(report).toBeVisible()
    const cardCount = await report.locator('[data-testid^="visual-plan-card-"]').count()
    expect(cardCount).toBeGreaterThanOrEqual(3)
    for (let index = 0; index < cardCount; index++) {
      const card = report.getByTestId(`visual-plan-card-${index}`)
      const confirm = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
      await card.getByRole('button', { name: '确认此卡', exact: true }).click()
      expect((await confirm).ok()).toBeTruthy()
    }

    const previewResponse = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
    await report.getByRole('button', { name: '预览构建参数', exact: true }).click()
    const preview = await previewResponse
    expect(preview.ok()).toBeTruthy()
    const previewBody = await preview.json() as {
      source_hash: string; params_hash: string; cards: Array<{ card_id: string }>
      visual_plan?: { diagnosis_id: string; input_hash: string; result_revision: number }
    }
    // AI 计划预览必须回传报告引用，构建才能冻结同一份确认计划。
    expect(previewBody.visual_plan).toBeTruthy()
    await expect(report.getByTestId('cards-build-panel')).toBeVisible()

    const createBuild = page.waitForResponse((response) => response.url().endsWith(`/works/${work.id}/builds`) && response.request().method() === 'POST')
    const completion = page.waitForResponse((response) => response.url().includes('/complete') && response.request().method() === 'POST')
    await report.getByRole('button', { name: '生成交付构建', exact: true }).click()
    const created = await createBuild
    expect(created.status()).toBe(201)
    const createdBody = await created.json() as { build_id: string; source_hash: string; params_hash: string }
    expect(createdBody.source_hash).toBe(previewBody.source_hash)
    expect(createdBody.params_hash).toBe(previewBody.params_hash)
    const completionResponse = await completion
    // Q-CX-03 拍板后（90 D-165）：纯净组图构建 complete 直接置 built，下载门禁 clear。
    expect(completionResponse.status()).toBe(200)
    expect(await completionResponse.text()).toContain('"status":"built"')
    await expect(report).toContainText('组图交付包已通过结构与像素校验')
    await expect(report.getByTestId('cards-build-detail')).toContainText('下载门禁：已开放')

    const builds = await api(page, origin, 'GET', `/works/${work.id}/builds`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
    expect(builds.items[0]).toMatchObject({ status: 'built', error_code: null })
    const detail = await api(page, origin, 'GET', `/builds/${builds.items[0].id}`) as {
      targets: string[]
      artifacts: Array<{ kind: string; downloadable: boolean }>
      validation: { cards: { count: number; ratio: string; entries: Array<{ name: string; width: number; height: number }> } }
      download_gate: { allowed: boolean; reason: string }
    }
    expect(detail.targets).toEqual(['xhs_cards'])
    expect(detail.artifacts.map((item) => item.kind)).toEqual(['zip'])
    expect(detail.artifacts.every((item) => item.downloadable)).toBe(true)
    expect(detail.download_gate).toMatchObject({ allowed: true, reason: 'clear' })
    expect(detail.validation.cards.count).toBe(previewBody.cards.length)
    expect(detail.validation.cards.ratio).toBe('3:4')
    const entryNames = detail.validation.cards.entries.map((entry) => entry.name)
    expect(entryNames).toHaveLength(previewBody.cards.length)
    for (const name of entryNames) expect(name).toMatch(/^\d{2}-(cover|point-\d+|quote-\d+|compare-\d+|end)\.png$/)
    expect(entryNames[0]).toMatch(/^01-cover\.png$/)
    expect(entryNames[entryNames.length - 1]).toMatch(/-end\.png$/)
    expect(detail.validation.cards.entries.every((entry) => entry.width === 1080 && entry.height === 1440)).toBe(true)

    const workAfter = await api(page, origin, 'GET', `/works/${work.id}`) as { sections: Array<{ content_md: string }> }
    expect(workAfter.sections[0].content_md).toBe(sectionTexts[0])
  } finally {
    // Electron 在 Windows 上偶发不响应 close 握手，先 exit 再 close，避免 worker teardown 超时。
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
