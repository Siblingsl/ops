import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT18 设置菜单默认仅显四个常用项，高级项可展开且命令面板可搜索', async ({ page }) => {
  await registerAccount(page)
  const userMenu = page.locator('button[aria-haspopup="menu"]')
  await userMenu.click()

  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveCount(5)
  for (const label of ['平台账号与凭证', '模型配置', '成员与邀请', '偏好设置']) {
    await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
  await expect(menu.getByRole('menuitem', { name: '热点来源', exact: true })).toHaveCount(0)

  const advanced = menu.getByRole('button', { name: '高级设置', exact: true })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await advanced.click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
  for (const label of ['智能体设置', '写作技能', 'AI 用量与成本', 'AI 质量看板', '敏感词库', '提示词模板', '数据导出', '操作日志', '回收站', '登录与安全', '热点来源', '每日推荐设置']) {
    await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
  await expect(menu.getByRole('menuitem', { name: '热点采集与日志', exact: true })).toHaveCount(0)
  // DEV-SK4：写作技能进入高级设置（registry 单一事实源），总数 16 → 17。
  await expect(menu.getByRole('menuitem')).toHaveCount(17)

  await userMenu.click()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByPlaceholder('搜索作品、选题、素材，或输入命令（支持拼音首字母）').fill('每日推荐设置')
  await palette.getByRole('button', { name: '每日推荐设置', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/daily$/)

  await userMenu.click()
  await expect(page.getByRole('menu').getByRole('button', { name: '高级设置' })).toHaveAttribute('aria-expanded', 'true')
})
