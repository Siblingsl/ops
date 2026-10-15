import { expect, test } from '@playwright/test'
import { createOutline, registerAccount } from './support'

test('OPT74 小红书正文连续输入时页面滚动位置保持稳定', async ({ page }) => {
  await registerAccount(page)
  await createOutline(page)
  const editor = page.locator('[id^="sec-"] textarea').first()
  await editor.scrollIntoViewIfNeeded()
  const top = await editor.evaluate(el => el.getBoundingClientRect().top)
  await page.evaluate(y => window.scrollTo({ top: window.scrollY + y - 180, behavior: 'instant' }), top)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.evaluate(() => {
    ;(window as any).__opt74ScrollPositions = [window.scrollY]
    window.addEventListener('scroll', () => (window as any).__opt74ScrollPositions.push(window.scrollY))
  })

  const content = 'continuous scroll stability '.repeat(20)
  await expect(editor).toBeEditable()
  await editor.focus()
  await expect(editor).toBeFocused()
  await page.keyboard.type(content, { delay: 1 })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  const positions = await page.evaluate(() => (window as any).__opt74ScrollPositions as number[])
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1)
  await expect(editor).toHaveValue(content)
})
