import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { alignPrototypeToDesktopShell, api, registerAccount } from './support'

test('Electron 素材库按原型布局并逐项点击整理操作', async ({ page }) => {
  const account = await registerAccount(page)
  const materials = [
    { account_id: null, kind: 'data', content: '共享研究数据：专注时段能减少任务切换。记录显示，把相近的工作集中处理，能减少来回切换造成的时间损失。', source: '共享研究', tags: ['注意力'] },
    { account_id: account.id, kind: 'data', content: '2026 年研究记录了注意力切换带来的时间损失。研究人员观察了不同任务中的专注过程，并记录每次切换后重新进入状态所需的时间。', source: '研究记录', tags: ['注意力'] },
    { account_id: account.id, kind: 'case', content: '读者来信提到重新安排周末后，终于恢复休息。以前总想着完成更多安排，现在反而有了陪家人散步和认真吃饭的时间。', source: '读者来信', tags: ['周末'] },
    { account_id: account.id, kind: 'opinion', content: '忙碌不等于有意义，做完重要的事比排满日程更重要。给自己留出完整的思考时间，才能知道下一步该往哪里走。', source: '周记', tags: ['时间管理'] },
    { account_id: account.id, kind: 'experience', content: '每周三早上我会关掉消息提醒，留一小时只写作。没有打开消息列表，也没有先处理那些看上去紧急的小事。', source: '个人写作记录', tags: ['时间管理'] },
  ]
  for (const material of materials) await api(page, 'POST', '/materials', material)
  await api(page, 'POST', '/inbox', { account_id: account.id, content: '收件箱逐项整理回归灵感' })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByTestId('desktop-materials-layout')).toBeVisible()
  await page.locator('.desktop-materials-page').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })

  const prototype = await page.context().newPage()
  await prototype.setViewportSize({ width: 1440, height: 900 })
  await prototype.goto(pathToFileURL(resolve(process.cwd(), '../../docs/design/desktop-creative/prototype/index.html')).href)
  await prototype.locator('.sidebar-main [data-nav="materials"]').click()
  await expect(prototype.locator('#material-list')).toBeVisible()
  await prototype.locator('#view').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  await alignPrototypeToDesktopShell(prototype)

  const productSelectors = [
    '.desktop-materials-page h1', '.desktop-materials-page > div:first-child p', '.desktop-material-type-tabs',
    '.desktop-materials-filterbar', '.desktop-materials-layout', '.desktop-material-list', '.desktop-material-details',
    '.desktop-materials-search input', '.desktop-material-scope', '.desktop-material-row:first-child',
  ]
  const prototypeSelectors = ['.page-top h1', '.page-top p', '.tabs', '.filters', '.split-page', '#material-list', '.details-panel', '.filters input', '.filters select', '#material-list > .topic-row:first-child']
  const metrics = await Promise.all(productSelectors.map(async (selector, index) => {
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
  console.log('Materials layout comparison', JSON.stringify(metrics))
  for (const { selector, actual, expected } of metrics) {
    expect(Math.abs(actual.x - expected.x), `${selector} horizontal position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.y - expected.y), `${selector} vertical position`).toBeLessThanOrEqual(2)
    expect(Math.abs(actual.width - expected.width), `${selector} width`).toBeLessThanOrEqual(2)
    if (selector === '.desktop-materials-page h1' || selector.endsWith(' p') || selector.includes('search input') || selector.endsWith('scope') || selector.endsWith('row:first-child')) {
      expect(Math.abs(actual.height - expected.height), `${selector} height`).toBeLessThanOrEqual(2)
    }
  }
  await expect(page.getByRole('button', { name: '相似素材' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '从长文提炼' })).toHaveCount(0)
  await page.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/materials-layout-after.png') })
  await prototype.screenshot({ path: resolve(process.cwd(), '../../output/playwright/desktop-creative/qa-2026-10-17/screenshots/materials-layout-prototype.png') })

  const tabs = page.getByRole('tablist', { name: '素材类型' })
  for (const [label, content] of [
    ['经历', '每周三早上我会关掉消息提醒'], ['观点', '忙碌不等于有意义'], ['案例', '读者来信提到'], ['数据', '2026 年研究记录了注意力切换'],
  ]) {
    await tabs.getByRole('tab', { name: label }).click()
    await expect(page.getByTestId('desktop-material-list')).toContainText(content)
  }
  await tabs.getByRole('tab', { name: '全部' }).click()

  const scope = page.getByLabel('素材范围')
  await scope.selectOption('account')
  await expect(page.getByTestId('desktop-material-list')).not.toContainText('共享研究数据')
  await scope.selectOption('shared')
  await expect(page.getByTestId('desktop-material-list')).toContainText('共享研究数据')
  await scope.selectOption('')

  const search = page.getByRole('textbox', { name: '搜索素材' })
  await search.fill('周三早上')
  await expect(page.getByTestId('desktop-material-list')).toContainText('周三早上')
  await search.fill('不匹配的素材词')
  await expect(page.getByTestId('desktop-material-list')).toContainText('没有符合条件的素材')
  await search.fill('')

  const details = page.getByTestId('desktop-material-details')
  await page.getByTestId('desktop-material-list').getByRole('button', { name: /每周三早上/ }).click()
  await expect(details).toContainText('个人写作记录')
  await expect(details).toContainText('时间管理')
  const experienceRow = page.getByTestId('desktop-material-list').locator('article').filter({ hasText: '每周三早上我会关掉消息提醒' })
  await experienceRow.getByRole('button', { name: '查看与编辑' }).click()
  const editDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑素材' }) })
  await expect(editDialog).toBeVisible()
  const contentLabel = editDialog.locator('label:has(textarea) > div > span').first()
  // 外层 label span 是 flex 容器的 flex item，CSS 会把 inline-flex 块化成 flex。
  await expect(contentLabel).toHaveCSS('display', 'flex')
  const updatedContent = '每周三早上关闭提醒，专心写作一小时，并把这个习惯保留下来。'
  await editDialog.locator('textarea').first().fill(updatedContent)
  await editDialog.getByLabel('来源').fill('更新后的写作记录')
  await editDialog.getByRole('button', { name: '保存' }).click()
  await expect.poll(async () => {
    const found = await api(page, 'GET', `/materials?account_id=${account.id}`)
    return found.find((item: { content: string }) => item.content === updatedContent)?.source
  }).toBe('更新后的写作记录')

  await page.getByRole('button', { name: '收件箱整理' }).click()
  const drawer = page.locator('.desktop-drawer-overlay')
  await expect(drawer).toBeVisible()
  expect((await drawer.getByRole('button', { name: '关闭', exact: true }).boundingBox())!.y).toBeGreaterThan(40)
  const inboxColumns = await drawer.locator('.inbox-panel-list').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(inboxColumns).toBe(1)
  await expect(page.getByText('收件箱逐项整理回归灵感', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'AI 建议归类' }).click()
  await expect(page.getByText(/建议作为/)).toBeVisible()
  await page.getByRole('button', { name: '整理', exact: true }).click()
  const inboxConvertDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '整理这条灵感' }) })
  await expect(inboxConvertDialog).toBeVisible()
  await inboxConvertDialog.getByRole('button', { name: '存为素材' }).click()
  await expect(inboxConvertDialog.getByLabel('类型')).toBeVisible()
  await inboxConvertDialog.getByRole('button', { name: '转为选题' }).click()
  await inboxConvertDialog.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('收件箱逐项整理回归灵感', { exact: true })).toBeVisible()
  const inboxHeader = page.getByRole('heading', { name: '从收件箱整理' }).locator('xpath=../..')
  await inboxHeader.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('收件箱逐项整理回归灵感', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: '添加素材' }).click()
  const addDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加素材' }) })
  await expect(addDialog).toBeVisible()
  await addDialog.getByRole('button', { name: /观点/ }).click()
  const addedContent = '添加入口回归：完成一件重要的事后，再处理其他安排。'
  await addDialog.locator('textarea').first().fill(addedContent)
  await addDialog.getByLabel('来源').fill('浏览器点击验收')
  await addDialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByTestId('desktop-material-list')).toContainText(addedContent)
  await prototype.close()
})

test('桌面素材空态隐藏长文提炼', async ({ page }) => {
  const account = await registerAccount(page)
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByTestId('desktop-materials-layout')).toBeVisible()
  await expect(page.getByText('素材库还是空的', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '相似素材', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '从长文提炼', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '添加第一条素材', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: '添加素材', exact: true })).toBeVisible()
})

test('桌面观察者只能查看素材全文，不能进入编辑表单', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const content = `观察者可读取的素材全文。${'这是一段超过列表摘要长度的真实经历记录。'.repeat(12)}全文结束。`
  const material = await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content, tags: [] })
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    await context.addInitScript(() => {
      const userAgent = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
    })
    const registered = await context.request.post('/api/v1/auth/register', {
      data: { username: `materials-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
    })
    expect(registered.ok()).toBeTruthy()
    const viewer = await context.newPage()
    await viewer.goto(`/a/${account.id}/materials`)
    await expect(viewer.getByTestId('desktop-material-list')).toContainText('观察者可读取的素材全文')
    await expect(viewer.getByRole('button', { name: /^(添加素材|多选|编辑这条素材|删除这条素材)$/ })).toHaveCount(0)
    await viewer.getByTestId('desktop-material-list').getByRole('button', { name: /^查看/ }).click()
    await expect(viewer.getByRole('heading', { name: '素材全文', exact: true })).toBeVisible()
    await expect(viewer.locator('.desktop-drawer-overlay')).toContainText(content)
    await expect(viewer.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
    await expect(viewer.getByRole('textbox')).toHaveCount(1)
    const me = await api(viewer, 'GET', '/auth/me')
    const denied = await context.request.patch(`/api/v1/materials/${material.id}`, {
      data: { content: '观察者不应写入' }, headers: { 'X-CSRF-Token': me.csrf_token },
    })
    expect(denied.status()).toBe(403)
    expect((await api(page, 'GET', `/materials/${material.id}`)).content).toBe(content)
  } finally {
    await context.close()
  }
})
