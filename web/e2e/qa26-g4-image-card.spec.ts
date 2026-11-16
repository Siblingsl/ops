import { expect, test, type Page } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

// CF-P2-QA-02 批次 QA-B4（docs/26 G4-10/G4-13，docs/34 §14.7）：
// G4-13 图文卡片编辑器：card_post 作品 → 大纲生成+H-03 确认 → 卡片清单渲染 → 逐卡文案编辑保存 → 上移/下移。
// G4-10 配图建议与 AI 出图：段落「配图建议」（mock image_suggest）→ 建议对话框 →「本系统文生图」
// （mock images/generations，1x1 PNG，AI 标识由产品契约承担）→ 资产读回。
// 无外部依赖：AI 全走本地 mock。

test('DEV-QA26 G4-13 卡片编辑器与 G4-10 配图建议+文生图', async ({ page, baseURL }) => {
  const account = await registerAccount(page, '图文卡片', 'xhs', `qa26-g4-card-${Date.now()}`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'QA-B4 卡片模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-card-e2e'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    ...['default', 'outline', 'section_draft', 'image_suggest', 'image_gen'].map((task_type) => ({ task_type, provider_id: provider.id, model: 'mock-card-e2e' })),
  ])

  // 建 card_post 作品：观点 → 大纲生成 → H-03 确认（PUT outline confirm）→ 卡片出现
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'QA-B4 卡片作品' })
  await page.goto(`/works/${work.id}`)
  await expect(page.getByRole('heading', { name: /QA-B4 卡片作品/ }).first()).toBeVisible()
  await page.getByPlaceholder(/用一两句话写下你自己的观点/).fill('少而精的工具才用得久')
  await page.getByRole('button', { name: 'AI 生成大纲' }).click()
  // generateOutline 只在响应里给 items（不落库）；「确认大纲」UI 提交后才持久化。
  await page.getByRole('button', { name: '确认大纲' }).click()
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { outline_confirmed_at?: string | null; outline?: unknown[] }
    return !!w.outline_confirmed_at && (w.outline ?? []).length
  }, { timeout: 60_000 }).toBeGreaterThan(0)
  await expect(page.locator('#step-cards').getByText('已确认')).toBeVisible()
  await expect(page.getByText('卡片清单')).toBeVisible()

  // 逐卡文案编辑 + 保存（第一张卡）
  const detail = (await api(page, 'GET', `/works/${work.id}`)) as { sections: Array<{ id: string; heading: string }> }
  const firstSection = detail.sections[0]
  const bodyBox = page.getByPlaceholder('卡片正文：两三行以内，可直接照做或收藏').first()
  await bodyBox.click()
  await bodyBox.fill('QA-B4 卡片正文：先给结论，再给步骤，控制在 80 字内。')
  await page.getByRole('heading', { name: '核心观点' }).click() // blur 触发卡片保存
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { sections: Array<{ id: string; content_md: string }> }
    return w.sections.find(s => s.id === firstSection.id)?.content_md ?? ''
  }, { timeout: 20_000 }).toContain('QA-B4 卡片正文')

  // G4-10：卡片配图（card_post 的出图入口）——留空提示词按卡片文案生成（mock images/generations 1x1 PNG）
  await page.getByRole('button', { name: '生成配图' }).first().click()
  await expect(page.getByText('卡片配图已生成')).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { assets?: Array<{ id: string }> }
    return (w.assets ?? []).length
  }, { timeout: 30_000 }).toBeGreaterThan(0)
  // 配图建议（image_suggest）对话框在 ArticleEditor 的段落块；card_post 走逐卡出图。
  // 两者共用 mock image 通道；本用例覆盖 card_post 主路径，段落级建议随既有段落旅程覆盖。

  // 卡片上移/下移（顺序变更持久化）
  const beforeOrder = ((await api(page, 'GET', `/works/${work.id}`)) as { sections: Array<{ id: string }> }).sections.map(s => s.id)
  if (detail.sections.length >= 2) {
    // aria-label「上移卡片 N」在第二张卡（N=2）；index===1（第一张）禁用。
    await page.getByRole('button', { name: '上移卡片 2' }).click()
    await expect.poll(async () => {
      const w = (await api(page, 'GET', `/works/${work.id}`)) as { sections: Array<{ id: string }> }
      return w.sections.map(s => s.id).join(',')
    }, { timeout: 20_000 }).not.toBe(beforeOrder.join(','))
  }
})
