import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT65 选题方向框组字时回车不生成，选词后再次回车才生成', async ({ page }) => {
  const account = await registerAccount(page)
  let requests = 0
  await page.route(`**/api/v1/accounts/${account.id}/topics/suggest`, async route => {
    requests++
    await route.fulfill({ json: { suggestions: [], refs: { slots: [] }, ai_call_id: null } })
  })
  await page.goto(`/a/${account.id}/topics`)
  await page.getByRole('button', { name: 'AI 选题建议' }).first().click()
  const input = page.getByPlaceholder('方向关键词（可选），例如：时间管理')
  await input.fill('时间管理')
  await input.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
    Object.defineProperty(event, 'keyCode', { value: 229 })
    element.dispatchEvent(event)
  })
  expect(requests).toBe(0)

  await input.press('Enter')
  await expect.poll(() => requests).toBe(1)
})
