import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const definition = (name: string) => ({ name, summary: '边界验收', triggers: '测试时使用', instructions: '已有草稿正文。', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' })
const modal = (page: Page) => page.getByRole('dialog', { name: '技能编辑', exact: true })
const confirmDialog = (page: Page, name: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name, exact: true }) })

test('TestSkillDesktopDirectRoutesExposeWebLinkWithoutManagement', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'OPS Electron/44.8.0' }))
  await page.goto('/settings/skills')
  await expect(page.getByRole('link', { name: '在浏览器中管理技能', exact: true })).toHaveAttribute('href', /\/settings\/skills$/)
  await expect(page.getByRole('button', { name: '新建技能', exact: true })).toHaveCount(0)
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  await expect(page.getByRole('link', { name: '在浏览器中管理技能', exact: true })).toHaveAttribute('href', new RegExp(`/a/${account.id}/profile\\?tab=skills$`))
  await expect(page.getByLabel('选择个人技能')).toHaveCount(0)
})


