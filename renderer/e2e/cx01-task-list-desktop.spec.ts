import { expect, test } from '@playwright/test'

test('桌面公众号渲染将 Markdown 任务列表转换为不可交互标记', async ({ page }) => {
  await page.goto('/login')
  const html = await page.evaluate(async () => {
    const load = new Function('return import("/lib/render.ts")')
    const { renderWechat } = await load()
    return renderWechat([{ heading: '', content_md: '- [ ] 待办\n- [x] 已办\n  - [ ] 子任务\n\n普通 <input type="checkbox" checked disabled> 内容' }], 'ink')
  })
  await page.setContent(html)
  await expect(page.locator('li').nth(0)).toContainText('☐ 待办')
  await expect(page.locator('li').nth(1)).toContainText('☑ 已办')
  await expect(page.locator('li').nth(2)).toContainText('☐ 子任务')
  await expect(page.locator('input')).toHaveCount(0)
  await expect(page.locator('p').last()).not.toContainText('☑')
  const loose = await page.evaluate(async () => {
    const load = new Function('return import("/lib/render.ts")')
    const { renderWechat } = await load()
    return renderWechat([{ heading: '', content_md: '- [ ] 第一项\n\n- [x] 第二项\n\n`- [x] 代码示例`' }], 'ink')
  })
  await page.setContent(loose)
  await expect(page.locator('li').nth(0)).toContainText('☐ 第一项')
  await expect(page.locator('li').nth(1)).toContainText('☑ 第二项')
  await expect(page.locator('code')).toHaveText('- [x] 代码示例')
})
