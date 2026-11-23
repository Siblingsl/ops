import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test.describe('REF41 I4 Web 两段式六维选题评分', () => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('选题卡显示六维小柱，低分返回 ai_skipped 并逐维解释', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `i4-topic-score-web-${Date.now()}`)
    const created = await api(page, 'POST', `/accounts/${account.id}/topics`, {
      title: '新手如何开始稳定写作',
      angle: '从每天可执行的一小步切入',
    })

    // 选题没有定位标签、素材、计划日期和历史互动，规则分必然低于 60，用于验证省钱闸。
    const scored = await api(page, 'POST', `/topics/${created.topic.id}/score`, { mode: 'two_stage' })
    expect(scored.result.ai_skipped).toBe(true)
    expect(scored.result.rule_max).toBe(120)
    expect(scored.result.threshold).toBe(60)
    expect(scored.result.ai_skip_reason).toContain('规则分未达阈值，未调用 AI')
    expect(Object.keys(scored.result.dimensions).sort()).toEqual([
      'audience', 'deliverability', 'demand', 'differentiation', 'material', 'timeliness',
    ])

    await page.goto(`/a/${account.id}/topics`)
    const bars = page.getByTestId('topic-score-bars').first()
    await expect(bars).toBeVisible()
    await expect(bars).toContainText('六维总分')
    await expect(bars).toContainText('AI 已跳过')
    await expect(page.locator('[data-testid^="topic-score-bar-"]')).toHaveCount(6)

    const panel = page.getByTestId('topic-score-panel').first()
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('规则分')
    await expect(panel).toContainText('阈值 60')
    await expect(panel.getByTestId('topic-score-ai-skipped')).toContainText('规则分未达阈值，未调用 AI（省成本）')
    await expect(panel.getByRole('button', { name: '仍要 AI 复核', exact: true })).toBeVisible()

    const dimensions = panel.locator('[data-testid^="topic-score-dim-"]')
    await expect(dimensions).toHaveCount(6)
    for (let i = 0; i < 6; i += 1) {
      await expect(dimensions.nth(i)).toContainText('依据：')
      await expect(dimensions.nth(i)).toContainText('为什么不是更高：')
    }
    await expect(panel.getByText(/推荐采纳|自动采纳/)).toHaveCount(0)

    await page.screenshot({ path: '../.playwright-results/web/i4-topic-score-web.png', fullPage: true })
  })
})
