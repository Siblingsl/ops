import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// Web 形态的 DEV-CX09 旅程：浏览器编辑页内的小红书组图计划（AI 候选、逐卡确认、只读参数预览与本机栅格预览）。
// 桌面形态的对应旅程见 desktop/renderer-src/e2e/cx09-visual-plan-desktop.spec.ts（真实 Electron）。
// 本用例只验证本地 mock；不生成文件、不调用 build、不改变作品正文或发布事实。
test('DEV-CX09 Web 组图计划逐卡确认、候选保护与本机预览', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx09-visual-web-${Date.now()}`)
  await api(page, 'PUT', `/accounts/${account.id}/visual-dna`, {
    base_version: 0,
    tokens: {
      schema: 'ops.visual-dna/v1',
      palette: { primary: '#1B5E20', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
      font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
      watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
      card_template_default: 'swiss', card_ratio_default: '9:16', end_copy: '关注后继续阅读',
    },
  })
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '浏览器里的组图计划' }) as { id: string; revision: number }
  const changed = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '把要做的事情拆成可检查的小步骤', base_revision: work.revision })
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: changed.revision,
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
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: sectionTexts[index], base_revision: section.revision })
  }
  const me = await api(page, 'GET', '/auth/me') as { csrf_token: string }
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d9e8ee'
    context.fillRect(0, 0, 64, 64)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const asset = await page.evaluate(async ({ workId, imageData, csrf }) => {
    const bytes = Uint8Array.from(atob(imageData), (character) => character.charCodeAt(0))
    const form = new FormData()
    form.append('file', new File([bytes], 'cx09-web-source.png', { type: 'image/png' }))
    const response = await fetch(`/api/v1/works/${workId}/assets`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`POST /works/${workId}/assets: ${response.status} ${body}`)
    return JSON.parse(body) as { id: string }
  }, { workId: work.id, imageData, csrf: me.csrf_token })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'CX09 Web 本地模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_visual_plan', provider_id: provider.id, model: 'mock-writer' }])

  await page.goto(`/works/${work.id}`)
  const panel = page.getByTestId('visual-plan-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('AI 组图计划')
  await expect(panel.getByLabel('视觉 DNA')).toHaveValue('1')
  await expect(panel.getByLabel('模板')).toHaveValue('swiss')
  await expect(panel.getByLabel('比例')).toHaveValue('9:16')

  // 模型失败：提示错误，且没有写入任何报告。
  await page.route(`**/api/v1/works/${work.id}/cards/suggest`, (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '模拟模型不可用' } }),
  }))
  await panel.getByRole('button', { name: 'AI 编排', exact: true }).click()
  await expect(panel).toContainText('模拟模型不可用')
  await page.unroute(`**/api/v1/works/${work.id}/cards/suggest`)
  expect((await api(page, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`)).items).toHaveLength(0)

  // 手工编排：5 段默认 7 卡，逐卡确认后只读预览 + 本机栅格预览（浏览器 Chromium 渲染）。
  await panel.getByRole('button', { name: '手工编排', exact: true }).click()
  const manual = panel.getByTestId('manual-visual-plan')
  await expect(manual).toBeVisible()
  const manualCards = manual.locator('[data-testid^="manual-visual-card-"]')
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
  expect(manualPreviewResult.request().postDataJSON().visual_plan_id).toBeUndefined()
  await expect(manual.getByTestId('manual-cards-params-preview')).toBeVisible()
  await manual.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
  const manualImages = manual.getByTestId('visual-card-rendered-image')
  await expect(manualImages).toHaveCount(7)
  await expect(manualImages.first()).toHaveJSProperty('naturalWidth', 1080)
  await expect(manualImages.first()).toHaveJSProperty('naturalHeight', 1920)
  const manualHistory = await api(page, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: unknown[] }
  expect(manualHistory.items).toHaveLength(0)
  await panel.getByRole('button', { name: '收起手工编排', exact: true }).click()

  // AI 编排（2 段 + 1 图 + DNA v1）：勾选上传图片纳入来源，生成报告后先补齐来源再确认；候选生成不覆盖当前报告。
  const sectionChoices = panel.locator('fieldset').first().getByRole('checkbox')
  await sectionChoices.nth(2).uncheck()
  await sectionChoices.nth(3).uncheck()
  await sectionChoices.nth(4).uncheck()
  await expect(sectionChoices.nth(0)).toBeChecked()
  await expect(sectionChoices.nth(1)).toBeChecked()
  await panel.getByRole('checkbox').last().check()
  const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: 'AI 编排', exact: true }).click()
  const generateResponse = await generated
  expect(generateResponse.ok()).toBeTruthy()
  expect(generateResponse.request().postDataJSON().dna_version).toBe(1)
  expect(generateResponse.request().postDataJSON().asset_ids).toEqual([asset.id])
  const savedPlan = await api(page, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: Array<{ diagnosis_id: string; result_revision: number; cards: Array<{ card_id: string; type: string; section_ids: string[]; headline: string; body: string | { left: string; right: string }; asset_ids: string[]; source_refs: string[]; confirmed: boolean; edited: boolean }> }> }
  const aiPlan = savedPlan.items[0]
  const planWithImage = aiPlan.cards.map(({ edited: _edited, ...card }, index) => index === 0
    ? { ...card, asset_ids: [asset.id], source_refs: [...card.source_refs, `asset:${asset.id}`] }
    : index === 1
      ? { ...card, type: 'quote', body: '列出要用到的材料，避免中途反复寻找。' }
      : card)
  await api(page, 'PATCH', `/diagnoses/${aiPlan.diagnosis_id}/visual-plan`, {
    expected_revision: aiPlan.result_revision, cards: planWithImage,
  })
  await page.reload()
  const report = page.getByTestId('visual-plan-report')
  await expect(report).toBeVisible()
  await expect(report.getByText(/内容覆盖完整/)).toBeVisible()
  await expect(report.locator('[data-testid^="visual-plan-card-"]')).toHaveCount(4)
  await expect(report).toContainText('视觉 DNA v1')

  const firstCard = report.getByTestId('visual-plan-card-0')
  await firstCard.getByLabel('标题').fill('浏览器调整的封面标题')
  const saveEdit = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
  await report.getByRole('button', { name: '保存计划', exact: true }).click()
  expect((await saveEdit).ok()).toBeTruthy()
  await expect(firstCard.getByLabel('标题')).toHaveValue('浏览器调整的封面标题')

  for (let index = 0; index < 4; index++) {
    const card = report.getByTestId(`visual-plan-card-${index}`)
    const confirm = page.waitForResponse((response) => response.url().includes('/visual-plan') && response.request().method() === 'PATCH')
    await card.getByRole('button', { name: '确认此卡', exact: true }).click()
    expect((await confirm).ok()).toBeTruthy()
    await expect(card.getByText('已逐卡确认')).toBeVisible()
  }

  const preview = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/preview`) && response.request().method() === 'POST')
  await report.getByRole('button', { name: '预览构建参数', exact: true }).click()
  const previewResponse = await preview
  expect(previewResponse.ok()).toBeTruthy()
  const previewBody = await previewResponse.json()
  const currentWork = await api(page, 'GET', `/works/${work.id}`) as { revision: number }
  expect(previewBody).toMatchObject({ basis_revision: currentWork.revision, template: 'swiss', ratio: '9:16', dna_version: 1 })
  expect(previewBody.source_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(previewBody.params_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(previewBody.cards).toHaveLength(4)
  expect(previewBody.cards.every((card: { confirmed?: unknown }) => card.confirmed === undefined)).toBeTruthy()
  const buildPreview = report.getByTestId('cards-build-preview')
  await expect(buildPreview).toContainText('构建参数预览')
  await expect(buildPreview).toContainText('未创建构建任务或文件')

  // 本机栅格预览：确认走的是浏览器内的资源请求，产物为 1080×1920 PNG data URL。
  const assetFileRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/assets/${asset.id}/file`)) assetFileRequests.push(request.url())
  })
  await report.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
  const renderedImages = report.getByTestId('visual-card-rendered-image')
  await expect(renderedImages).toHaveCount(4)
  await expect(renderedImages.first()).toHaveJSProperty('naturalWidth', 1080)
  await expect(renderedImages.first()).toHaveJSProperty('naturalHeight', 1920)
  await expect(report.locator('figure figcaption span:first-child')).toHaveText([
    '01-cover.png', '02-quote-1.png', '03-point-1.png', '04-end.png',
  ])
  await expect(report).toContainText('本地预览不会创建构建、ZIP 文件或下载')
  expect(assetFileRequests.length).toBeGreaterThan(0)

  // 损坏图片解码失败：整组清空、对象 URL 全部撤销、隐藏渲染节点移除；恢复后可重试。
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
  await report.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
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
  await report.getByRole('button', { name: '生成本地组图预览', exact: true }).click()
  await expect(renderedImages).toHaveCount(4)

  // 全程无 build 写入，作品正文未被改动。
  const buildsAfter = await api(page, 'GET', `/works/${work.id}/builds`) as { items: unknown[] }
  expect(buildsAfter.items).toHaveLength(0)
  const workAfter = await api(page, 'GET', `/works/${work.id}`) as { title: string; sections: Array<{ content_md: string }> }
  expect(workAfter.title).toBe('浏览器里的组图计划')
  expect(workAfter.sections[0].content_md).toContain('避免中途反复寻找')

  // 改变选段后重新生成：新输入先作为候选展示，旧报告保持修订与人工标题。
  const regenerated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/cards/suggest`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '重新生成候选', exact: true }).click()
  expect((await regenerated).ok()).toBeTruthy()
  const candidate = page.getByTestId('visual-plan-candidate')
  await expect(candidate).toBeVisible()
  await expect(candidate.getByRole('button', { name: '保留已确认/修改卡' }).first()).toBeDisabled()
  await expect(report.locator('[data-testid^="visual-plan-card-"]')).toHaveCount(4)
  await expect(firstCard.getByLabel('标题')).toHaveValue('浏览器调整的封面标题')
  const historyAfterNewInput = await api(page, 'GET', `/works/${work.id}/diagnoses?kind=visual_plan`) as { items: Array<{ diagnosis_id: string; result_revision: number; cards: Array<{ headline: string; confirmed: boolean }> }> }
  const unchangedOldPlan = historyAfterNewInput.items.find((item) => item.diagnosis_id === aiPlan.diagnosis_id)
  // 旧报告经逐卡编辑与确认后 result_revision 已多次推进；候选生成不得替换它，只能大于生成时修订。
  expect(unchangedOldPlan?.result_revision).toBeGreaterThan(aiPlan.result_revision)
  expect(unchangedOldPlan?.cards[0]).toMatchObject({ headline: '浏览器调整的封面标题', confirmed: true })
})
