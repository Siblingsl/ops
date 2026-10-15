import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

const sidebarTabs = ['写作 · 素材', '写作 · 副驾驶', '写作 · 待核实', '修改 · 通读', '修改 · 体检', '协作 · 批注', '协作 · 动态']

test('OPT25 1024 与 390 宽度可打开助手抽屉并切换全部七个页签', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT25 窄屏侧栏验收' })

  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/works/${work.id}`)
    await page.getByRole('button', { name: '打开助手工具' }).click()

    await expect(page.getByRole('heading', { name: '作品工具', exact: true })).toBeVisible()
    for (const title of sidebarTabs) {
      const tab = page.getByTitle(title)
      await tab.last().click()
      await expect(tab.last()).toHaveClass(/bg-ink-50/)
    }

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '作品工具', exact: true })).toBeHidden()
  }
})
