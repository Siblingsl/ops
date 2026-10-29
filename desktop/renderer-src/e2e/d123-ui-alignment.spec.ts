import { test, expect, type Locator, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// D-123 / DEV-415：账号类型迁移新增 UI 的逐项错位检查（真实渲染 + 编程式几何校验）。
// 产出截图位于 ../.workbuddy-ai/ui-check/，供人工视觉复核。
//
// 关于「页面横向滚动」：窄视口下应用外壳顶栏（Shell.tsx .desktop-toolbar-actions，shrink-0）
// 本身就会撑出横向滚动，且与 D-123 无关（见 .workbuddy-ai/ui-check/diag.log：含/不含 D-123
// 元素时 documentElement.scrollWidth 完全相同，不含 D-123 的 /settings/usage 也溢出）。
// 因此这里不用「页面绝对无横向滚动」这种会把既有问题算到本次改动头上的断言，而是用
// 受控对照：隐藏本次新增元素前后 scrollWidth 必须完全一致 —— 即本次改动的横向溢出贡献为 0。

test.use({ reducedMotion: 'reduce' })

const SHOTS = '../.workbuddy-ai/ui-check'

interface Box { x: number; y: number; width: number; height: number }

const centerY = (b: Box) => b.y + b.height / 2
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** 检出“真溢出”元素：横向可溢出（overflow-x: visible）且未使用省略号截断。 */
async function clippedText(root: Locator) {
  return root.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('*'))
      .filter((node) => {
        const style = getComputedStyle(node)
        if (style.overflowX !== 'visible') return false
        if (style.textOverflow === 'ellipsis') return false
        return node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 2
      })
      .map((node) => `${node.tagName}.${typeof node.className === 'string' ? node.className : ''}`),
  )
}

/** 逐行文本矩形：行内元素换行后 boundingBox 是并集矩形，会误报重叠，必须按行取。 */
async function lineRects(locator: Locator) {
  return locator.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return Array.from(range.getClientRects()).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
  })
}

/** 受控对照：隐藏该元素前后，页面 scrollWidth 是否变化（本次改动的横向溢出贡献）。 */
async function overflowContribution(page: Page, locator: Locator) {
  await locator.first().evaluate((el) => { (el as HTMLElement).dataset.d123Diag = '1' })
  return page.evaluate(() => {
    const doc = document.documentElement
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-d123-diag]'))
    const withEl = doc.scrollWidth
    els.forEach((el) => { el.style.display = 'none' })
    const withoutEl = doc.scrollWidth
    els.forEach((el) => { el.style.removeProperty('display'); delete el.dataset.d123Diag })
    return { clientWidth: doc.clientWidth, withEl, withoutEl }
  })
}

/** 与 chip 同一行内是否存在重叠的兄弟元素/文本片段。 */
async function chipSiblingOverlaps(page: Page, chipSelector: string) {
  return page.locator(chipSelector).evaluateAll((chips) =>
    chips.map((chip) => {
      const el = chip as HTMLElement
      const meta = el.parentElement!
      const c = el.getBoundingClientRect()
      const rects: { label: string; x: number; y: number; width: number; height: number }[] = []
      for (const node of Array.from(meta.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const r of Array.from(range.getClientRects())) {
            rects.push({ label: `text:${(node.textContent ?? '').trim().slice(0, 12)}`, x: r.x, y: r.y, width: r.width, height: r.height })
          }
        } else if (node instanceof HTMLElement && node !== el && !node.contains(el)) {
          rects.push({ label: node.tagName, x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })
        }
      }
      const hit = (a: typeof c, b: (typeof rects)[number]) =>
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
      return rects.filter((r) => hit(c, r) > 0.5).map((r) => r.label)
    }),
  )
}

const CHIP = 'span.rounded.bg-mist-100.px-1.py-px'
/** 「修改类型」入口：D-123 的 a11y 修复后已移出 <label>（Field plain），可访问名就是按钮文本本身。 */
const TYPE_ENTRY = 'button:has-text("修改类型")'

async function assertChipsClean(page: Page, tag: string, expected = 2) {
  const chips = page.locator(CHIP)
  await expect(chips).toHaveCount(expected)
  const texts = (await chips.allTextContents()).join('/')
  expect(texts, `[${tag}] chip 文案缺失`).toContain('图文笔记')
  expect(texts, `[${tag}] chip 文案缺失`).toContain('图文卡片')

  const of = await overflowContribution(page, chips.first())
  expect(of.withEl, `[${tag}] D-123 标注引入了横向溢出（无标注 ${of.withoutEl} → 有标注 ${of.withEl}）`).toBe(of.withoutEl)

  const overlaps = await chipSiblingOverlaps(page, CHIP)
  expect(overlaps, `[${tag}] chip 与同行元素重叠`).toEqual(Array(expected).fill([]))

  for (let i = 0; i < expected; i += 1) {
    const chip = chips.nth(i)
    const chipBox = (await chip.boundingBox())!
    const liBox = (await chip.locator('xpath=ancestor::li[1]').boundingBox())!
    const cardBox = (await chip.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]').boundingBox())!
    expect(chipBox.height, `[${tag}] chip#${i} 发生换行（height=${chipBox.height}）`).toBeLessThanOrEqual(21)
    expect(chipBox.width, `[${tag}] chip#${i} 被压扁`).toBeGreaterThanOrEqual(40)
    expect(chipBox.x, `[${tag}] chip#${i} 越出列表项左缘`).toBeGreaterThanOrEqual(liBox.x - 0.5)
    expect(chipBox.x + chipBox.width, `[${tag}] chip#${i} 越出卡片右缘`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5)

    const meta = chip.locator('xpath=..')
    const metaBox = await meta.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
    expect(metaBox.scrollWidth, `[${tag}] chip#${i} 所在行横向溢出`).toBeLessThanOrEqual(metaBox.clientWidth + 2)
  }
}

async function seedMixedFormats(page: Page) {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: '混合类型验收·第一篇（图文笔记）' })
  await api(page, 'PATCH', `/accounts/${account.id}`, { content_format: 'card_post', confirm_type_change: true })
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: '混合类型验收·第二篇（图文卡片）' })
  return account
}

test('D-123-UI-3 看板混合类型标注（客户端工作台形态）', async ({ page }) => {
  const account = await seedMixedFormats(page)
  await page.addInitScript(() => {
    const ua = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${ua} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}`)
  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

  // 只看直接子级 summary：desktop-home-extras 内还嵌着 desktop-first-value-disclosure 的 summary
  const extras = page.getByTestId('desktop-home-extras')
  await extras.locator('> summary').click()
  await expect(extras).toHaveAttribute('open', '')
  const chips = page.locator(CHIP)
  await expect(chips).toHaveCount(2)
  await chips.first().scrollIntoViewIfNeeded()
  await assertChipsClean(page, 'desktop-1440')
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${SHOTS}/web-04-dashboard-desktop.png` })
  await chips.first().locator('xpath=ancestor::li[1]').screenshot({ path: `${SHOTS}/web-04-row-desktop.png` })
})

