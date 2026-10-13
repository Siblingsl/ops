import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT53 漫画派生后和对照页入口都打开漫画编辑器', async ({ page }) => {
  const sourceAccount = await registerAccount(page, '漫画', 'wechat_mp')
  const targetAccount = await api(page, 'POST', '/accounts', {
    platform: 'xhs', name: 'OPT53 目标漫画账号', content_format: 'comic',
  })
  const source = await api(page, 'POST', `/accounts/${sourceAccount.id}/works`, { title: 'OPT53 源漫画' })
  await api(page, 'PATCH', `/works/${source.id}`, { viewpoint: '一个明确的漫画观点。' })
  const storyboard = await api(page, 'POST', `/works/${source.id}/storyboard/generate`, { panel_count: 3, character_ids: [] })
  await api(page, 'PUT', `/works/${source.id}/storyboard`, { panels: storyboard.panels, confirm: true })

  await page.goto(`/works/${source.id}`)
  await page.getByRole('button', { name: '派生', exact: true }).click()
  await page.getByRole('button', { name: /OPT53 目标漫画账号/ }).click()
  const deriving = page.waitForResponse(response => response.url().endsWith(`/api/v1/works/${source.id}/derive`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '开始派生', exact: true }).click()
  const derived = await (await deriving).json()
  await expect(page).toHaveURL(new RegExp(`/works/${derived.id}$`))
  await expect(page.getByRole('heading', { name: '分镜脚本', exact: true })).toBeVisible()

  await page.goto(`/works/${derived.id}/compare`)
  await page.getByRole('button', { name: '打开漫画编辑器', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${derived.id}$`))
  await expect(page.getByRole('heading', { name: '分镜脚本', exact: true })).toBeVisible()
})
