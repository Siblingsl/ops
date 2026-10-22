import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('NW-D3/D4 空白作品检查项可回到正文，检查页有返回创作', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '' })
  await page.goto(`/works/${work.id}/check`)
  await page.getByRole('button', { name: '开始检查', exact: true }).click()
  const emptyItem = page.getByRole('button', { name: /还没有正文，先确认大纲并起草/ })
  await expect(emptyItem).toBeVisible()
  await page.getByRole('link', { name: '去写正文', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}(#step-sections)?$`))

  await page.goto(`/works/${work.id}/check`)
  await page.getByRole('link', { name: '返回创作', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
})
