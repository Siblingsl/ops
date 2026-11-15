import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-CX-16 / FR-CX-16（P1-4 桌面配对，与 web/e2e/cx16-form-orchestration.spec.ts 同旅程）：
// 编排入口区分「同稿组图产物」与「跨平台派生独立稿」；无「生成全部形态」批量入口（D-117）。
// 桌面差异：WorkLayout 的「多形态」按钮 + 更多菜单项，对话框为桌面独立 FormOrchestrationDialog。
test('CF-CX-16 桌面一稿多形态入口区分产物与派生且无批量生成', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟环境')
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx16-forms-desktop-${Date.now()}`)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'CX16 桌面多形态编排' })
  await page.goto(`/works/${work.id}`)

  await page.getByTestId('work-forms').click()
  const orch = page.getByTestId('form-orchestration')
  await expect(orch).toBeVisible()
  await expect(page.getByRole('heading', { name: '一稿多形态', exact: true })).toBeVisible()
  // 无批量入口：任何「全部/一键生成」文案不得出现（24 §5.3 验收 + D-117）。
  await expect(page.getByText(/生成全部形态|全部形态|一键生成全部/)).toHaveCount(0)

  const cards = page.getByTestId('form-orch-cards')
  const derive = page.getByTestId('form-orch-derive')
  await expect(cards).toBeEnabled()
  await expect(derive).toBeVisible()
  // 跨平台派生：打开既有 DeriveDialog（每次只创建一篇目标作品），取消关闭。
  await derive.click()
  await expect(page.getByRole('heading', { name: '派生到其他平台', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()

  // 同稿产物：滚动到编辑器内的组图计划面板（不新建作品）。
  await page.getByTestId('work-forms').click()
  await page.getByTestId('form-orch-cards').click()
  await expect(page.getByTestId('visual-plan-panel')).toBeVisible()
  await expect(page.locator('#visual-plan')).toBeInViewport()
})
