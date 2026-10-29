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

test('D-123-UI-1 账号类型入口与修改弹窗：多视口无错位', async ({ page }) => {
  const account = await registerAccount(page)
  // 先建两篇作品：影响清单里的「已有 N 篇作品保持原类型」在 N>0 时才是最长的真实文案形态
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: '入口与弹窗验收·第一篇' })
  await api(page, 'POST', `/accounts/${account.id}/works`, { title: '入口与弹窗验收·第二篇' })
  await page.goto('/settings/accounts')
  const entry = page.locator(TYPE_ENTRY)

  // D-123 a11y：入口按钮不得被 <label> 包裹，否则可访问名会被整个字段文案覆盖（读屏读成
  // 「账号类型 图文笔记 同平台内可以更换类型…」），且点击字段任意文字都会误触发弹窗。
  await expect(page.getByRole('button', { name: '修改类型', exact: true }), '「修改类型」按钮的可访问名被字段文案覆盖').toBeVisible()
  await expect(entry).not.toHaveCount(0)
  const fieldWrappedByLabel = await entry.evaluate((el) => Boolean(el.closest('label')))
  expect(fieldWrappedByLabel, '「修改类型」按钮仍被 <label> 包裹').toBe(false)

  for (const vp of [
    { width: 1440, height: 1000, tag: '1440' },
    { width: 1024, height: 900, tag: '1024' },
    { width: 768, height: 900, tag: '768' },
    { width: 390, height: 844, tag: '390' },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await expect(entry).toBeVisible()

    const row = entry.locator('xpath=..')
    const field = entry.locator('xpath=ancestor::div[contains(@class,"block")][1]')
    // 响应式换行时在同一次布局读取中取样，避免把 resize 前后的两个矩形拼成重叠。
    const { rowBox, badgeBox, btnBox, fieldBox } = await entry.evaluate((button) => {
      const row = button.parentElement!
      const badge = row.querySelector(':scope > span')!
      const field = button.closest('div.block')!
      return {
        rowBox: row.getBoundingClientRect().toJSON(), badgeBox: badge.getBoundingClientRect().toJSON(),
        btnBox: button.getBoundingClientRect().toJSON(), fieldBox: field.getBoundingClientRect().toJSON(),
      }
    })

    expect(rowBox.height, `[${vp.tag}] 入口行高异常`).toBeGreaterThanOrEqual(30)
    expect(badgeBox.x, `[${vp.tag}] 类型徽标越出容器左缘`).toBeGreaterThanOrEqual(rowBox.x - 0.5)
    expect(btnBox.x + btnBox.width, `[${vp.tag}] 修改按钮越出容器右缘`).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5)
    expect(btnBox.y + btnBox.height, `[${vp.tag}] 修改按钮纵向越出`).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5)
    expect(badgeBox.y + badgeBox.height, `[${vp.tag}] 类型徽标纵向越出`).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5)
    expect(overlapArea(badgeBox, btnBox), `[${vp.tag}] 徽标与按钮重叠`).toBe(0)
    // 入口行自身不得横向溢出：字段列极窄时（1024 视口列宽约 157px）徽标＋按钮合计 162px，
    // 两者都 nowrap 且 min-width:auto 不可收缩，曾把行撑破 5px。
    const rowMetrics = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(rowMetrics.sw, `[${vp.tag}] 入口行横向溢出（${rowMetrics.sw} > ${rowMetrics.cw}）`).toBeLessThanOrEqual(rowMetrics.cw + 1)
    if (Math.abs(centerY(badgeBox) - centerY(btnBox)) <= 1.5) {
      expect(btnBox.x - (badgeBox.x + badgeBox.width), `[${vp.tag}] 徽标与按钮间距异常`).toBeGreaterThanOrEqual(4)
      expect(rowBox.height, `[${vp.tag}] 同行时入口行高异常`).toBeLessThanOrEqual(40)
    } else {
      // 极窄列下允许整齐换行到第二行，但不得半重叠、且必须与徽标左对齐
      expect(btnBox.y, `[${vp.tag}] 换行后按钮与徽标纵向重叠`).toBeGreaterThanOrEqual(badgeBox.y + badgeBox.height - 0.5)
      expect(Math.abs(btnBox.x - badgeBox.x), `[${vp.tag}] 换行后按钮未与徽标左对齐`).toBeLessThanOrEqual(0.5)
    }
    expect(fieldBox.width, `[${vp.tag}] 字段宽度塌陷`).toBeGreaterThan(120)
    expect(await clippedText(field), `[${vp.tag}] 入口所在字段内文本溢出`).toEqual([])

    // 受控对照：本字段不产生横向溢出（页面级横向滚动若存在，来自外壳顶栏）
    const of = await overflowContribution(page, field)
    expect(of.withEl, `[${vp.tag}] 账号类型字段引入横向溢出（${of.withoutEl} → ${of.withEl}）`).toBe(of.withoutEl)

    await entry.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/web-01-accounts-${vp.tag}.png` })

    // —— 修改类型弹窗 ——
    await entry.click()
    const panel = page.locator('.dialog-panel')
    await expect(panel).toBeVisible()
    await page.waitForTimeout(120)
    const panelBox = (await panel.boundingBox())!
    expect(panelBox.x, `[${vp.tag}] 弹窗越出视口左缘`).toBeGreaterThanOrEqual(-0.5)
    expect(panelBox.x + panelBox.width, `[${vp.tag}] 弹窗越出视口右缘`).toBeLessThanOrEqual(vp.width + 0.5)
    expect(await clippedText(panel), `[${vp.tag}] 弹窗内文本溢出`).toEqual([])

    // 单选卡片
    const labels = panel.locator('fieldset label')
    const count = await labels.count()
    expect(count, `[${vp.tag}] 图文笔记账号的可选类型数量`).toBe(4)
    for (let i = 0; i < count; i += 1) {
      const label = labels.nth(i)
      const lBox = (await label.boundingBox())!
      const rBox = (await label.locator('input[type="radio"]').boundingBox())!
      const sBox = (await label.locator('span').first().boundingBox())!
      expect(overlapArea(rBox, sBox), `[${vp.tag}] 选项#${i} 圆点与文字重叠`).toBe(0)
      expect(rBox.x, `[${vp.tag}] 选项#${i} 圆点越出卡片左缘`).toBeGreaterThanOrEqual(lBox.x - 0.5)
      expect(rBox.y + rBox.height, `[${vp.tag}] 选项#${i} 圆点越出卡片下缘`).toBeLessThanOrEqual(lBox.y + lBox.height + 0.5)
      expect(sBox.x + sBox.width, `[${vp.tag}] 选项#${i} 文字越出卡片右缘`).toBeLessThanOrEqual(lBox.x + lBox.width - 1)
      expect(sBox.x - (rBox.x + rBox.width), `[${vp.tag}] 选项#${i} 圆点与文字间距异常`).toBeGreaterThanOrEqual(3)
      expect(lBox.height, `[${vp.tag}] 选项#${i} 卡片高度异常`).toBeLessThanOrEqual(92)
    }
    // 漫画选项的补充说明（与名称同行内联，换行后须按行比对，否则并集矩形会误报重叠）
    const comic = labels.last().locator('span span')
    const nameRects = await lineRects(comic.nth(0))
    const descRects = await lineRects(comic.nth(1))
    const cross = nameRects.flatMap((a) => descRects.map((b) => overlapArea(a, b)))
    expect(Math.max(...cross), `[${vp.tag}] 漫画说明与名称重叠`).toBe(0)
    expect(nameRects.length, `[${vp.tag}] 漫画选项名称行数异常`).toBe(1)

    // 影响清单
    const impactList = panel.locator('ul.list-disc')
    await expect(impactList).toBeVisible()
    await expect(impactList.getByText(/已有 2 篇作品保持原类型/), `[${vp.tag}] 影响清单未渲染作品数`).toBeVisible()
    const listBox = (await impactList.boundingBox())!
    const wrapBox = (await impactList.locator('xpath=..').boundingBox())!
    expect(listBox.x, `[${vp.tag}] 影响清单越出容器左缘`).toBeGreaterThanOrEqual(wrapBox.x - 0.5)
    expect(listBox.x + listBox.width, `[${vp.tag}] 影响清单越出容器右缘`).toBeLessThanOrEqual(wrapBox.x + wrapBox.width + 0.5)

    // 交互态：切到「漫画」——第三句换成更短的形态，且卡片几何不得跳动
    const comicLabel = labels.last()
    const comicBefore = (await comicLabel.boundingBox())!
    await comicLabel.click()
    await expect(comicLabel.locator('input[type="radio"]')).toBeChecked()
    await expect(impactList.getByText('转为漫画后角色卡立刻可用。'), `[${vp.tag}] 漫画影响文案未切换`).toBeVisible()
    await expect(impactList.locator('li'), `[${vp.tag}] 影响清单条目数异常`).toHaveCount(3)
    const comicAfter = (await comicLabel.boundingBox())!
    expect(Math.abs(comicAfter.height - comicBefore.height), `[${vp.tag}] 选中漫画后卡片高度跳动`).toBeLessThanOrEqual(1)
    expect((await comicLabel.boundingBox())!.height, `[${vp.tag}] 选中漫画后卡片高度异常`).toBeLessThanOrEqual(92)
    expect(await clippedText(panel), `[${vp.tag}] 选中漫画后弹窗内文本溢出`).toEqual([])
    await panel.locator('fieldset label').first().click()
    await expect(panel.locator('fieldset label').first().locator('input[type="radio"]')).toBeChecked()

    // 底部按钮
    const footer = panel.locator('> div').last()
    const confirmBtn = panel.getByRole('button', { name: '确认修改' })
    const cancelBtn = panel.getByRole('button', { name: '取消' })
    const fBox = (await footer.boundingBox())!
    const cfBox = (await confirmBtn.boundingBox())!
    const cnBox = (await cancelBtn.boundingBox())!
    expect(overlapArea(cfBox, cnBox), `[${vp.tag}] 底部按钮重叠`).toBe(0)
    expect(Math.abs(centerY(cfBox) - centerY(cnBox)), `[${vp.tag}] 底部按钮未同行`).toBeLessThanOrEqual(1)
    const rightInset = fBox.x + fBox.width - (cfBox.x + cfBox.width)
    expect(rightInset, `[${vp.tag}] 确认按钮未右对齐（inset=${rightInset}）`).toBeGreaterThanOrEqual(20)
    expect(rightInset, `[${vp.tag}] 确认按钮距右缘过远（inset=${rightInset}）`).toBeLessThanOrEqual(28)
    expect(cfBox.y + cfBox.height, `[${vp.tag}] 底部按钮越出弹窗下缘`).toBeLessThanOrEqual(fBox.y + fBox.height + 0.5)
    expect(fBox.y, `[${vp.tag}] 底部按钮区越出弹窗`).toBeGreaterThanOrEqual(panelBox.y)
    expect(await clippedText(footer), `[${vp.tag}] 底部按钮文字溢出`).toEqual([])

    await page.screenshot({ path: `${SHOTS}/web-02-dialog-${vp.tag}.png` })
    await cancelBtn.click()
    await expect(panel).toBeHidden()
  }

  // —— 提交路径：类型改完徽标文案会变长（清单合集笔记 6 字 > 图文笔记 4 字），入口行几何仍需成立 ——
  await page.setViewportSize({ width: 1024, height: 900 })
  await entry.click()
  const panel = page.locator('.dialog-panel')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '确认修改' }).click()
  await expect(panel).toBeHidden()
  await expect(page.getByText(/账号类型已改为/), '提交后缺少成功反馈').toBeVisible()
  await expect(page.locator(TYPE_ENTRY).locator('xpath=../span').first(), '提交后徽标未更新').toHaveText('清单合集笔记')
  await page.waitForTimeout(400) // 等页面淡入与重排稳定，避免截到动画中间帧
  await page.screenshot({ path: `${SHOTS}/web-05-accounts-after-submit-1024.png` })
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const row = page.locator(TYPE_ENTRY).locator('xpath=..')
    const m = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: Math.round(el.getBoundingClientRect().height) }))
    expect(m.sw, `[提交后 ${width}] 入口行横向溢出（${m.sw} > ${m.cw}）`).toBeLessThanOrEqual(m.cw + 1)
    expect(m.h, `[提交后 ${width}] 入口行高异常（${m.h}）`).toBeLessThanOrEqual(80)
  }
})

test('D-123-UI-2 看板混合类型标注（Web 形态）：多视口无错位', async ({ page }) => {
  const account = await seedMixedFormats(page)
  const dash = await api(page, 'GET', `/accounts/${account.id}/dashboard`)
  const formats = [...new Set((dash.todos as { content_format?: string }[]).map((t) => t.content_format).filter(Boolean))]
  expect(formats.sort(), 'dashboard todos 未返回两种内容类型').toEqual(['card_post', 'image_note'])

  for (const vp of [
    { width: 1440, height: 1000, tag: '1440' },
    { width: 1024, height: 900, tag: '1024' },
    { width: 768, height: 900, tag: '768' },
    { width: 390, height: 844, tag: '390' },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.goto(`/a/${account.id}`)
    await expect(page.getByText('全部作品待办').first()).toBeVisible()
    await assertChipsClean(page, `web-${vp.tag}`)
    // 视觉复核用：先滚到标注所在卡片，再整页 + 卡片级各截一张
    const chipCard = page.locator(CHIP).first().locator('xpath=ancestor::li[1]')
    await chipCard.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${SHOTS}/web-03-dashboard-${vp.tag}.png` })
    await chipCard.screenshot({ path: `${SHOTS}/web-03-row-${vp.tag}.png` })
  }
})


