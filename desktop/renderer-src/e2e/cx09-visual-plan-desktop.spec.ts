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

test('DEV-CX09 桌面组图计划可编辑、逐卡确认并保护已确认卡片', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx09-visual-plan-'))
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
    const username = `cx09-visual-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)

    const account = await api(page, origin, 'POST', '/accounts', {
      platform: 'xhs', name: 'CX09 Electron 组图计划号', content_format: 'image_note', type_note: '',
    }) as { id: string }
    await api(page, origin, 'PUT', `/accounts/${account.id}/visual-dna`, {
      base_version: 0,
      tokens: {
        schema: 'ops.visual-dna/v1',
        palette: { primary: '#1B5E20', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
        font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
        watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
        card_template_default: 'swiss', card_ratio_default: '9:16', end_copy: '关注后继续阅读',
      },
    })
    const work = await api(page, origin, 'POST', `/accounts/${account.id}/works`, { title: '逐步完成的一件小事' }) as { id: string; revision: number }
    await api(page, origin, 'PATCH', `/works/${work.id}`, { viewpoint: '把要做的事情拆成可检查的小步骤', base_revision: work.revision })
    const current = await api(page, origin, 'GET', `/works/${work.id}`) as { revision: number }
    const outlined = await api(page, origin, 'PUT', `/works/${work.id}/outline`, {
      confirm: true,
      base_revision: current.revision,
      items: [
        { heading: '先准备材料', key_point: '列出要用到的材料，避免中途反复寻找。', material_ids: [] },
        { heading: '设定顺序', key_point: '先安排依赖关系，再开始执行各个步骤。', material_ids: [] },
        { heading: '逐步完成', key_point: '一次完成一个步骤，并检查实际结果。', material_ids: [] },
        { heading: '记录问题', key_point: '遇到问题时记录原因，不把猜测当作事实。', material_ids: [] },
        { heading: '核对结果', key_point: '按最初目标复核结果，说明尚未完成的事项。', material_ids: [] },
      ],
    }) as { sections: Array<{ id: string; revision: number }> }
    const sectionTexts = [
      '先列出要用到的材料，避免中途反复寻找。第一步完成后，再确认材料是否齐全。',
      '先安排依赖关系，再开始执行各个步骤。依赖未满足时应先补齐。',
      '一次完成一个步骤，并检查实际结果。完成后再进入下一步。',
      '遇到问题时记录原因，不把猜测当作事实。根据证据调整后续步骤。',
      '按最初目标复核结果，说明尚未完成的事项。必要时保留明确的缺失项。',
    ]
    for (const [index, section] of outlined.sections.entries()) {
      await api(page, origin, 'PATCH', `/sections/${section.id}`, {
        content_md: sectionTexts[index], base_revision: section.revision,
      })
    }

    const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
    const imageData = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const context = canvas.getContext('2d')!
      context.fillStyle = '#d9e8ee'
      context.fillRect(0, 0, 64, 64)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const uploaded = await page.evaluate(async ({ workId, imageData, csrf }) => {
      const bytes = Uint8Array.from(atob(imageData), (character) => character.charCodeAt(0))
      const form = new FormData()
      form.append('file', new File([bytes], 'cx09-source.png', { type: 'image/png' }))
      const response = await fetch(`/api/v1/works/${workId}/assets`, {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`POST /works/${workId}/assets: ${response.status} ${body}`)
      return JSON.parse(body) as { id: string }
    }, { workId: work.id, imageData, csrf: me.csrf_token })
    const asset = uploaded

    const provider = await api(page, origin, 'POST', '/model-providers', {
      name: 'CX09 Electron 本地模拟模型',
      base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
      api_key: 'local-cx09-e2e-key', models: ['mock-writer'],
    }) as { id: string }
    await api(page, origin, 'PUT', '/model-routes', [{ task_type: 'cx_visual_plan', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`${origin}/works/${work.id}`)
    const panel = page.getByTestId('visual-plan-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('AI 组图计划')
    await expect(panel.getByText(/图片来源/)).toBeVisible()
    await expect(panel.getByLabel('视觉 DNA')).toHaveValue('1')
    await expect(panel.getByLabel('模板')).toHaveValue('swiss')
    await expect(panel.getByLabel('比例')).toHaveValue('9:16')
    await panel.getByRole('checkbox').last().check()
    await panel.getByLabel('视觉 DNA').selectOption('')
    await panel.getByLabel('模板').selectOption('editorial')
    await panel.getByLabel('比例').selectOption('3:4')
    const createdBuildRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes(`/works/${work.id}/builds`)) createdBuildRequests.push(request.url())
    })

    await page.route(`**/api/v1/works/${work.id}/cards/suggest`, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '模拟模型不可用' } }),
    }))
    await panel.getByRole('button', { name: 'AI 编排', exact: true }).click()
    await expect(panel).toContainText('模拟模型不可用')
    await page.unroute(`**/api/v1/works/${work.id}/cards/suggest`)
    await panel.getByRole('button', { name: '手工编排', exact: true }).click()
    const manual = panel.getByTestId('manual-visual-plan')
    await expect(manual).toBeVisible()
    await expect(manual).toContainText('收起或离开页面后会清空')
    const manualCards = manual.locator('[data-testid^="manual-visual-card-"]')
    await expect(manualCards).toHaveCount(7)
    await manual.getByRole('button', { name: '新增要点卡', exact: true }).click()
    await manual.getByRole('button', { name: '新增要点卡', exact: true }).click()
    await expect(manualCards).toHaveCount(9)
    await expect(manual.getByRole('button', { name: '新增要点卡', exact: true })).toBeDisabled()
    await manualCards.nth(7).getByRole('button', { name: '删除卡片', exact: true }).click()
    await manualCards.nth(6).getByRole('button', { name: '删除卡片', exact: true }).click()
    await expect(manualCards).toHaveCount(7)
    await manualCards.nth(1).getByLabel('卡片类型').selectOption('compare')
    await expect(manualCards.nth(1).getByLabel('左侧摘录')).not.toHaveValue('')
    await expect(manualCards.nth(1).getByLabel('右侧摘录')).not.toHaveValue('')
    for (let index = 0; index < 7; index++) {
      await manualCards.nth(index).getByRole('button', { name: '确认此卡', exact: true }).click()
    }
    const manualPreviewResponse = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
    await manual.getByRole('button', { name: '预览手工计划', exact: true }).click()
    const manualPreviewResult = await manualPreviewResponse
    expect(manualPreviewResult.ok()).toBeTruthy()
    const manualPreviewRequest = manualPreviewResult.request().postDataJSON()
    expect(manualPreviewRequest.visual_plan_id).toBeUndefined()
    expect(manualPreviewRequest.cards).toHaveLength(7)
    expect(manualPreviewRequest.cards[0].asset_ids).toContain(asset.id)
    await expect(manual.getByTestId('manual-cards-params-preview')).toBeVisible()
    const manualRaster = manual.getByRole('button', { name: '生成本地组图预览', exact: true })
    await manualRaster.click()
    const manualImages = manual.getByTestId('visual-card-rendered-image')
    await expect(manualImages).toHaveCount(7)
    await expect(manualImages.first()).toHaveJSProperty('naturalWidth', 1080)
    await expect(manualImages.first()).toHaveJSProperty('naturalHeight', 1440)
    for (const [manualRatio, manualHeight] of [['1:1', 1080], ['9:16', 1920]] as const) {
      await panel.getByLabel('比例').selectOption(manualRatio)
      const manualRatioPreview = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
      await manual.getByRole('button', { name: '预览手工计划', exact: true }).click()
      expect((await manualRatioPreview).ok()).toBeTruthy()
      await manual.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
      await expect(manualImages).toHaveCount(7)
      await expect(manualImages.first()).toHaveJSProperty('naturalWidth', 1080)
      await expect(manualImages.first()).toHaveJSProperty('naturalHeight', manualHeight)
    }
    const manualHistory = await api(page, origin, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: unknown[] }
    expect(manualHistory.items).toHaveLength(0)
    await expect(page.getByTestId('visual-plan-panel')).toBeVisible()
    expect(createdBuildRequests).toEqual([])
    await panel.getByRole('button', { name: '收起手工编排', exact: true }).click()
    await panel.getByRole('button', { name: '手工编排', exact: true }).click()
    await expect(panel.getByTestId('manual-visual-plan').locator('[data-testid="manual-visual-card-1"]').getByLabel('卡片类型')).toHaveValue('point')
    await panel.getByRole('button', { name: '收起手工编排', exact: true }).click()
    const sectionChoices = panel.locator('fieldset').first().getByRole('checkbox')
    await sectionChoices.nth(2).uncheck()
    await sectionChoices.nth(3).uncheck()
    await sectionChoices.nth(4).uncheck()
    await expect(sectionChoices).toHaveCount(5)
    await expect(sectionChoices.nth(0)).toBeChecked()
    await expect(sectionChoices.nth(1)).toBeChecked()
    await expect(sectionChoices.nth(2)).not.toBeChecked()
    await expect(sectionChoices.nth(3)).not.toBeChecked()
    await expect(sectionChoices.nth(4)).not.toBeChecked()
    await panel.getByLabel('视觉 DNA').selectOption('1')
    await expect(panel.getByLabel('模板')).toHaveValue('swiss')
    await expect(panel.getByLabel('比例')).toHaveValue('9:16')

    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: 'AI 编排', exact: true }).click()
    const generateResponse = await generated
    expect(generateResponse.ok()).toBeTruthy()
    expect(generateResponse.request().postDataJSON().dna_version).toBe(1)
    expect(generateResponse.request().postDataJSON().section_ids).toHaveLength(2)
    const savedPlan = await api(page, origin, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: Array<{ diagnosis_id: string; result_revision: number; cards: Array<{ card_id: string; type: string; section_ids: string[]; headline: string; body: string | { left: string; right: string }; asset_ids: string[]; source_refs: string[]; confirmed: boolean; edited: boolean }> }> }
    const selectedImagePlan = savedPlan.items[0]
    const planWithImage = selectedImagePlan.cards.map(({ edited: _edited, ...card }, index) => index === 0
      ? { ...card, asset_ids: [asset.id], source_refs: [...card.source_refs, `asset:${asset.id}`] }
      : index === 1
        ? { ...card, type: 'quote', body: '列出要用到的材料，避免中途反复寻找。' }
        : card)
    await api(page, origin, 'PATCH', `/diagnoses/${selectedImagePlan.diagnosis_id}/visual-plan`, {
      expected_revision: selectedImagePlan.result_revision, cards: planWithImage,
    })
    await page.reload()
    const report = page.getByTestId('visual-plan-report')
    await expect(report).toBeVisible()
    await panel.getByRole('checkbox').last().check()
    await expect(report.getByText(/内容覆盖完整/)).toBeVisible()
    await expect(report.locator('[data-testid^="visual-plan-card-"]')).toHaveCount(4)
    await expect(report).toContainText('先准备材料')
    await expect(report).toContainText('视觉 DNA v1')

    const firstCard = report.getByTestId('visual-plan-card-0')
    await firstCard.getByLabel('标题').fill('人工调整的封面标题')
    const saveEdit = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '保存计划', exact: true }).click()
    expect((await saveEdit).ok()).toBeTruthy()
    await expect(firstCard.getByLabel('标题')).toHaveValue('人工调整的封面标题')

    const confirmCard = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
    await firstCard.getByRole('button', { name: '确认此卡', exact: true }).click()
    expect((await confirmCard).ok()).toBeTruthy()
    await expect(firstCard.getByText('已逐卡确认')).toBeVisible()
    await expect(report.getByRole('button', { name: '预览构建参数' })).toBeDisabled()

    for (let index = 1; index < 4; index++) {
      const card = report.getByTestId(`visual-plan-card-${index}`)
      const confirmNext = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
      await card.getByRole('button', { name: '确认此卡', exact: true }).click()
      expect((await confirmNext).ok()).toBeTruthy()
      await expect(card.getByText('已逐卡确认')).toBeVisible()
    }
    const preview = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
    await report.getByRole('button', { name: '预览构建参数', exact: true }).click()
    const previewResponse = await preview
    expect(previewResponse.ok()).toBeTruthy()
    const previewBody = await previewResponse.json()
    const currentWork = await api(page, origin, 'GET', `/works/${work.id}`) as { revision: number }
    expect(previewBody).toMatchObject({ basis_revision: currentWork.revision, template: 'swiss', ratio: '9:16', dna_version: 1 })
    expect(previewBody.source_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(previewBody.params_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(previewBody.cards).toHaveLength(4)
    expect(previewBody.cards.every((card: { confirmed?: unknown }) => card.confirmed === undefined)).toBeTruthy()
    const buildPreview = report.getByTestId('cards-build-preview')
    await expect(buildPreview).toContainText('构建参数预览')
    await expect(buildPreview).toContainText('要点卡的构建标题取自来源段落标题')
    await expect(buildPreview).toContainText('未创建构建任务或文件')

    const renderPreview = report.getByRole('button', { name: '生成本地组图预览', exact: true })
    const assetFileRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes(`/assets/${asset.id}/file`)) assetFileRequests.push(request.url())
    })
    await renderPreview.click()
    const renderedImages = report.getByTestId('visual-card-rendered-image')
    await expect(renderedImages).toHaveCount(4)
    await expect(renderedImages.first()).toHaveJSProperty('naturalWidth', 1080)
    await expect(renderedImages.first()).toHaveJSProperty('naturalHeight', 1920)
    await expect(report.locator('figure figcaption span:first-child')).toHaveText([
      '01-cover.png', '02-quote-1.png', '03-point-1.png', '04-end.png',
    ])
    await expect(report).toContainText('本地预览不会创建构建、ZIP 文件或下载')
    expect(assetFileRequests.length).toBeGreaterThan(0)

    await page.evaluate(() => {
      const stats = { created: 0, revoked: 0 }
      const createObjectURL = URL.createObjectURL.bind(URL)
      const revokeObjectURL = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (object) => { stats.created++; return createObjectURL(object) }
      URL.revokeObjectURL = (url) => { stats.revoked++; revokeObjectURL(url) }
      ;(window as typeof window & { __cxObjectURLs?: typeof stats }).__cxObjectURLs = stats
    })
    await page.route(`**/api/v1/assets/${asset.id}/file`, async (route) => {
      const response = await route.fetch()
      const corrupted = Buffer.from(await response.body())
      corrupted.fill(0, 0, Math.min(16, corrupted.length))
      await route.fulfill({ response, body: corrupted })
    })
    await renderPreview.click()
    await expect(report).toContainText('图片解码失败，组图预览已停止。')
    await expect(renderedImages).toHaveCount(0)
    const failedRenderResources = await page.evaluate(() => ({
      stats: (window as typeof window & { __cxObjectURLs?: { created: number; revoked: number } }).__cxObjectURLs,
      hiddenSurfaces: document.querySelectorAll('[data-cx-card]').length,
    }))
    expect(failedRenderResources.stats?.created).toBeGreaterThan(0)
    expect(failedRenderResources.stats?.revoked).toBe(failedRenderResources.stats?.created)
    expect(failedRenderResources.hiddenSurfaces).toBe(0)
    await page.unroute(`**/api/v1/assets/${asset.id}/file`)
    await renderPreview.click()
    await expect(renderedImages).toHaveCount(4)

    const history = await api(page, origin, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: Array<{ diagnosis_id: string; result_revision: number; asset_ids: string[]; cards: Array<{ headline: string; confirmed: boolean }> }> }
    expect(history.items[0].result_revision).toBe(7)
    expect(history.items[0].asset_ids).toEqual([asset.id])
    expect(history.items[0].cards[0]).toMatchObject({ headline: '人工调整的封面标题', confirmed: true })
    const workAfterPlan = await api(page, origin, 'GET', `/works/${work.id}`) as { title: string; sections: Array<{ content_md: string }> }
    expect(workAfterPlan.title).toBe('逐步完成的一件小事')
    expect(workAfterPlan.sections[0].content_md).toContain('避免中途反复寻找')

    const regenerated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '重新生成候选', exact: true }).click()
    const changedInputResponse = await regenerated
    expect(changedInputResponse.ok()).toBeTruthy()
    expect(changedInputResponse.request().postDataJSON().section_ids).toHaveLength(5)
    const candidate = page.getByTestId('visual-plan-candidate')
    await expect(candidate).toBeVisible()
    await expect(candidate.getByRole('button', { name: '保留已确认/修改卡' }).first()).toBeDisabled()
    await expect(report.locator('[data-testid^="visual-plan-card-"]')).toHaveCount(4)
    await expect(firstCard.getByLabel('标题')).toHaveValue('人工调整的封面标题')
    const historyAfterNewInput = await api(page, origin, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: Array<{ diagnosis_id: string; result_revision: number; cards: Array<{ headline: string; confirmed: boolean }> }> }
    const unchangedOldPlan = historyAfterNewInput.items.find((item) => item.diagnosis_id === selectedImagePlan.diagnosis_id)
    expect(unchangedOldPlan?.result_revision).toBe(7)
    expect(unchangedOldPlan?.cards[0]).toMatchObject({ headline: '人工调整的封面标题', confirmed: true })

    const ratioSectionChoices = panel.locator('fieldset').first().getByRole('checkbox')
    await ratioSectionChoices.nth(2).uncheck()
    await ratioSectionChoices.nth(3).uncheck()
    await ratioSectionChoices.nth(4).uncheck()
    for (const [ratio, expectedHeight] of [['1:1', 1080], ['3:4', 1440]] as const) {
      await panel.getByLabel('比例').selectOption(ratio)
      const nextPlan = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
      await panel.getByRole('button', { name: '重新生成候选', exact: true }).click()
      expect((await nextPlan).ok()).toBeTruthy()
      const ratioCandidate = page.getByTestId('visual-plan-candidate')
      await expect(ratioCandidate).toBeVisible()
      await ratioCandidate.getByRole('button', { name: '切换为新计划', exact: true }).click()
      const currentCards = report.locator('[data-testid^="visual-plan-card-"]')
      await expect(currentCards).toHaveCount(4)
      for (let index = 0; index < 4; index++) {
        const card = report.getByTestId(`visual-plan-card-${index}`)
        const confirm = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
        await card.getByRole('button', { name: '确认此卡', exact: true }).click()
        expect((await confirm).ok()).toBeTruthy()
      }
      const params = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
      await report.getByRole('button', { name: '预览构建参数', exact: true }).click()
      expect((await params).ok()).toBeTruthy()
      await report.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
      const ratioImages = report.getByTestId('visual-card-rendered-image')
      await expect(ratioImages).toHaveCount(4)
      await expect(ratioImages.first()).toHaveJSProperty('naturalWidth', 1080)
      await expect(ratioImages.first()).toHaveJSProperty('naturalHeight', expectedHeight)
    }

    const coverCard = report.getByTestId('visual-plan-card-0')
    await coverCard.getByLabel('文案').fill('W'.repeat(300))
    const saveOverflowText = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '保存计划', exact: true }).click()
    expect((await saveOverflowText).ok()).toBeTruthy()
    const confirmOverflowText = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
    await coverCard.getByRole('button', { name: '确认此卡', exact: true }).click()
    expect((await confirmOverflowText).ok()).toBeTruthy()
    const overflowParams = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
    await report.getByRole('button', { name: '预览构建参数', exact: true }).click()
    expect((await overflowParams).ok()).toBeTruthy()
    await report.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
    await expect(report).toContainText('有卡片在三档字号调整后仍溢出')
    await expect(report.locator('figure').first()).toContainText('缩小三档字号后仍有文字超出卡片区域')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
