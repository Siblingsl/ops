import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('NW-D1 打开检查页不自动开始，显式点击才创建检查', async ({ page }) => {
  await registerAccount(page)
  const id = await createOutline(page)
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/works/${id}/checks`)) posts++
  })
  await page.goto(`/works/${id}/check`)
  await expect(page.getByRole('heading', { name: '发布前检查', exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  expect(posts, '打开检查页不应自动发起检查').toBe(0)
  expect((await api(page, 'GET', `/works/${id}/checks/latest`)).run).toBeNull()

  await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(() => posts).toBe(1)
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}/checks/latest`)).run?.fact_status, { timeout: 30_000 }).not.toBe('pending')
})

test('NW-C2 没有观点时确认大纲不可点', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '没有观点的作品' })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '添加一项', exact: true }).click()
  await page.getByPlaceholder('段落小标题').fill('第一段')
  await expect(page.getByRole('button', { name: '确认大纲', exact: true })).toBeDisabled()
  await expect(page.getByText('先写下你的核心观点，才能生成或确认大纲。')).toBeVisible()

  // 写下观点（失焦即保存）后，确认大纲才可用。
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await viewpoint.fill('先有观点，再谈结构。')
  await viewpoint.blur()
  await expect(page.getByRole('button', { name: '确认大纲', exact: true })).toBeEnabled()
})
