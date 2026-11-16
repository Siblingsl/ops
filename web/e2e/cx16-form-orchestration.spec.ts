import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-CX-16 / FR-CX-16：编排入口区分同稿组图产物与跨平台派生；无「生成全部形态」。
test('CF-CX-16 一稿多形态入口区分产物与派生且无批量生成', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟环境')
  const account = await registerAccount(page, '图文笔记', 'xhs', `cx16-forms-${Date.now()}`)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'CX16 多形态编排' })
  await page.goto(`/works/${work.id}`)

  await page.getByRole('button', { name: '一稿多形态', exact: true }).click()
  const orch = page.getByTestId('form-orchestration')
  await expect(orch).toBeVisible()
  await expect(page.getByRole('heading', { name: '一稿多形态', exact: true })).toBeVisible()
  await expect(page.getByText(/生成全部形态|全部形态|一键生成全部/)).toHaveCount(0)

  const cards = page.getByTestId('form-orch-cards')
  const derive = page.getByTestId('form-orch-derive')
  await expect(cards).toBeEnabled()
  await expect(derive).toBeVisible()

  await derive.click()
  await expect(page.getByRole('heading', { name: '派生到其他平台', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: '一稿多形态', exact: true }).click()
  await page.getByTestId('form-orch-cards').click()
  await expect(page.getByTestId('visual-plan-panel')).toBeVisible()
  await expect(page.locator('#visual-plan')).toBeInViewport()
})
