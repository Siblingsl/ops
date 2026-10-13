import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT59 发布包失败有人工重试，确认门槛拒绝可去检查，分页 AI 失败可去模型配置', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '发布包失败入口' })
  // 模拟页面缓存仍为 ready，服务器保持未检查，用于验证过期状态拒绝后的修复入口。
  await page.route(`**/api/v1/works/${work.id}`, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { ...work, status: 'ready' } }) : route.continue())
  let attempts = 0
  await page.route(`**/api/v1/works/${work.id}/xhs/pack`, route => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts++
    return attempts === 1 ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: '发布包生成暂时失败' } } }) : route.continue()
  })
  await page.goto(`/works/${work.id}/pack`)
  await page.getByRole('button', { name: '生成发布包', exact: true }).click()
  await expect(page.getByText('发布包生成暂时失败', { exact: true })).toBeVisible()
  expect(attempts).toBe(1)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  const gate = page.locator('[data-sonner-toast]').filter({ hasText: '发布前检查还没有全部确认，不能生成发布包' })
  await expect(gate).toBeVisible()
  expect(attempts).toBe(2)
  expect((await api(page, 'GET', `/works/${work.id}`)).status).toBe('drafting')
  await gate.getByRole('button', { name: '去检查', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}/check$`))
  await page.route(`**/api/v1/works/${work.id}/xhs/pages`, route => route.fulfill({ status: 502, json: { error: { code: 'ai_key_invalid', message: '模拟模型配置需修复' } } }))
  await page.goto(`/works/${work.id}/pack`)
  await page.getByRole('button', { name: '分页文案建议', exact: true }).click()
  await expect(page.getByText('分页文案建议失败', { exact: true })).toBeVisible()
  const aiFailure = page.locator('[data-sonner-toast]').filter({ hasText: '分页文案建议失败' })
  await expect(aiFailure.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await aiFailure.getByRole('button', { name: '换备用模型', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/models$/)
})
