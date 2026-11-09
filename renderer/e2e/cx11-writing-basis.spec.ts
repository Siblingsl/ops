import { expect, test, type Page } from '@playwright/test'
import { registerAccount } from './support'

async function enableDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

test('CX11 大纲生成展示服务端来源回执与缺项', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}`)

  await page.getByRole('button', { name: '新建作品', exact: true }).first().click()
  const creationPanel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(creationPanel).toBeVisible()
  await creationPanel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)

  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()
  const steps = page.getByTestId('desktop-editor-steps')
  await steps.getByRole('link', { name: '大纲', exact: true }).click()
  const outlineDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '生成与确认大纲', exact: true }) })
  await expect(outlineDialog).toBeVisible()
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await viewpoint.fill('少而精的步骤更容易长期坚持，这是我的经验判断。')
  await viewpoint.blur()
  await outlineDialog.getByRole('button', { name: 'AI 生成大纲', exact: true }).click()
  await expect(outlineDialog.getByRole('button', { name: '确认大纲', exact: true })).toBeVisible()

  const basisSummary = outlineDialog.getByRole('button', { name: /创作依据/ }).first()
  await expect(basisSummary).toBeVisible()
  await basisSummary.click()

  await expect(page.getByText('创作依据', { exact: true })).toBeVisible()
  await expect(page.getByText(new RegExp(`profile · ${account.id}`))).toBeVisible()
  await expect(page.getByText(/material：本次没有选入可用素材/)).toBeVisible()
  await expect(page.getByText(/输入版本 [a-f0-9]{16}/)).toBeVisible()
  await expect(page.getByText(/任务：outline · 模型：.+ · 提示词版本：1 · 状态：ok/)).toBeVisible()
})
