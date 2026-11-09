import { test, expect } from '@playwright/test'
import { createOutline, registerAccount } from './support'

/**
 * @tiptap 2 → 3 升级验收：气泡菜单（桌面渲染进程侧，对应 web/e2e/sec-tiptap3-bubble-menu.spec.ts）。
 *
 * v3 把 BubbleMenu 从 `@tiptap/react` 挪到 `@tiptap/react/menus`，定位从 tippy.js
 * 换成 Floating UI，`tippyOptions` 改名 `options`。任一处没改对，表现都是
 * 「选中文字后什么都不出现」，而且未必被 typecheck 拦住，所以两端各守一遍。
 */

test('TIPTAP3 桌面选中文本后气泡菜单出现并定位在选区上方', async ({ page }) => {
  // 小红书形态走 PlainEditor，不挂气泡菜单；公众号形态才走 RichEditor。
  // 公众号类型清单里没有「图文笔记」（小红书专有），必须用「长图文」。
  await registerAccount(page, '长图文', 'wechat_mp')
  await createOutline(page)

  const editor = page.locator('.prose-editor').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.type('这是用于验证桌面气泡菜单定位的一段测试正文。')

  // ProseMirror 的 selectAll 会提交一次事务，shouldShow 里的 from !== to 随之成立。
  await page.keyboard.press('Control+A')

  const menu = page.getByTestId('editor-bubble-menu')
  const rewrite = menu.getByRole('button', { name: '改写选中部分', exact: true })
  await expect(rewrite, '气泡菜单未出现：BubbleMenu 的导入路径或 options 可能没改对').toBeVisible({ timeout: 10_000 })

  for (const label of ['改写选中部分', '提炼金句', '批注', '存入素材库']) {
    await expect(menu.getByRole('button', { name: label, exact: true }), `气泡菜单缺少「${label}」`).toBeVisible()
  }

  // Floating UI 的 placement: 'top' 应把菜单放在选区上方且完整留在视口内。
  const box = await rewrite.boundingBox()
  expect(box, '气泡菜单没有可测量的位置').not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.y, '气泡菜单被定位到视口上方之外').toBeGreaterThan(0)
  expect(box!.y + box!.height, '气泡菜单超出视口下边界').toBeLessThanOrEqual(viewport.height)
  expect(box!.width, '气泡菜单宽度塌陷').toBeGreaterThan(120)

  await page.keyboard.press('ArrowRight')
  await expect(rewrite, '取消选区后气泡菜单未收起').toBeHidden({ timeout: 10_000 })
})
