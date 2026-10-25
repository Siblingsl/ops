import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { api, registerAccount } from './support'

test('Electron 工作台对齐原型并逐项点击主要入口', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}`)
  await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
  await expect(page.getByTestId('desktop-dashboard')).toBeVisible()

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../docs/design/desktop-creative/prototype/index.html')).href)
  await expect(prototype.locator('.creative-welcome')).toBeVisible()
  // 入场动画在父容器 #view 上，等待 .page 的后代不会等待这段位移。
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })

  const selectors = ['.creative-welcome', '.creative-main-grid', '.creation-feature', '.today-panel', '.creative-right']
  const measure = async (target: typeof page) => Object.fromEntries(await Promise.all(selectors.map(async (selector) => [
    selector,
    await target.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }),
  ])))
  const productLayout = await measure(page)
  const prototypeLayout = await measure(prototype)
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/dashboard-layout-after.png') })

  for (const selector of selectors) {
    const actual = productLayout[selector as keyof typeof productLayout] as { x: number; y: number; width: number; height: number }
    const expected = prototypeLayout[selector as keyof typeof prototypeLayout] as { x: number; y: number; width: number; height: number }
    expect(Math.abs(actual.x - expected.x), `${selector} horizontal position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.y - expected.y), `${selector} vertical position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(2)
    if (selector === '.creative-welcome' || selector === '.creation-feature') {
      expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(2)
    }
  }

  await expect(page.getByRole('button', { name: '新建作品', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: /记下一条灵感/ }).click()
  const collectDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '随手记' }) })
  await expect(collectDialog).toBeVisible()
  await collectDialog.getByRole('button', { name: '取消' }).click()
  await page.getByTestId('desktop-home-extras').locator('summary').first().click()
  await expect(page.getByTestId('desktop-first-value-disclosure')).toBeVisible()
  await page.getByTestId('desktop-first-value-disclosure').locator('summary').click()
  await expect(page.getByRole('heading', { name: '从第一篇作品开始' })).toBeVisible()
  await page.getByTestId('desktop-first-value-disclosure').locator('summary').click()

  await prototype.close()
})

test('Electron 选题池对齐原型并逐项点击筛选入口', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/topics`, { title: '把空白时间留给自己', angle: '从每天留一段不被安排的时间开始。' })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/topics`)
  await expect(page.getByTestId('desktop-topics-layout')).toBeVisible()
  await page.locator('.desktop-topics-page').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  await expect(page.locator('.desktop-topic-tabs .tabular-nums')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '热点选题' })).toHaveCount(0)

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="topics"]').click()
  await expect(prototype.locator('.page-top')).toBeVisible()
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })

  const productSelectors = [
    '.desktop-topic-tabs > div', '.desktop-topic-filterbar', '.desktop-topic-layout',
    '.desktop-topic-list', '.desktop-topic-details', '.desktop-topic-search', '.desktop-topic-filterbar > select',
  ]
  const prototypeSelectors = ['.tabs', '.filters', '.split-page', '#topic-list', '.details-panel', '.filters .input-wrap', '.filters select']
  const layoutDiffs: Array<{ selector: string; dx: number; dy: number; dw: number; dh: number }> = []
  for (let index = 0; index < productSelectors.length; index++) {
    const actual = await page.locator(productSelectors[index]).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    const expected = await prototype.locator(prototypeSelectors[index]).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    layoutDiffs.push({ selector: productSelectors[index], dx: actual.x - expected.x, dy: actual.y - expected.y, dw: actual.width - expected.width, dh: actual.height - expected.height })
  }
  const headerMetrics = await Promise.all([
    page.locator('.desktop-topics-page > div:first-child').evaluate((element) => ({ heading: element.querySelector('h1')!.getBoundingClientRect().toJSON(), description: element.querySelector('p')!.getBoundingClientRect().toJSON() })),
    prototype.locator('.page-top').evaluate((element) => ({ heading: element.querySelector('h1')!.getBoundingClientRect().toJSON(), description: element.querySelector('p')!.getBoundingClientRect().toJSON() })),
  ])
  for (const key of ['heading', 'description'] as const) {
    expect(Math.abs(headerMetrics[0][key].x - headerMetrics[1][key].x), `${key} horizontal position`).toBeLessThanOrEqual(1)
    expect(Math.abs(headerMetrics[0][key].y - headerMetrics[1][key].y), `${key} vertical position`).toBeLessThanOrEqual(1)
    expect(Math.abs(headerMetrics[0][key].width - headerMetrics[1][key].width), `${key} width`).toBeLessThanOrEqual(1)
    expect(Math.abs(headerMetrics[0][key].height - headerMetrics[1][key].height), `${key} height`).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/topics-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/topics-layout-prototype.png') })
  for (const diff of layoutDiffs) {
    expect(Math.abs(diff.dx), `${diff.selector} horizontal position`).toBeLessThanOrEqual(1)
    // 该行为文字行高按 0.8px 舍入的弹性盒：125% 显示缩放下同一份代码两次测量分别为 2.0px 与 2.8px，
    // 属 DPI 取整抖动；3px 仍能挡住真实错位（其余选择器保持 1px）。
    expect(Math.abs(diff.dy), `${diff.selector} vertical position`).toBeLessThanOrEqual(diff.selector === '.desktop-topic-tabs > div' ? 3 : 1)
    if (diff.selector !== '.desktop-topic-tabs > div') {
      expect(Math.abs(diff.dw), `${diff.selector} width`).toBeLessThanOrEqual(1)
    }
    if (diff.selector === '.desktop-topic-tabs > div' || diff.selector === '.desktop-topic-filterbar' || diff.selector.endsWith('select') || diff.selector === '.desktop-topic-search') {
      expect(Math.abs(diff.dh), `${diff.selector} height`).toBeLessThanOrEqual(1)
    }
  }

  const search = page.getByRole('textbox', { name: '搜索选题' })
  await search.fill('空白时间')
  await expect(page.getByRole('button', { name: '把空白时间留给自己' })).toBeVisible()
  await page.getByRole('button', { name: '把空白时间留给自己' }).click()
  await expect(page.getByTestId('desktop-topic-details')).toContainText('把空白时间留给自己')
  await search.fill('不匹配的关键词')
  await expect(page.getByTestId('desktop-topic-list')).toContainText('没有符合筛选条件的选题')
  await search.fill('')

  const source = page.getByLabel('选题来源')
  await source.selectOption('manual')
  await expect(page.getByTestId('desktop-topic-list')).toContainText('把空白时间留给自己')
  await source.selectOption('all')
  await page.getByRole('button', { name: /已采用/ }).click()
  await expect(page.getByTestId('desktop-topic-list')).toContainText('还没有采用的选题')
  await page.getByRole('button', { name: /待定/ }).click()
  await expect(page.getByTestId('desktop-topic-list')).toContainText('把空白时间留给自己')

  await page.getByRole('button', { name: '添加选题' }).click()
  const addDialog = page.getByRole('dialog')
  await expect(addDialog).toBeVisible()
  await addDialog.getByRole('button', { name: '取消' }).click()
  await expect(addDialog).toBeHidden()
  await prototype.close()
})

test('Electron 日历按原型铺满主区并逐项点击日历控件', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '排期点击回归作品' })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/calendar`)
  await expect(page.getByTestId('desktop-calendar-layout')).toBeVisible()

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="calendar"]').click()
  await expect(prototype.locator('.calendar-toolbar')).toBeVisible()
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  const productSelectors = [
    '.desktop-calendar-page h1', '.desktop-calendar-page > div:first-child p', '.desktop-calendar-toolbar',
    '.desktop-calendar-card', '.desktop-calendar-unplanned',
  ]
  const prototypeSelectors = ['.page-top h1', '.page-top p', '.calendar-toolbar', '.calendar', '.calendar-topics']
  const layoutDiffs = await Promise.all(productSelectors.map(async (selector, index) => {
    const actual = await page.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    const expected = await prototype.locator(prototypeSelectors[index]).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    return { selector, actual, expected }
  }))
  console.log('Calendar layout comparison', JSON.stringify(layoutDiffs))
  console.log('Calendar row metrics', JSON.stringify(await Promise.all([
    page.locator('.desktop-calendar-card').evaluate((el) => ({ box: el.getBoundingClientRect().height, padding: getComputedStyle(el).padding, border: getComputedStyle(el).borderWidth })),
    page.locator('[data-testid="desktop-calendar-weekdays"] > div').evaluateAll((els) => els.slice(0, 1).map((el) => ({ box: el.getBoundingClientRect().height, line: getComputedStyle(el).lineHeight, padding: getComputedStyle(el).padding }))),
    page.locator('[data-testid="desktop-calendar-month-grid"] > div').evaluateAll((els) => els.slice(0, 7).map((el) => el.getBoundingClientRect().height)),
    prototype.locator('.calendar').evaluate((el) => ({ box: el.getBoundingClientRect().height, padding: getComputedStyle(el).padding, border: getComputedStyle(el).borderWidth })),
    prototype.locator('.weekday').first().evaluate((el) => ({ box: el.getBoundingClientRect().height, line: getComputedStyle(el).lineHeight, padding: getComputedStyle(el).padding })),
    prototype.locator('.day-cell').evaluateAll((els) => els.slice(0, 7).map((el) => el.getBoundingClientRect().height)),
    prototype.locator('.calendar-topics').evaluate((el) => ({ box: el.getBoundingClientRect().height, padding: getComputedStyle(el).padding, margin: getComputedStyle(el).margin })),
  ])))
  for (const { selector, actual, expected } of layoutDiffs) {
    expect(Math.abs(actual.x - expected.x), `${selector} horizontal position`).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.y - expected.y), `${selector} vertical position`).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(1)
  }
  expect(await page.getByTestId('desktop-calendar-month-grid').locator(':scope > div').count()).toBe(await prototype.locator('.day-cell').count())
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/calendar-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../output/playwright/desktop-creative/qa-2026-10-17/screenshots/calendar-layout-prototype.png') })

  expect(await page.getByTestId('desktop-calendar-month-grid').locator(':scope > div').count()).toBe(35)
  const scope = page.getByLabel('日历账号范围')
  await scope.selectOption('all')
  await expect(scope).toHaveValue('all')
  await scope.selectOption('account')
  await expect(scope).toHaveValue('account')
  await page.getByTestId('desktop-calendar-month-grid').locator('[data-date="2026-10-15"]').click()
  const dateDialog = page.getByRole('dialog')
  await expect(dateDialog.getByLabel('计划发布日')).toHaveValue('2026-10-15')
  await dateDialog.getByRole('button', { name: '取消' }).click()
  const currentLabel = await page.getByTestId('desktop-calendar-toolbar').innerText()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByTestId('desktop-calendar-toolbar')).not.toHaveText(currentLabel)
  await page.getByRole('button', { name: '回到本月' }).click()
  await page.getByRole('button', { name: '周', exact: true }).click()
  await expect(page.getByTestId('desktop-calendar-month-grid').locator(':scope > div')).toHaveCount(7)
  await page.getByRole('button', { name: '上一页' }).click()
  await page.getByRole('button', { name: '回到本周' }).click()
  await page.getByRole('button', { name: '月', exact: true }).click()

  await page.getByTestId('desktop-calendar-unplanned').getByRole('button', { name: '选择日期排期' }).click()
  const scheduleDialog = page.getByRole('dialog')
  await expect(scheduleDialog).toBeVisible()
  await scheduleDialog.getByRole('button', { name: /选题/ }).click()
  await expect(scheduleDialog).toContainText('没有待排期的选题')
  await scheduleDialog.getByRole('button', { name: /作品/ }).click()
  const dateInput = scheduleDialog.getByLabel('计划发布日')
  await expect(dateInput).toHaveCount(1)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const plannedDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  await dateInput.fill(plannedDate)
  await scheduleDialog.getByRole('button', { name: '保存排期' }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).planned_date).toBe(plannedDate)
  await expect(page.getByTestId('desktop-calendar-unplanned')).not.toContainText('排期点击回归作品')
  const event = page.getByTestId('desktop-calendar-month-grid').getByRole('link', { name: '排期点击回归作品' })
  await expect(event).toBeVisible()
  await event.click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
  await prototype.close()
})
