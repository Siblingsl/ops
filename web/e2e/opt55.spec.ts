import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT55 公众号编辑器直达检查，长文仍拦截且检查和推送可选看排版', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/sections/${work.sections[0].id}`, {
    content_md: '正文内容'.repeat(5_250), base_revision: work.sections[0].revision,
  })
  await page.goto(`/works/${id}`)
  const checks = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/works/${id}/checks`))
  await page.getByRole('button', { name: '排版并检查', exact: true }).click()
  await expect.poll(async () => new URL(page.url()).pathname).toBe(`/works/${id}/check`)
  await checks
  await expect(page.getByRole('heading', { name: '发布前检查', exact: true })).toBeVisible()
  const latest = await api(page, 'GET', `/works/${id}/checks/latest`)
  const html = latest.run.items.find((item: any) => item.category === 'format' && item.message.startsWith('排版后 HTML'))
  expect(html?.passed).toBe(false)
  expect(html?.detail).toContain('超出')
  await expect(page.getByRole('link', { name: '看排版', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '看排版', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${id}/preview$`))
  await page.goto(`/works/${id}/push`)
  await expect(page.getByRole('link', { name: '看排版', exact: true })).toBeVisible()
  expect(account.id).toBeTruthy()
})
