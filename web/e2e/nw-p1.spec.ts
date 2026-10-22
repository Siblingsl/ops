import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('NW-A1 新建作品面板：标题可空、形态可选、从选题开始', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const { topic } = await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '面板里的选题', angle: '从一个小切口开始' })

  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(panel).toBeVisible()
  await expect(panel.getByPlaceholder('未命名作品')).toBeVisible()
  await expect(panel.getByRole('radio', { name: '文章' })).toBeChecked()

  // 取消不创建任何作品。
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(panel).toHaveCount(0)

  // 从选题开始：标题自动带入选题，创建后选题变为已采用。
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await expect(panel).toBeVisible()
  const topicSelect = panel.getByRole('combobox', { name: /从选题开始（可选）/ })
  await expect(topicSelect.locator('option', { hasText: '面板里的选题' })).toHaveCount(1)
  await topicSelect.selectOption({ label: '面板里的选题' })
  await expect(panel.getByPlaceholder('未命名作品')).toHaveValue('面板里的选题')
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${account.id}/works`) && r.request().method() === 'POST')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  const work = await (await created).json()
  await page.waitForURL(new RegExp(`/works/${work.id}$`))
  expect(work.topic_id).toBe(topic.id)
  expect(work.assignee_id).toBeTruthy()
  expect(work.created_by).toBeTruthy()
})

test('NW-A1 空标题也能创建，作品显示为未命名作品', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/works`)
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/v1/accounts/${account.id}/works`) && r.request().method() === 'POST')
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  const work = await (await created).json()
  await page.waitForURL(new RegExp(`/works/${work.id}$`))
  expect(work.title).toBe('')
  await expect(page.getByText('未命名作品', { exact: false }).first()).toBeVisible()
})
