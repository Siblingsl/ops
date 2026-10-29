import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('Web 素材空态保留长文提炼入口', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByText('素材库还是空的', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '相似素材', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '从长文提炼', exact: true })).toHaveCount(2)
})
