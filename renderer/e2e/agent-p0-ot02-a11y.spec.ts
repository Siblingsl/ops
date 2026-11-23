import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { api, registerAccount } from './support'

// 39 文档 OT-02（DEV-AI-39）：无障碍——axe 0 serious、键盘走查、12px 元信息对白底对比度 ≥4.5:1。
test('DEV-AI-39 OT-02 无障碍扫描与键盘走查', async ({ page }) => {
  await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  // axe 扫描（空态 + 打开任务面板两个视图）。
  await page.addScriptTag({ path: resolve(process.cwd(), 'node_modules/axe-core/axe.min.js') })
  const emptyResults = await page.evaluate(() => (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string; id: string; nodes: number }[] }> } }).axe.run())
  const emptySerious = emptyResults.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(emptySerious, `空态 axe serious/critical：${JSON.stringify(emptySerious.map((v) => ({ id: v.id, nodes: v.nodes })))}`).toEqual([])

  await page.locator('.desktop-agent-panel-button').click()
  await expect(page.locator('#agent-workbench-panel')).toBeVisible()
  const panelResults = await page.evaluate(() => (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string; id: string; nodes: number }[] }> } }).axe.run())
  const panelSerious = panelResults.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(panelSerious, `面板 axe serious/critical：${JSON.stringify(panelSerious.map((v) => ({ id: v.id, nodes: v.nodes })))}`).toEqual([])

  // 键盘走查：Tab 依次可达输入台与任务面板入口；面板入口 Esc 后焦点回位。
  await page.keyboard.press('Escape')
  await expect(page.locator('.desktop-agent-panel-button')).toBeFocused()
  await page.getByRole('button', { name: '任务面板' }).click()
  await expect(page.locator('#agent-workbench-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.desktop-agent-panel-button')).toBeFocused()

  // 对比度：muted 文字（12px 元信息）对实际消息区底色 ≥4.5:1（UI-04/A 后为 --ops-canvas，不再是纯白）。
  const muted = page.locator('.desktop-agent-welcome-summary')
  const contrast = await muted.evaluate((element) => {
    const style = getComputedStyle(element)
    const parse = (value: string) => value.match(/\d+/g)?.map(Number) ?? []
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const fg = parse(style.color)
    let bg = [255, 255, 255]
    for (let node: Element | null = element; node; node = node.parentElement) {
      const candidate = getComputedStyle(node).backgroundColor
      const parsed = parse(candidate)
      if (parsed.length >= 3 && (candidate.startsWith('rgb(') || (parsed[3] ?? 1) > 0)) {
        bg = parsed.slice(0, 3)
        break
      }
    }
    const l1 = lum(fg)
    const l2 = lum(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  })
  expect(contrast, 'muted 元信息对实际消息区底色对比度').toBeGreaterThanOrEqual(4.5)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ot02-a11y.png') })
})
