import { expect, test } from '@playwright/test'
import { createOutline, registerAccount } from './support'

test('OPT48 标题拒绝原因反馈附带本次候选原文', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  await page.getByRole('button', { name: '候选', exact: true }).click()
  await expect(page.getByText('标题工作台')).toBeVisible()
  await page.locator('#step-title').getByRole('button', { name: '不满意' }).click()
  const feedback = page.waitForRequest(request => request.method() === 'POST' && /\/ai-calls\/[^/]+\/feedback$/.test(new URL(request.url()).pathname) && request.postData()?.includes('太夸张'))
  await page.getByRole('button', { name: '太夸张', exact: true }).click()
  const body = (await feedback).postDataJSON()
  const titlePanel = await page.locator('#step-title').innerText()
  expect(body.reason_tags).toEqual(['太夸张'])
  expect(body.sample_text).toBeTruthy()
  expect(body.sample_text.split('\n').some(text => text && titlePanel.includes(text))).toBeTruthy()
  await expect(page).toHaveURL(new RegExp(`/works/${id}$`))
})
