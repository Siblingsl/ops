import { test, expect } from '@playwright/test'
import { createOutline, registerAccount } from './support'

/**
 * @tiptap 2 → 3 升级验收：气泡菜单（BubbleMenu）。
 *
 * 这是本次升级唯一「静默失效」风险最高的地方：v3 把 BubbleMenu 从
 * `@tiptap/react` 移到 `@tiptap/react/menus`，定位实现也从 tippy.js 换成
 * Floating UI，`tippyOptions` 改名为 `options`。三者任一没改对，
 * 表现都是「选中文字后什么都不出现」，且 typecheck 未必报错（导出与 props 都可能仍在）。
 */

test('TIPTAP3 选中文本后气泡菜单出现并定位在选区上方', async ({ page }) => {
  // 小红书形态走 PlainEditor，不挂气泡菜单；公众号形态才走 RichEditor。
  // 注意公众号的类型清单里没有「图文笔记」（那是小红书专有），必须是「长图文」。
  await registerAccount(page, '长图文', 'wechat_mp')
  await createOutline(page)

  const editor = page.locator('.prose-editor').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.type('这是用于验证气泡菜单定位的一段测试正文。')

  // ProseMirror 的 selectAll 会产生一次事务，shouldShow 里的 from !== to 随之成立。
  await page.keyboard.press('Control+A')

  const menu = page.getByTestId('editor-bubble-menu')
  const rewrite = menu.getByRole('button', { name: '改写选中部分', exact: true })
  await expect(rewrite, '气泡菜单未出现：BubbleMenu 的导入路径或 options 可能没改对').toBeVisible({ timeout: 10_000 })

  // 菜单内容完整，说明渲染的是同一个 bubble 节点，而不是别的残留浮层。
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

  // 取消选区后应收起，避免浮层挡住正文。
  await page.keyboard.press('ArrowRight')
  await expect(rewrite, '取消选区后气泡菜单未收起').toBeHidden({ timeout: 10_000 })
})
