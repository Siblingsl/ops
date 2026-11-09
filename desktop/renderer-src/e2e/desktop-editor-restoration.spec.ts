import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { alignPrototypeToDesktopShell, api, createOutline, registerAccount } from './support'

async function enableElectronPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

test('Electron 编辑器逐项复核并与原型对照', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  await enableElectronPresentation(page)
  const workId = await createOutline(page)
  let work = await api(page, 'GET', `/works/${workId}`)
  const headings = ['从忙碌中停一下', '给重要的事留白', '把选择权拿回来', '从今天的小事开始']
  const outline = work.outline.slice(0, headings.length).map((item: { heading: string; key_point: string }, index: number) => ({
    ...item, heading: headings[index], key_point: ['辨认值得投入的事', '为重要的事留出不被打断的时间', '从日程安排转回主动选择', '从一个小行动开始'][index],
  }))
  work = await api(page, 'PATCH', `/works/${workId}`, {
    title: '把时间留给真正重要的事', viewpoint: '时间管理的起点，是先确认什么对自己真正重要。', base_revision: work.revision,
  })
  await api(page, 'PUT', `/works/${workId}/outline`, { items: outline, confirm: true, base_revision: work.revision })
  work = await api(page, 'GET', `/works/${workId}`)
  for (const section of work.sections.slice(headings.length)) await api(page, 'DELETE', `/sections/${section.id}`)
  work = await api(page, 'GET', `/works/${workId}`)
  const paragraphs = [
    '我们总是习惯把日程填满，仿佛每一段空白都需要一个解释。可当一天结束，真正让人记住的，往往并不是完成了多少项待办。\n\n上周，我试着把每天最清醒的一小时留给写作。没有打开消息列表，也没有先处理那些看上去紧急的小事。变化比我预想得更简单：我开始重新拥有一段完整的思考。\n\n安排时间之前，也许可以先问自己：这件事，真的值得占据今天吗？',
    '留白并不是浪费。它是一种选择：为真正值得投入的事，预留一段不被打断的时间。',
    '当日程排得很满时，我会停下来问自己：这些安排里，哪一件是我主动选择的？',
  ]
  for (const [index, section] of work.sections.entries()) {
    if (paragraphs[index]) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: paragraphs[index], base_revision: section.revision })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/works/${workId}`)
  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-tools')).toBeVisible()
  const firstSection = page.locator('#step-sections > div[id^="sec-"]').first()
  await firstSection.locator('.desktop-section-heading > span').first().click()
  await expect(firstSection).toHaveClass(/desktop-active/)
  await expect.poll(() => firstSection.evaluate((element) => {
    const style = getComputedStyle(element)
    return `${style.borderTopWidth}|${style.borderRightWidth}|${style.borderBottomWidth}|${style.borderRadius}|${style.borderLeftColor}|${style.boxShadow}`
  })).toBe('0px|0px|0px|0px|rgb(112, 82, 186)|none')

  await firstSection.locator('.desktop-section-rewrite').click()
  await expect(firstSection.getByRole('button', { name: '放弃', exact: true })).toBeVisible()
  await firstSection.getByRole('button', { name: '放弃', exact: true }).click()
  await expect(firstSection.locator('.desktop-section-reference')).toBeVisible()
  await page.locator('.desktop-editor-content').evaluate((element) => { element.scrollTop = 0 })
  await page.locator('.desktop-workbar').evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0
    window.scrollTo(0, 0)
  })

  const screenshotDir = resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots')
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, 'editor-layout-after.png'), fullPage: false })
  const productGeometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { x, y, width, height, marginBlockStart: style.marginBlockStart, marginTop: style.marginTop, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom }
    }
    return Object.fromEntries([
      ['workbar', '.desktop-workbar'], ['layout', '.desktop-editor-layout'], ['steps', '.desktop-editor-steps'],
      ['content', '.desktop-editor-content'], ['paper', '.desktop-editor-paper'], ['tools', '.desktop-editor-tools'],
      ['title', '#step-title input'], ['titleCard', '#step-title'], ['titleInner', '#step-title > .space-y-4'], ['titleField', '#step-title .desktop-title-main'],
      ['titleDetails', '#step-title details'], ['rulePreview', '#step-title [data-testid="title-rule-preview"]'],
      ['viewpointCard', '#step-viewpoint'], ['viewpoint', '.desktop-viewpoint-line'],
      ['sectionList', '#step-sections > div[id^="sec-"]:nth-child(2)'], ['sectionGroup', '.desktop-editor-paper .group\\/sec'],
      ['sectionHeading', '.desktop-editor-paper .group\\/sec input'], ['sectionHeader', '.desktop-editor-paper .group\\/sec > div:nth-child(2)'],
      ['sectionContent', '.desktop-editor-paper .group\\/sec > div:nth-child(4)'],
      ['sectionEditor', '.desktop-editor-paper .group\\/sec .ProseMirror'],
      ['paragraph', '.ProseMirror p:first-child'], ['sectionLastParagraph', '.desktop-editor-paper .group\\/sec .ProseMirror p:last-child'],
      ['sectionActions', '.desktop-editor-paper .desktop-section-actions'], ['sectionFooter', '.desktop-editor-paper .desktop-section-footer'],
      ['sectionReference', '.desktop-editor-paper .desktop-section-reference'],
      ['sectionToolbar', '.rich-editor-toolbar'],
    ].map(([name, selector]) => [name, box(selector)]))
  })
  // 2026-11-02 布局整理：顶部工具区 129.5 → 92；同日工作区四边外边框上下各留 8px，
  // workbar 顶边 39 → 47（标题栏 38 + 上边距 8 + 描边约 1）。高度仍按绝对值钉死。
  expect(productGeometry.workbar).toMatchObject({ y: 47, height: 92 })
  expect(productGeometry.steps?.height).toBeCloseTo(productGeometry.content?.height ?? 0, 0)
  expect(productGeometry.content?.height).toBeCloseTo(productGeometry.tools?.height ?? 0, 0)

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  const prototypeFile = pathToFileURL(resolve(process.cwd(), '../../docs/design/desktop-creative/prototype/index.html')).href
  await prototype.goto(prototypeFile)
  await prototype.locator('[data-nav="editor"]').first().click()
  await expect(prototype.locator('.editor-grid')).toBeVisible()
  await prototype.waitForTimeout(300)
  await alignPrototypeToDesktopShell(prototype)
  await prototype.screenshot({ path: resolve(screenshotDir, 'editor-layout-prototype.png'), fullPage: false })
  const prototypeGeometry = await prototype.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    return Object.fromEntries([
      ['workbar', '.workbar'], ['layout', '.editor-grid'], ['steps', '.outline'],
      ['content', '.editor-scroll'], ['paper', '.paper'], ['tools', '.context-tools'],
      ['title', '.paper h1'], ['viewpoint', '.paper .intro'], ['sectionHeading', '#section-0 h2'],
      ['section', '#section-0'], ['sectionToolbar', '#section-0 .editor-format'],
      ['paragraph', '#section-0 .editable p:first-child'], ['sectionLastParagraph', '#section-0 .editable p:last-child'],
      ['sectionActions', '#section-0 .section-tools'], ['sectionReference', '#section-0 .reference-line'],
    ].map(([name, selector]) => [name, box(selector)]))
  })
  console.log('Editor geometry product/prototype:', JSON.stringify({ productGeometry, prototypeGeometry }))
  await prototype.close()

  // 原型夹具（docs/design/desktop-creative/prototype）停在 2026-10-16 的扁平纸面：
  // 文档信息 → h1 → 核心观点 → 各段落，中间没有分组标题。
  // 产品此后按登记项加了两块内容：
  //   1) 标题卡内的「本地规则预览」（docs/90:2343，桌面与 Web 各自实现）；
  //   2) 正文区的分组标题（#step-sections 的「正文」+ 语法检查）。
  // 两块都会把下方元素整体下推，所以直接比绝对 y 会把已登记新增判成回归，
  // 并且第一处失败就会中断后续所有对照。改成按结构锚点比相对偏移：
  //   title 仍比绝对 y（它上方两侧同构）；
  //   viewpoint 以标题底边为锚，并扣掉「本地规则预览」的实测外高；
  //   段落内元素以各自 section 顶边为锚（两侧结构完全同构）。
  const productTitleBottom = productGeometry.title.y + productGeometry.title.height
  const prototypeTitleBottom = prototypeGeometry.title.y + prototypeGeometry.title.height
  // 外高 = 该块自身高度 + 它与标题字段之间的间距。间距由 space-y-4 落在兄弟节点上，
  // 不在块自身的 margin 里（实测 marginTop/marginBlockStart 都是 0），
  // 所以直接从「标题字段底边」量到「该块底边」，得到它在标题卡里实际占掉的竖向空间。
  const registeredBlockOuter = productGeometry.rulePreview
    ? productGeometry.rulePreview.y - (productGeometry.titleField.y + productGeometry.titleField.height) + productGeometry.rulePreview.height
    : 0
  // 但必须锁住它的体量：它是一行提示，一旦长成多行或塞进别的内容，
  // 下面的扣除就会失真，得在这里先失败，而不是让对照悄悄变宽松。
  expect(registeredBlockOuter, '本地规则预览块外高').toBeGreaterThan(0)
  expect(registeredBlockOuter, '本地规则预览块外高').toBeLessThanOrEqual(60)

  // 纸面起点仍按绝对坐标核对，保证上面的相对比较不是建在错位的容器里。
  // 2026-11-02 布局整理（D-160）：正文列去掉「画布 + 白卡」双层容器，纸面自身的边框/投影/大内边距被收掉，
  // 因此两处竖向偏差是登记过的：正文列上内边距 25 → 18（-7），纸面上内边距 38 → 6（-32）。
  // 偏差单独写在这里并逐个限定 1px，任何额外漂移都会失败，而不是被相对比较吸收掉。
  const REGISTERED_CONTENT_INSET = -7
  const REGISTERED_PAPER_PADDING = -32
  const productWorkbarBottom = productGeometry.workbar.y + productGeometry.workbar.height
  const prototypeWorkbarBottom = prototypeGeometry.workbar.y + prototypeGeometry.workbar.height
  for (const [actualKey, expectedKey] of [['paper', 'paper'], ['title', 'title']] as const) {
    expect(Math.abs(productGeometry[actualKey].x - prototypeGeometry[expectedKey].x), `${actualKey} left alignment`).toBeLessThanOrEqual(1)
  }
  expect(
    Math.abs((productGeometry.paper.y - productWorkbarBottom) - (prototypeGeometry.paper.y - prototypeWorkbarBottom) - REGISTERED_CONTENT_INSET),
    'paper top inset（已扣除登记的内边距收紧）',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs((productGeometry.title.y - productGeometry.paper.y) - (prototypeGeometry.title.y - prototypeGeometry.paper.y) - REGISTERED_PAPER_PADDING),
    'title top offset（已扣除登记的纸面内边距收紧）',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs((productGeometry.viewpoint.y - productTitleBottom) - (prototypeGeometry.viewpoint.y - prototypeTitleBottom) - registeredBlockOuter),
    'viewpoint top alignment（已扣除本地规则预览块）',
  ).toBeLessThanOrEqual(1)
  expect(Math.abs(productGeometry.viewpoint.x - prototypeGeometry.viewpoint.x), 'viewpoint left alignment').toBeLessThanOrEqual(1)

  for (const [actualKey, expectedKey] of [
    ['sectionHeader', 'sectionHeading'], ['sectionToolbar', 'sectionToolbar'], ['paragraph', 'paragraph'],
    ['sectionActions', 'sectionActions'], ['sectionReference', 'sectionReference'],
  ] as const) {
    const actual = productGeometry[actualKey]
    const expected = prototypeGeometry[expectedKey]
    // 两侧 section 顶边与首个元素顶边重合（实测均为 0），故直接用 section 作锚。
    const actualOffset = actual.y - productGeometry.sectionGroup.y
    const expectedOffset = expected.y - prototypeGeometry.section.y
    expect(Math.abs(actualOffset - expectedOffset), `${actualKey} top alignment`).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.x - expected.x), `${actualKey} left alignment`).toBeLessThanOrEqual(1)
  }
  for (const [actualKey, expectedKey] of [
    ['sectionActions', 'sectionActions'], ['sectionReference', 'sectionReference'],
  ] as const) {
    const actual = productGeometry[actualKey]
    const expected = prototypeGeometry[expectedKey]
    expect(Math.abs(actual.height - expected.height), `${actualKey} height alignment`).toBeLessThanOrEqual(1)
  }
  await expect(page.locator('.desktop-editor-paper .group\\/sec').first()).toHaveClass(/desktop-active/)

  const italic = page.locator('.rich-editor-toolbar').first().getByRole('button', { name: '斜体' })
  await expect(italic).toBeVisible()
  await italic.click()
  await expect(italic).toHaveClass(/bg-ink-50/)
  await firstSection.locator('.desktop-section-more').click()
  await page.getByRole('menuitem', { name: '段落历史' }).click()
  await expect(page.getByRole('heading', { name: /段落历史 ·/ })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).last().click()

  await page.getByTestId('desktop-editor-steps').getByRole('link', { name: /核心观点/ }).click()
  await expect(page.locator('#step-viewpoint')).toBeInViewport()
  await page.getByTestId('desktop-editor-steps').getByRole('link', { name: /大纲/ }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: '已确认大纲' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('desktop-editor-steps').getByRole('button', { name: /给重要的事留白/ }).click()
  await expect(page.locator('#step-sections > div[id^="sec-"]').nth(1)).toBeInViewport()
  await expect(page.locator('.desktop-editor-paper .group\\/sec').nth(1)).toHaveClass(/desktop-active/)
  const viewpointProperties = page.getByTestId('desktop-editor-steps').getByRole('button', { name: '作品属性与关系' })
  await viewpointProperties.click()
  await expect(page.getByRole('button', { name: '选择素材' })).toBeVisible()
  await viewpointProperties.click()

  const title = page.locator('#step-title input').first()
  await title.fill('把重要的时间留给自己')
  const titleSaved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${workId}`) && response.request().method() === 'PATCH')
  await title.blur()
  await titleSaved
  await expect.poll(async () => (await api(page, 'GET', `/works/${workId}`)).title).toBe('把重要的时间留给自己')

  const tools = page.getByTestId('desktop-editor-tools')
  // 2026-11-02 布局整理（D-160）：右栏入口拆成一级/二级两排 tablist，语义从 button 改为 tab（配对 tabpanel）。
  for (const label of ['副驾驶', '待核实', '通读', '体检', '批注', '动态', '素材']) {
    const tab = tools.getByRole('tab', { name: new RegExp(label) }).first()
    await tab.click()
    await expect(tab).toHaveClass(/bg-ink-50/)
  }

  await page.locator('.desktop-work-more').click()
  await page.getByRole('menuitem', { name: '口述 / 要点扩写' }).click()
  await expect(page.getByRole('heading', { name: '要点整理成稿' })).toBeVisible()
  await page.getByLabel('要点或口述转写').fill('先暂停一下，想清楚什么重要。')
  await expect(page.getByRole('button', { name: '生成初稿' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '要点整理成稿' })).toBeHidden()
  const titleProperties = page.getByTestId('desktop-editor-steps').getByRole('button', { name: '标题、摘要与配图' })
  await titleProperties.click()
  await expect(page.locator('#step-title').getByText('摘要', { exact: true })).toBeVisible()
  await titleProperties.click()

  await page.getByRole('button', { name: '打开版本历史', exact: true }).click()
  await expect(page.getByRole('heading', { name: '版本历史' })).toBeVisible()
  await page.getByRole('button', { name: '保存当前版本' }).click()
  await expect(page.getByText('手动保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).last().click()
  await expect(page.getByRole('heading', { name: '版本历史' })).toBeHidden()

  const focus = page.getByRole('button', { name: '专注模式（F11）' })
  await focus.click()
  await expect(page.getByText('专注模式 · F11 退出')).toBeVisible()
  await page.getByRole('button', { name: '专注模式（F11）' }).click()
  await expect(page.getByTestId('desktop-editor-tools')).toBeVisible()

  const emptyDraft = page.locator('#step-sections > div[id^="sec-"]').nth(3)
  // 快速 mock 可能在浏览器断言前结束；先保持请求待处理以复核生成中入口。
  let releaseDraft!: () => void
  const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve })
  await page.route(`**/api/v1/sections/${work.sections[3].id}/draft`, async (route) => {
    await draftGate
    await route.continue()
  })
  try {
    await emptyDraft.getByRole('button', { name: '起草本段' }).click()
    await expect(emptyDraft.getByRole('button', { name: '停止生成' })).toBeVisible({ timeout: 10_000 })
  } finally {
    releaseDraft()
  }
  await expect.poll(async () => {
    const fresh = await api(page, 'GET', `/works/${workId}`)
    return fresh.sections[3].content_md.trim().length
  }, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: /全部起草/ })).toHaveCount(0)
})
