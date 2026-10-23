import { test, expect, _electron, type Page } from '@playwright/test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { api, registerAccount, selectDesktopSetting } from './support'

const output = resolve('../output')
const paragraph = ['第一步先选今天能完成的小事。#日常记录', '第二步记录过程，保持自己的节奏。', '第三步回顾结果，再决定下一步。']

async function readClipboard(page: Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n')
}

async function seed(page: Page, accountID: string, format = 'micro_post', title = '内部名称绝不作为发布正文') {
  let work = await api(page, 'POST', `/accounts/${accountID}/works`, { content_format: format })
  work = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '从小事开始行动有助于建立可持续的习惯。', base_revision: work.revision })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: paragraph.map((_, i) => ({ heading: `系统大纲小标题${i + 1}`, key_point: `短段落${i + 1}`, material_ids: [] })),
    confirm: true, base_revision: work.revision,
  })
  for (const [i, section] of work.sections.entries()) await api(page, 'PATCH', `/sections/${section.id}`, { content_md: paragraph[i], base_revision: section.revision })
  work = await api(page, 'GET', `/works/${work.id}`)
  return api(page, 'PATCH', `/works/${work.id}`, { title, topics: ['日常记录', '日常', '习惯养成'], base_revision: work.revision })
}

async function pack(page: Page, workID: string) {
  await page.goto(`/works/${workID}/check`)
  // NW-D1：检查页不再自动开始；没有 run 时显式发起，过期时显式重新检查。
  const initial = await api(page, 'GET', `/works/${workID}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  else if (initial.run.stale || initial.run.material_basis_stale) {
    const restarted = page.waitForResponse((response) => response.url().endsWith(`/works/${workID}/checks`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重新检查', exact: true }).first().click()
    await restarted
  }
  await expect.poll(async () => {
    const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
    return !!run && !run.stale && !run.material_basis_stale && run.fact_status !== 'pending'
  }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, item.message).toBe(true)
    else if (!item.resolution) {
      const saved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${item.id}`) && response.request().method() === 'PATCH')
      const input = page.locator(`input[name="${item.id}"]`).first()
      await input.check()
      expect((await saved).ok()).toBe(true)
      await expect(input).toBeChecked()
    }
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('ready')
  await page.goto(`/works/${workID}/pack`)
  await page.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
}

function unzip(buffer: Buffer) {
  const files = new Map<string, Buffer>()
  let offset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  while (offset >= 0 && buffer.readUInt32LE(offset) === 0x02014b50) {
    const size = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString()
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const bytes = buffer.subarray(start, start + size)
    files.set(name, buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(bytes) : bytes)
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return files
}

async function downloadFiles(page: Page) {
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载完整发布包', exact: true }).first().click()
  const download = await event
  const path = await download.path()
  expect(path).toBeTruthy()
  return unzip(await readFile(path!))
}

async function screenshot(page: Page, name: string) {
  await mkdir(output, { recursive: true })
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)))
  })
  await page.screenshot({ path: resolve(output, `toutiao-ui-completion-${name}.png`), fullPage: true })
}

test('TT04/14/15/20/28 真实剪贴板、多短段、话题去重、图片排序和人工回填', async ({ page, context }) => {
  test.setTimeout(150_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const account = await registerAccount(page, '微头条', 'toutiao')
  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(page.getByText('今日头条作品通过「发布包」由你手动发布；系统账号不代表已绑定或验证头条号身份。', { exact: true })).toBeVisible()
  await expect(page.getByText(/绑定成功|AppID|AppSecret|IP 白名单/)).toHaveCount(0)
  const work = await seed(page, account.id)
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 } })
  for (let i = 0; i < 2; i++) {
    const response = await page.request.post(`/api/v1/works/${work.id}/assets`, {
      headers: { 'X-CSRF-Token': me.csrf_token }, multipart: { file: { name: `图${i + 1}.png`, mimeType: 'image/png', buffer: png } },
    })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  let fresh = await api(page, 'GET', `/works/${work.id}`)
  const originalOrder = fresh.assets.map((asset: { id: string }) => asset.id)
  await page.goto(`/works/${work.id}`)
  await page.locator('#step-images').getByRole('button', { name: '后移', exact: true }).first().click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).assets.map((asset: { id: string }) => asset.id)).toEqual([...originalOrder].reverse())
  await pack(page, work.id)
  const body = page.getByRole('textbox', { name: '发布正文文本', exact: true })
  expect(await body.inputValue()).toBe(paragraph.join('\n\n'))
  await page.getByRole('button', { name: '复制发布正文', exact: true }).click()
  await expect.poll(() => readClipboard(page)).toBe(paragraph.join('\n\n'))
  await page.getByRole('button', { name: '复制正文与话题', exact: true }).click()
  await expect.poll(() => readClipboard(page)).toContain('#习惯养成')
  const copied = await readClipboard(page)
  expect(copied).not.toContain(work.title)
  expect(copied).not.toContain('系统大纲小标题')
  expect(copied.match(/#日常记录/g)).toHaveLength(1)
  expect(copied).toContain('\n#日常\n')
  expect(copied.match(/#习惯养成/g)).toHaveLength(1)
  expect(copied.indexOf(paragraph[0])).toBeLessThan(copied.indexOf(paragraph[1]))
  expect(copied.indexOf(paragraph[1])).toBeLessThan(copied.indexOf(paragraph[2]))
  const files = await downloadFiles(page)
  expect(files.has('title.txt')).toBe(false)
  expect(files.has('article.html')).toBe(false)
  expect(files.get('body.txt')?.toString()).toBe(paragraph.join('\n\n'))
  const map = JSON.parse(files.get('image-map.json')!.toString())
  const images = Array.isArray(map) ? map : map.images
  expect(images.map((image: { asset_id: string }) => image.asset_id)).toEqual([...originalOrder].reverse())
  const instructions = files.get('发布说明.txt')!.toString()
  expect(instructions).toMatch(/AI/)
  expect(instructions).toMatch(/原创/)
  expect(instructions).toMatch(/首发/)
  await expect(page.getByText('按实际情况处理 AI 内容声明，核实原创资格；首发默认不选。', { exact: true })).toBeVisible()
  // PB-06：交付包说明尾部追加了「分享伴侣仅用于小红书」的边界说明，这里按稳定前缀 + 边界句分别断言。
  await expect(page.getByText(/这是系统当前内容的交付包，不代表头条已收到、审核通过或发布。/)).toBeVisible()
  await expect(page.getByText(/OPS 分享伴侣仅用于小红书，头条和公众号请在对应平台后台手动发布。/)).toBeVisible()
  await context.route('https://mp.toutiao.com/**', (route) => route.fulfill({ status: 200, body: '<p>隔离验收：审核中</p>' }))
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '打开头条号后台', exact: true }).click()
  const opened = await popup
  await opened.waitForLoadState('domcontentloaded')
  expect(opened.url()).toBe('https://mp.toutiao.com/')
  await opened.close()
  fresh = await api(page, 'GET', `/works/${work.id}`)
  expect(fresh.status).toBe('packed')
  expect(fresh.published_at).toBeNull()
  await screenshot(page, 'micro-order-clipboard')
  await page.getByRole('textbox', { name: /^作品链接（可选）/ }).fill('https://example.invalid/toutiao/manual-published')
  await page.getByLabel('发布时间', { exact: true }).fill('2026-10-10T12:00')
  const published = page.waitForResponse((response) => response.url().endsWith(`/works/${work.id}/published`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await published).ok()).toBeTruthy()
  fresh = await api(page, 'GET', `/works/${work.id}`)
  expect(fresh.status).toBe('published')
  expect(fresh.locked).toBe(true)
  await expect(page.getByText('更正发布记录', { exact: true })).toBeVisible()
})

test('TT24/27 拒绝陈旧复制，剪贴板失败保留可人工选择的文本', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const account = await registerAccount(page, '微头条', 'toutiao')
  const work = await seed(page, account.id)
  await pack(page, work.id)
  await page.evaluate(() => navigator.clipboard.writeText('陈旧复制保护哨兵'))
  const fresh = await api(page, 'GET', `/works/${work.id}`)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((done) => { release = done })
  const intercepted = new Promise<void>((done) => { entered = done })
  const copyRoute = `**/api/v1/works/${work.id}/toutiao/pack?*`
  await page.route(copyRoute, async (route) => { entered(); await gate; await route.continue() })
  const check = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/toutiao/pack?`))
  try {
    await page.getByRole('button', { name: '复制发布正文', exact: true }).click()
    await intercepted
    await api(page, 'PATCH', `/works/${work.id}`, { topics: ['更新后话题'], base_revision: fresh.revision })
    release()
    expect((await check).status()).toBe(409)
  } finally {
    release()
    await page.unroute(copyRoute)
  }
  expect(await readClipboard(page)).toBe('陈旧复制保护哨兵')
  await pack(page, work.id)
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) })
    document.execCommand = () => false
  })
  await page.getByRole('button', { name: '复制发布正文', exact: true }).click()
  await expect(page.getByText('浏览器未允许复制；可点击文本框后手动复制', { exact: true })).toBeVisible()
  const body = page.getByRole('textbox', { name: '发布正文文本', exact: true })
  await body.click()
  await body.press('Control+A')
  expect(await body.evaluate((element) => {
    const field = element as HTMLTextAreaElement
    return field.value.slice(field.selectionStart, field.selectionEnd)
  })).toBe(paragraph.join('\n\n'))
  await body.press('Control+c')
  await expect.poll(() => readClipboard(page)).toBe(paragraph.join('\n\n'))
  expect(await page.locator('textarea').evaluateAll((fields) => fields.every((field) => (field as HTMLTextAreaElement).style.opacity !== '0'))).toBe(true)
  await screenshot(page, 'clipboard-denied-manual-selection')
})

test('TT40 阅读大于展现及累计下降仅提示，保存保留用户原数', async ({ page }) => {
  const account = await registerAccount(page, '微头条', 'toutiao')
  const work = await seed(page, account.id)
  await pack(page, work.id)
  await api(page, 'POST', `/works/${work.id}/published`, { url: '', published_at: '2026-10-10T04:00:00Z' })
  await api(page, 'POST', `/works/${work.id}/metrics`, { captured_at: '2026-10-11T04:00:00Z', impressions: 1000, reads: 400 })
  await page.goto(`/a/${account.id}/review?work=${work.id}`)
  await page.getByRole('combobox', { name: '复盘内容形态' }).selectOption('micro_post')
  const drawer = page.locator('.desktop-drawer-overlay')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('CTR 40%', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '录入一次数据', exact: true }).click()
  await drawer.getByRole('textbox', { name: /^数据采集时间/ }).fill('2026-10-12T12:00')
  await drawer.getByLabel('展现量', { exact: true }).fill('200')
  await drawer.getByLabel('阅读', { exact: true }).fill('300')
  await expect(drawer.getByText('阅读量大于展现量，请核对平台口径和录入数字', { exact: true })).toBeVisible()
  await expect(drawer.getByText(/展现量比第 1 天的 .*还少，累计数一般不会变少/)).toBeVisible()
  await expect(drawer.getByText(/阅读比第 1 天的 .*还少，累计数一般不会变少/)).toBeVisible()
  await expect(drawer.getByText('只读 CTR：150%', { exact: true })).toBeVisible()
  await screenshot(page, 'metrics-soft-warnings')
  await drawer.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}/metrics`)).find((metric: { day_offset: number }) => metric.day_offset === 2)).toMatchObject({ impressions: 200, reads: 300, ctr: 1.5 })
})

test('TT55 文章与微头条发布包和回填表单六种尺寸主题无溢出', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '文章', 'toutiao')
  const results = []
  for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 740, height: 640 }]) {
    await page.setViewportSize(viewport)
    await page.goto(`/a/${account.id}/works?create=1`)
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
    await expect(dialog).toBeVisible()
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    await expect(dialog.getByRole('button', { name: '开始创作', exact: true })).toBeInViewport()
    await screenshot(page, `create-${theme}-${viewport.width}x${viewport.height}`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    results.push({ surface: 'create', theme, ...viewport, bounds })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const format of ['long_article', 'micro_post']) {
    const work = await seed(page, account.id, format, `${format === 'long_article' ? '文章' : '微头条'}中文表单验收`)
    await pack(page, work.id)
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 740, height: 640 }]) {
      await page.setViewportSize(viewport)
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      const overflow = await page.locator('main input, main textarea, main select, main button').evaluateAll((fields) => fields.filter((field) => {
        const rect = field.getBoundingClientRect()
        return rect.width > 0 && (rect.left < 0 || rect.right > innerWidth + 1)
      }).map((field) => ({ tag: field.tagName, text: field.getAttribute('aria-label') || field.textContent })))
      expect(overflow).toEqual([])
      await page.getByRole('heading', { name: '发布包', exact: true }).scrollIntoViewIfNeeded()
      await screenshot(page, `${format}-${theme}-${viewport.width}x${viewport.height}`)
      await page.getByLabel('发布时间', { exact: true }).scrollIntoViewIfNeeded()
      await screenshot(page, `${format}-backfill-${theme}-${viewport.width}x${viewport.height}`)
      results.push({ surface: 'pack-and-backfill', format, theme, ...viewport, overflow })
    }
  }
  await writeFile(resolve(output, 'toutiao-ui-completion-layout.json'), JSON.stringify(results, null, 2))
})

test('逐项检查并行保存响应乱序不回退其他选择，保存中不能提前完成', async ({ page }) => {
  const account = await registerAccount(page, '微头条', 'toutiao')
  const work = await seed(page, account.id)
  await page.goto(`/works/${work.id}/check`)
  const initialRun = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  if (!initialRun.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}/checks/latest`)).run?.fact_status).toBe('done')
  const { run } = await api(page, 'GET', `/works/${work.id}/checks/latest`)
  const items = run.items.filter((item: { category: string }) => item.category !== 'format')
  expect(items.length).toBeGreaterThanOrEqual(2)
  for (const item of items.slice(0, -2)) {
    const response = page.waitForResponse((result) => result.url().endsWith(`/check-items/${item.id}`))
    await page.locator(`input[name="${item.id}"]`).first().check()
    expect((await response).ok()).toBe(true)
    await expect(page.locator(`input[name="${item.id}"]`).first()).toBeChecked()
  }
  const [first, second] = items.slice(-2)
  let release!: () => void
  let fetched!: () => void
  const gate = new Promise<void>((done) => { release = done })
  const arrived = new Promise<void>((done) => { fetched = done })
  await page.route(`**/api/v1/check-items/${first.id}`, async (route) => {
    const response = await route.fetch()
    fetched()
    await gate
    await route.fulfill({ response })
  })
  const firstInput = page.locator(`input[name="${first.id}"]`).first()
  const secondInput = page.locator(`input[name="${second.id}"]`).first()
  try {
    await firstInput.check()
    await arrived
    const secondSaved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${second.id}`))
    await secondInput.check()
    expect((await secondSaved).ok()).toBe(true)
    await expect(secondInput).toBeChecked()
    const complete = page.getByRole('button', { name: '确认完成检查', exact: true })
    await expect(complete).toBeDisabled()
    const firstSaved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${first.id}`))
    release()
    expect((await firstSaved).ok()).toBe(true)
    await expect(firstInput).toBeChecked()
    await expect(secondInput).toBeChecked()
    await expect(complete).toBeEnabled()
    await complete.click()
  } finally {
    release()
  }
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('ready')
})

test('TT52 Web三平台展开、空平台预选创建、停用与恢复账号数量', async ({ page }) => {
  const original = await registerAccount(page)
  const openMenu = async () => {
    await page.getByRole('button').filter({ hasText: '浏览器验收号' }).first().click()
    return page.getByTestId('workspace-account-menu')
  }
  let menu = await openMenu()
  await expect(menu.getByRole('button', { name: /公众号\s*0$/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /小红书\s*1$/ })).toBeVisible()
  const platform = menu.getByRole('button', { name: /今日头条\s*0$/ })
  await expect(platform).toBeVisible()
  const group = platform.locator('..')
  if (!(await group.getByRole('button', { name: '右键或点击添加', exact: true }).isVisible())) await platform.click()
  await group.getByRole('button', { name: '右键或点击添加', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(dialog.getByRole('radio', { name: /^文章/ })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: /^微头条/ })).toBeVisible()
  await expect(dialog.getByText('人工发布，无需接口凭证', { exact: true }).last()).toBeVisible()
  await dialog.getByLabel('账号名称').fill('新建头条验收号')
  const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/accounts') && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json()
  expect(account.platform).toBe('toutiao')
  await page.goto(`/a/${original.id}`)
  menu = await openMenu()
  await expect(menu.getByRole('button', { name: /今日头条\s*1$/ })).toBeVisible()
  await page.goto(`/settings/accounts?id=${account.id}`)
  await page.getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '停用', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}`)).status).toBe('disabled')
  await page.goto(`/a/${original.id}`)
  menu = await openMenu()
  await expect(menu.getByRole('button', { name: /今日头条\s*0$/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: '新建头条验收号', exact: true })).toHaveCount(0)
  await page.goto(`/settings/accounts?id=${account.id}`)
  await page.getByRole('button', { name: '重新启用', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}`)).status).toBe('active')
  await page.goto(`/a/${original.id}`)
  menu = await openMenu()
  await expect(menu.getByRole('button', { name: /今日头条\s*1$/ })).toBeVisible()
  await screenshot(page, 'web-three-platform-menu')
})

test('TT54 工作台、日历、命令搜索、搜索页、回收站及导出平台形态与路由一致', async ({ page }) => {
  test.setTimeout(150_000)
  const account = await registerAccount(page, '微头条', 'toutiao')
  const work = await seed(page, account.id, 'micro_post', '头条跨页面形态验收')
  await pack(page, work.id)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  await api(page, 'PATCH', `/works/${work.id}`, { planned_date: today })
  await page.goto(`/a/${account.id}`)
  const todo = page.locator(`a[href="/works/${work.id}/pack"]`).filter({ hasText: work.title }).first()
  await expect(todo).toContainText('微头条')
  await expect(todo).toHaveAttribute('href', `/works/${work.id}/pack`)
  await page.goto(`/a/${account.id}/calendar`)
  // OP-02：日历项直达「当前步骤」，packed 状态落到回填锚点，因此按作品 ID 前缀定位。
  const calendar = page.getByTestId('desktop-calendar-month-grid').locator(`a[href^="/works/${work.id}"]`).filter({ hasText: work.title }).first()
  await expect(calendar).toContainText('微头条')
  await expect(calendar).toHaveAttribute('href', `/works/${work.id}/pack#backfill`)
  await expect(calendar).toContainText('下一步：去回填')
  await page.goto(`/works/${work.id}`)
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await page.getByRole('button', { name: /搜索 Ctrl K/ }).click()
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('button', { name: '去生成发布包', exact: true })).toBeVisible()
  await expect(palette.getByRole('button', { name: '去写入草稿箱', exact: true })).toHaveCount(0)
  await palette.getByRole('textbox').fill(work.title)
  const found = palette.getByRole('button').filter({ hasText: work.title }).first()
  await expect(found).toContainText('今日头条')
  await expect(found).toContainText('微头条')
  await found.click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
  await page.goto(`/search?q=${encodeURIComponent(work.title)}`)
  const hit = page.locator('main').getByRole('link').filter({ hasText: work.title }).first()
  await expect(hit.locator('..')).toContainText('今日头条')
  await expect(hit.locator('..')).toContainText('微头条')
  await expect(hit).toHaveAttribute('href', `/works/${work.id}`)
  await api(page, 'DELETE', `/works/${work.id}`)
  await page.goto('/settings/trash')
  const row = page.getByRole('listitem').filter({ hasText: work.title })
  await expect(row).toContainText('今日头条 · 微头条')
  await row.getByRole('button', { name: '恢复并查看', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
  await page.goto('/settings/export')
  await expect(page.getByRole('combobox').nth(1).locator(`option[value="${account.id}"]`)).toHaveText('今日头条 · 浏览器验收号')
  await page.getByRole('combobox').nth(1).selectOption(account.id)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const downloaded = await download
  const csv = await readFile((await downloaded.path())!, 'utf8')
  expect(csv).toContain('今日头条')
  expect(csv).toContain('micro_post')
  expect(csv).toContain(work.title)
  await screenshot(page, 'export-platform-range')
})

test('TT53/55 真实Electron头条设置草稿保护、账号工作区缓存隔离及中文输入法', async ({ page, context, baseURL }) => {
  test.skip(process.platform !== 'win32', '该用例使用 Windows Electron 与原生输入，需在 Windows 客户端环境验收。')
  test.setTimeout(150_000)
  const username = `e2e-electron-${Date.now()}-${test.info().workerIndex}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  const firstWork = await seed(page, account.id, 'micro_post', '第一个账号专属微头条')
  const second = await api(page, 'POST', '/accounts', { name: '第二个头条账号', platform: 'toutiao', content_format: 'long_article' })
  const secondWork = await seed(page, second.id, 'long_article', '第二个账号专属文章')
  await api(page, 'POST', '/workspaces', { name: '头条缓存隔离工作区', switch: false })
  const prefix = join(tmpdir(), 'ops-toutiao-completion-')
  const profile = await mkdtemp(prefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')], env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL } })
    await app.context().addCookies(await context.cookies())
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect(native.getByRole('button', { name: '切换工作区与账号', exact: true })).toBeVisible()
    // 桌面形态不再回退到首个 active 账号（1c46e53），全新 profile 里必须先选一次账号。
    // 本用例验证的是设置草稿保护与工作区缓存隔离，因此直接把当前账号偏好写进这个 profile。
    await native.evaluate(async (accountId) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountId)
    }, account.id)
    await native.goto(`${baseURL}/a/${account.id}`)
    await native.getByRole('link', { name: '作品', exact: true }).click()
    await expect(native).toHaveURL(new RegExp(`/a/${account.id}/works$`))
    // 必须等作品页真正渲染完再点用户菜单：侧栏「最近作品」也有同名文本，
    // 只断言 getByText(title) 会在路由切换完成前就通过，随后 pathname 变化会关掉刚打开的菜单。
    await expect(native.getByTestId('work-row-link').filter({ hasText: firstWork.title }).first()).toBeVisible()
    await native.getByRole('button', { name: /^用户菜单/ }).click()
    await native.getByRole('menuitem', { name: '设置…', exact: true }).click()
    const settings = native.getByTestId('desktop-settings-window')
    await expect(settings).toBeVisible()
    await selectDesktopSetting(native, '每日推荐设置')
    await expect(settings.getByRole('heading', { name: '每日推荐设置', exact: true })).toBeVisible()
    const dailySettings = await api(page, 'GET', '/daily-settings')
    const unsavedHour = (dailySettings.hour + 1) % 24
    const hour = settings.getByLabel('后台生成小时（北京时间）')
    await hour.fill(String(unsavedHour))
    await native.keyboard.press('Escape')
    const discard = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: '取消', exact: true }).click()
    await expect(discard).toHaveCount(0)
    await expect(hour).toHaveValue(String(unsavedHour))
    await native.keyboard.press('Escape')
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(settings).toBeHidden()
    await expect(native).toHaveURL(new RegExp(`/a/${account.id}/works$`))
    expect((await api(page, 'GET', '/daily-settings')).hour).toBe(dailySettings.hour)
    await native.keyboard.press('Control+k')
    const palette = native.getByRole('dialog', { name: '命令面板', exact: true })
    const input = palette.getByRole('textbox')
    await input.focus()
    const cdp = await app.context().newCDPSession(native)
    await cdp.send('Input.imeSetComposition', { text: '头条输入法', selectionStart: 5, selectionEnd: 5 })
    await expect(input).toHaveValue('头条输入法')
    await native.keyboard.press('Enter')
    await expect(palette).toBeVisible()
    await cdp.send('Input.insertText', { text: '头条输入法' })
    await expect(palette).toBeVisible()
    await expect(input).toHaveValue('头条输入法')
    await native.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    const trigger = native.getByRole('button', { name: '切换工作区与账号', exact: true })
    await trigger.click()
    const menu = native.getByTestId('desktop-context-menu')
    await menu.getByRole('button', { name: '第二个头条账号', exact: true }).click()
    await expect(native).toHaveURL(new RegExp(`/a/${second.id}/works$`))
    await expect(native.getByText(secondWork.title, { exact: true }).first()).toBeVisible()
    await expect(native.getByText(firstWork.title, { exact: true })).toHaveCount(0)
    await trigger.click()
    await menu.getByRole('button', { name: '头条缓存隔离工作区', exact: true }).click()
    await expect(trigger).toContainText('头条缓存隔离工作区')
    await expect(native.getByText(secondWork.title, { exact: true })).toHaveCount(0)
    // 桌面形态不再回退到首个 active 账号（1c46e53），切到没有账号的工作区后落在设置窗的
    // 空态卡片上（web/src/pages/settings/Accounts.tsx:474-482），不会自动弹「添加平台账号」。
    const emptySettings = native.getByTestId('desktop-settings-window')
    await expect(emptySettings.getByText('当前工作区还没有平台账号', { exact: true })).toBeVisible()
    await expect(emptySettings.getByRole('button', { name: '打开顶部账号入口', exact: true })).toBeVisible()
    await screenshot(native, 'electron-ime-workspace-isolation')
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 仅清理本测试创建的Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2000))])
    }
    expect(profile.startsWith(prefix)).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
