import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX09 交付构建：用户确认的组图计划 → options.cards 采用 → 浏览器渲染 PNG → ZIP → 服务端逐张校验。
// Q-CX-03/04 已拍板（90 D-165）：纯净组图构建 complete 直接置 built；下载按门禁四态开放。
// 只使用本地模拟 API 与模拟模型。
test('DEV-CX09 Web 组图交付构建逐张校验与隐私门禁', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(180_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx09-cards-build-${Date.now()}`)
  await api(page, 'PUT', `/accounts/${account.id}/visual-dna`, {
    base_version: 0,
    tokens: {
      schema: 'ops.visual-dna/v1',
      palette: { primary: '#1B5E20', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
      font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
      watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
      card_template_default: 'editorial', card_ratio_default: '3:4', end_copy: '关注后继续阅读',
    },
  })
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '组图交付构建验收' }) as { id: string; revision: number }
  const changed = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '把要做的事情拆成可检查的小步骤', base_revision: work.revision }) as { revision: number }
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: changed.revision,
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
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: sectionTexts[index], base_revision: section.revision })
  }
  await page.goto(`/works/${work.id}`)

  const panel = page.getByTestId('visual-plan-panel')
  await expect(panel).toBeVisible()
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

  // 明确采用：一次点击只创建一个构建；先渲染 ZIP，再创建、上传、提交校验。
  const createBuild = page.waitForResponse((response) => response.url().endsWith(`/works/${work.id}/builds`) && response.request().method() === 'POST')
  const completion = page.waitForResponse((response) => response.url().includes('/complete') && response.request().method() === 'POST')
  await report.getByRole('button', { name: '生成交付构建', exact: true }).click()
  const created = await createBuild
  const createdText = await created.text()
  expect(created.status(), createdText).toBe(201)
  const createdBody = JSON.parse(createdText) as { build_id: string; source_hash: string; params_hash: string }
  // 服务端冻结的输入必须与用户看到的预览一致，否则构建产物不可追溯。
  expect(createdBody.source_hash).toBe(previewBody.source_hash)
  expect(createdBody.params_hash).toBe(previewBody.params_hash)
  const completionResponse = await completion
  const completionText = await completionResponse.text()
  // Q-CX-03 拍板后（90 D-165）：纯净组图构建 complete 直接置 built，下载门禁 clear。
  expect(completionResponse.status(), completionText).toBe(200)
  expect(completionText).toContain('"status":"built"')
  await expect(report).toContainText('组图交付包已通过结构与像素校验')
  await expect(report.getByTestId('cards-build-detail')).toContainText('下载门禁：已开放')

  // 服务端状态：built；ZIP 是唯一产物且可下载；逐张条目已记录。
  const builds = await api(page, 'GET', `/works/${work.id}/builds`) as { items: Array<{ id: string; status: string; error_code: string | null }> }
  expect(builds.items[0]).toMatchObject({ status: 'built', error_code: null })
  const detail = await api(page, 'GET', `/builds/${builds.items[0].id}`) as {
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
  // 序号 + 类型命名；封面在首、结尾在末，与两端渲染器规则一致。
  for (const name of entryNames) expect(name).toMatch(/^\d{2}-(cover|point-\d+|quote-\d+|compare-\d+|end)\.png$/)
  expect(entryNames[0]).toMatch(/^01-cover\.png$/)
  expect(entryNames[entryNames.length - 1]).toMatch(/-end\.png$/)
  expect(detail.validation.cards.entries.every((entry) => entry.width === 1080 && entry.height === 1440)).toBe(true)

  // 构建不修改原稿。
  const workAfter = await api(page, 'GET', `/works/${work.id}`) as { sections: Array<{ content_md: string }> }
  expect(workAfter.sections[0].content_md).toBe(sectionTexts[0])
})
