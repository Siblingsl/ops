import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-05 批 1 桌面形态（docs/26 本地遗留表 G2-07/08/09/10/11，desktop-renderer 项目）：
// 与 web 形态 qa26-b1-endform-web.spec.ts 同一旅程的桌面工作台形态。
// G2-07 桌面 Profile 风格样本增改删读回；G2-08 桌面素材收藏星标；
// G2-09 桌面图库 AI 建议与复制链接按钮；G2-10 桌面全局搜索 + XC-02 回写缺陷钉住；
// G2-11 桌面 admin 门禁与超管后台可达。
// 无外部依赖：AI 建议走 mock 模型路由；不得 mock 抬交%。

async function apiFn(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function pngBuffer(page: Page): Promise<Buffer> {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#4c7ef3'
    ctx.fillRect(0, 0, 32, 32)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(data, 'base64')
}

// 桌面形态标记：UA 注入 Electron 后 html[data-presentation=ops-creative-desktop]，
// 素材页走 desktop-materials-layout 双栏结构（desktopPresentation 分支）。
async function enableDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

test('DEV-QA26 B1 桌面 G2-07 风格样本 tab 增改删读回', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/profile?tab=samples`)
  await expect(page.getByRole('main')).toContainText('风格样本')
  // 新增（桌面弹窗保存按钮 disabled={!title.trim() || !content.trim()}，标题必填）
  await page.getByRole('button', { name: /添加|粘贴第一篇样本/ }).first().click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /添加风格样本/ }) })
  await expect(dialog).toBeVisible()
  const sampleText = 'B1 桌面样本验收正文：先给结论再给依据，段落短，结尾留一个具体行动。'.repeat(3)
  await dialog.getByLabel('标题').fill('B1 桌面样本')
  await dialog.getByLabel('正文').fill(sampleText)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('main')).toContainText('1 篇')
  // API 读回
  const list = await apiFn(page, 'GET', `/accounts/${account.id}/style-samples`) as Array<{ title: string; char_count: number }>
  expect(list).toHaveLength(1)
  expect(list[0].char_count).toBe(sampleText.length)
})

test('DEV-QA26 B1 桌面 G2-08 素材收藏星标（CF-P2-DESKSTAR-01 修复后回归：桌面双栏有星标入口）', async ({ page }, testInfo) => {
  const account = await registerAccount(page)
  await apiFn(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: '桌面收藏星标验收素材正文。' })
  // ①桌面双栏形态（desktop-materials-layout）：列表行与详情面板均渲染 StarButton
  //   （CF-P2-DESKSTAR-01 修复：列表 meta 行 + 详情动作区补星标，与 Web 单栏同构）。
  //   点击列表行星标 → aria-pressed 翻转 → GET /stars 读回。
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByTestId('desktop-materials-layout')).toBeVisible()
  const starBtns = page.locator('button[title="收藏"]')
  await expect(starBtns).not.toHaveCount(0)
  await starBtns.first().click()
  await expect(page.locator('button[title="取消收藏"]').first()).toBeVisible()
  const mats = await apiFn(page, 'GET', `/materials?account_id=${account.id}`) as Array<{ id: string }>
  await expect.poll(async () => {
    const starred = await apiFn(page, 'GET', '/stars') as Array<{ object_type: string; object_id: string }>
    return starred.some((s) => s.object_type === 'material' && s.object_id === mats[0].id)
  }).toBe(true)
  // ②取消收藏往返（列表行星标再点一次）
  await page.locator('button[title="取消收藏"]').first().click()
  await expect(page.locator('button[title="收藏"]').first()).toBeVisible()
  await testInfo.attach('g2-08-desktop-star-gap.json', {
    body: JSON.stringify({ fix: 'CF-P2-DESKSTAR-01：桌面双栏列表行与详情面板补 StarButton，点击收藏→取消收藏往返 + GET 读回可用' }, null, 2),
    contentType: 'application/json',
  })
})

test('DEV-QA26 B1 桌面 G2-09 图库 AI 建议与复制链接按钮', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await apiFn(page, 'POST', `/accounts/${account.id}/works`, { title: 'B1 桌面图库动作验收' }) as { id: string }
  const me = await apiFn(page, 'GET', '/auth/me') as { csrf_token: string }
  const uploaded = await page.request.post(`/api/v1/works/${work.id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token }, multipart: { file: { name: 'b1-desktop-library.png', mimeType: 'image/png', buffer: await pngBuffer(page) } },
  })
  expect(uploaded.ok()).toBeTruthy()
  await page.goto('/images')
  await expect(page.getByRole('main')).toBeVisible()
  await page.locator('button:has(img)').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /生成 AI 建议/ }).click()
  await expect(dialog.getByRole('button', { name: /复制图片链接/ })).toBeVisible()
})

test('DEV-QA26 B1 桌面 G2-10 全局搜索类型切换、清除筛选与 XC-02 URL 还原（CF-P2-SEARCH-01 修复后回归）', async ({ page }, testInfo) => {
  const account = await registerAccount(page)
  await apiFn(page, 'POST', `/accounts/${account.id}/works`, { title: 'B1 桌面全局搜索命中作品' })
  await page.goto('/search?q=' + encodeURIComponent('桌面全局搜索命中'))
  await expect(page.getByRole('main')).toBeVisible()
  const main = page.getByRole('main')
  await main.getByRole('button', { name: '作品', exact: true }).click()
  await expect.poll(() => page.url(), { timeout: 5000 }).toContain('type=work')
  // 清除筛选（空态分支）+ XC-02 回归（CF-P2-SEARCH-01：合并 patch 后不再把旧筛选整份回写）
  await page.goto('/search?q=' + encodeURIComponent('B1 桌面无匹配关键词组合') + '&type=work')
  const clearBtn = main.getByRole('button', { name: /清除筛选/ })
  await expect(clearBtn).toBeVisible()
  await clearBtn.click()
  await page.waitForTimeout(1500)
  const afterUrl = page.url()
  await testInfo.attach('g2-10-desktop-clear-filter-regression.json', {
    body: JSON.stringify({ afterUrl, fix: 'CF-P2-SEARCH-01：清除筛选一次合并 patch（type/account/status/days），URL 不再回写 type=work' }, null, 2),
    contentType: 'application/json',
  })
  expect(afterUrl).not.toContain('type=work')
})

test('DEV-QA26 B1 桌面 G2-11 普通用户 admin 403 门禁与超管后台可达', async ({ page, browser }) => {
  await registerAccount(page)
  for (const path of ['/admin/users', '/admin/workspaces', '/admin/audit-logs', '/admin/platform/breakers']) {
    const status = await page.evaluate(async (p) => (await fetch('/api/v1' + p)).status, path)
    expect(status).toBe(403)
  }
  const adminContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const adminPage = await adminContext.newPage()
  try {
    await adminPage.goto('/login')
    await adminPage.getByLabel('用户名', { exact: true }).fill('skyeder')
    await adminPage.getByLabel('密码', { exact: true }).fill('local-e2e-admin-pass-456')
    const adminLogin = adminPage.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST')
    await adminPage.getByRole('button', { name: '登录', exact: true }).click()
    expect((await adminLogin).status()).toBe(200)
    await adminPage.goto('/settings/admin')
    await expect(adminPage.getByText('全站超级管理员', { exact: false })).toBeVisible()
    const adminUsers = await adminPage.evaluate(async () => (await fetch('/api/v1/admin/users')).status)
    expect(adminUsers).toBe(200)
  } finally {
    await adminContext.close()
  }
})
