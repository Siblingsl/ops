import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

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

  const screenshotDir = resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots')
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
      ['titleDetails', '#step-title details'], ['viewpointCard', '#step-viewpoint'], ['viewpoint', '.desktop-viewpoint-line'],
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
  expect(productGeometry.workbar).toMatchObject({ y: 111, height: 129.5 })
  expect(productGeometry.steps?.height).toBeCloseTo(productGeometry.content?.height ?? 0, 0)
  expect(productGeometry.content?.height).toBeCloseTo(productGeometry.tools?.height ?? 0, 0)

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  const prototypeFile = pathToFileURL(resolve(process.cwd(), '../docs/design/desktop-creative/prototype/index.html')).href
  await prototype.goto(prototypeFile)
  await prototype.locator('[data-nav="editor"]').first().click()
  await expect(prototype.locator('.editor-grid')).toBeVisible()
  await prototype.waitForTimeout(300)
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

  for (const [actualKey, expectedKey] of [
    ['title', 'title'], ['viewpoint', 'viewpoint'], ['sectionHeader', 'sectionHeading'], ['sectionToolbar', 'sectionToolbar'], ['paragraph', 'paragraph'],
  ] as const) {
    const actual = productGeometry[actualKey]
    const expected = prototypeGeometry[expectedKey]
    expect(Math.abs(actual.y - expected.y), `${actualKey} top alignment`).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.x - expected.x), `${actualKey} left alignment`).toBeLessThanOrEqual(1)
  }
  for (const [actualKey, expectedKey] of [
    ['sectionActions', 'sectionActions'], ['sectionReference', 'sectionReference'],
  ] as const) {
    const actual = productGeometry[actualKey]
    const expected = prototypeGeometry[expectedKey]
    expect(Math.abs(actual.y - expected.y), `${actualKey} top alignment`).toBeLessThanOrEqual(1)
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
  for (const label of ['副驾驶', '待核实', '通读', '体检', '批注', '动态', '素材']) {
    const tab = tools.getByRole('button', { name: new RegExp(label) }).first()
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

  await page.getByRole('button', { name: '版本', exact: true }).click()
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
  await emptyDraft.getByRole('button', { name: '起草本段' }).click()
  await expect(emptyDraft.getByRole('button', { name: '停止生成' })).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => {
    const fresh = await api(page, 'GET', `/works/${workId}`)
    return fresh.sections[3].content_md.trim().length
  }, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: /全部起草/ })).toHaveCount(0)
})
