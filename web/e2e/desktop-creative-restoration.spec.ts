import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { api, registerAccount } from './support'

test('Electron 作品页按原型分层并保留逐项筛选与导入操作', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const title = '给重要的事留出时间'
  const me = await api(page, 'GET', '/auth/me')
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title, tags: ['时间管理'] })
  const today = new Date()
  const plannedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await api(page, 'PATCH', `/works/${work.id}`, { assignee_id: me.user_id, planned_date: plannedDate, tags: ['时间管理'] })

  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/works`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

  const statusTab = page.getByRole('tab', { name: /全部/ })
  const search = page.getByPlaceholder('搜索作品名称或标签')
  const tabBox = await statusTab.boundingBox()
  const searchBox = await search.boundingBox()
  expect(tabBox).not.toBeNull()
  expect(searchBox).not.toBeNull()
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/works-layout-after.png') })
  expect(searchBox!.y, '搜索与筛选应位于状态切换下方的独立一行').toBeGreaterThan(tabBox!.y + tabBox!.height + 16)
  await expect(page.getByRole('tablist').filter({ has: statusTab }).getByRole('tab')).toHaveCount(7)
  await expect(page.locator('.desktop-work-header')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.desktop-work-title-cell svg')).toHaveCSS('width', '17px')

  await expect(page.getByRole('button', { name: '导入旧文' })).toBeVisible()
  const statusCases = [
    ['创作中', 'drafting', 1],
    ['检查中', 'checking', 0],
    ['待审阅', 'reviewing', 0],
    ['可发布', 'ready', 0],
    ['已进草稿箱', 'out', 0],
    ['已发布', 'published', 0],
  ] as const
  for (const [label, status, count] of statusCases) {
    const tab = page.getByRole('tab', { name: new RegExp(label) })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`status=${status}`))
    await expect(page.getByTestId('desktop-work-row')).toHaveCount(count)
  }
  await page.getByRole('tab', { name: /全部/ }).click()
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)

  await search.fill('不存在的作品')
  await expect(page.getByTestId('desktop-work-row')).toHaveCount(0)
  await search.fill(title)
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)

  await page.getByLabel('按标签筛选').selectOption({ label: '时间管理' })
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)
  await page.getByLabel('负责人').selectOption(me.user_id)
  await expect(page).toHaveURL(new RegExp(`assignee=${me.user_id}`))
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)
  await page.getByLabel('负责人').selectOption('')

  await page.getByTestId('desktop-work-row').getByRole('button', { name: '收藏' }).click()
  await expect(page.getByTestId('desktop-work-row').getByRole('button', { name: '取消收藏' })).toBeVisible()

  await page.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(page).toHaveURL(/star=1/)
  await page.getByRole('button', { name: /本周要发/ }).click()
  await expect(page).toHaveURL(/week=1/)
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)
  await page.getByRole('button', { name: /我负责的/ }).click()
  await expect(page).toHaveURL(/mine=1/)
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)

  await page.getByRole('button', { name: '保存当前筛选为视图' }).click()
  await expect(page.getByPlaceholder('视图名称')).toBeVisible()
  await page.getByPlaceholder('视图名称').fill('逐项点击验收')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const savedView = page.getByRole('button', { name: '逐项点击验收' })
  await expect(savedView).toBeVisible()
  await search.fill('不存在的作品')
  await expect(page.getByTestId('desktop-work-row')).toHaveCount(0)
  await savedView.click()
  await expect(page.getByTestId('desktop-work-row')).toContainText(title)

  const workRow = page.getByTestId('desktop-work-row').filter({ hasText: title }).first()
  await workRow.getByRole('button', { name: '编辑作品标签' }).click()
  const tagsDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑作品标签' }) })
  await expect(tagsDialog).toBeVisible()
  await tagsDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(tagsDialog).toBeHidden()

  await workRow.getByRole('button', { name: '派生到其他平台' }).click()
  const deriveDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '派生到其他平台' }) })
  await expect(deriveDialog).toBeVisible()
  await deriveDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(deriveDialog).toBeHidden()

  await workRow.getByRole('button', { name: '更多', exact: true }).click()
  const duplicateAction = page.getByRole('menuitem', { name: '复制为新草稿' })
  await expect(duplicateAction).toBeVisible()
  await duplicateAction.click()
  await expect(page).toHaveURL(/\/works\/[a-f0-9-]+$/)
  await page.goto(`/a/${account.id}/works`)
  await expect(page.getByTestId('desktop-work-row')).toHaveCount(2)

  const deleteRow = page.getByTestId('desktop-work-row').filter({ hasText: title }).first()
  await deleteRow.getByRole('button', { name: '删除' }).click()
  const undoButton = page.getByRole('button', { name: '撤销', exact: true })
  await expect(undoButton).toBeVisible()
  await undoButton.click()
  await expect(page.getByTestId('desktop-work-row')).toHaveCount(2)

  await page.getByRole('button', { name: '导入旧文' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByTestId('desktop-page-frame').getByRole('button', { name: '新建作品', exact: true }).click()
  const createPanel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(createPanel).toBeVisible()
  await createPanel.getByRole('button', { name: '开始创作', exact: true }).click()
  await expect(page).toHaveURL(/\/works\/[a-f0-9-]+$/)

  await page.goto(`/a/${account.id}/works`)
  await page.setViewportSize({ width: 960, height: 640 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960)
})
