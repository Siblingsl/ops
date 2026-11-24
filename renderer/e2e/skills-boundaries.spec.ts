import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

const definition = (name: string) => ({ name, summary: '边界验收', triggers: '测试时使用', instructions: '已有草稿正文。', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' })
const modal = (page: Page) => page.getByRole('dialog', { name: '技能编辑', exact: true })
const confirmDialog = (page: Page, name: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name, exact: true }) })

test('TestSkillDesktopDirectRoutesExposeManagement', async ({ page }) => {
  const account = await registerAccount(page)
  const skillName = `桌面直开技能-${Date.now()}`
  await api(page, 'POST', '/skills', {
    scope: 'personal', name: skillName, summary: '验证桌面可直接管理技能', triggers: '桌面验收时使用',
    instructions: '桌面端直接完成技能列表加载与创建交互。', platforms: [], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  })
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'OPS Electron/44.8.0' }))
  await page.goto('/settings/skills')
  await expect(page.getByRole('button', { name: '新建技能', exact: true })).toBeVisible()
  await expect(page.getByText(skillName, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '在浏览器中管理技能', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '新建技能', exact: true }).click()
  await expect(modal(page)).toBeVisible()
  await expect(modal(page).getByRole('heading', { name: '新建技能', exact: true })).toBeVisible()
  await modal(page).getByRole('button', { name: '取消', exact: true }).click()
  await page.goto(`/a/${account.id}/profile`)
  const skillsTab = page.getByRole('button', { name: '写作技能', exact: true })
  await expect(skillsTab).toBeVisible()
  await skillsTab.click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/profile\\?tab=skills$`))
  await expect(page.getByLabel('选择个人技能')).toBeVisible()
  await expect(page.getByRole('region', { name: '我的个人技能' }).getByRole('link', { name: '管理技能库', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '在浏览器中管理技能', exact: true })).toHaveCount(0)
})


