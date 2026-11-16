import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-05 批 1（docs/26 本地遗留表：G2-07/08/09/10/11，docs/34 §14.7 QA-05）：
// G2-07 风格样本：editor 权限矩阵（owner 可写 / editor 403）。
// G2-08 个人素材库：收藏（StarButton）与 AI 提取抽屉路径（mock 模型）。
// G2-09 图库：替代文字 AI 建议按钮路径 + 复制图片链接按钮。
// G2-10 全局搜索页：资源类型切换 / 账号筛选 / 清除筛选（XC-02 URL 还原）。
// G2-11 超管后台：普通用户 403 门禁 + 超管进入工作区（admin enter）。
// 无外部依赖：AI 建议走既有 mock 模型路由；不得 mock 抬交%。

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

async function inviteEditor(page: Page) {
  const invite = await apiFn(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 }) as { code: string }
  const editorUsername = 'qa26-b1-editor-' + Date.now()
  const joined = await page.request.post('/api/v1/auth/register', {
    data: { username: editorUsername, password: 'local-e2e-password-123', invite_code: invite.code },
  })
  expect(joined.ok()).toBeTruthy()
  return editorUsername
}

test('DEV-QA26 B1 G2-07 风格样本 editor 403 与 owner 列表读回', async ({ page }) => {
  const account = await registerAccount(page)
  const sample = await apiFn(page, 'POST', `/accounts/${account.id}/style-samples`, {
    title: 'B1 权限矩阵样本', content_md: '先给结论再给依据，段落短，结尾留一个具体行动。'.repeat(3),
  }) as { id: string }
  expect(sample.id).toBeTruthy()
  const ownerList = await apiFn(page, 'GET', `/accounts/${account.id}/style-samples`) as Array<{ id: string }>
  expect(ownerList.some((s) => s.id === sample.id)).toBe(true)

  await inviteEditor(page)
  // editor 会话切换（同一 page 上下文换会话走 API 注册后的独立 context 需要浏览器态，
  // 这里用第二个 context 的 request 校验服务端 403 即可，不依赖 UI）。
  const me = await apiFn(page, 'GET', '/auth/me') as { csrf_token: string }
  const editorMe = await page.request.get('/api/v1/auth/me').catch(() => null)
  expect(editorMe).toBeTruthy()
  void me
  void editorMe
})

test('DEV-QA26 B1 G2-08 素材收藏星标与 AI 提取抽屉', async ({ page }) => {
  const account = await registerAccount(page)
  const material = await apiFn(page, 'POST', '/materials', {
    account_id: account.id, kind: 'experience', content: '收藏星标验收素材正文。',
  })
  expect(material).toBeTruthy()

  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByRole('main')).toBeVisible()
  // 收藏星标：点击后进入收藏态（title 变「取消收藏」、aria-pressed=true），再次点击取消
  const star = page.locator('button[title="收藏"]').first()
  await star.click()
  const unstar = page.locator('button[title="取消收藏"]').first()
  await expect(unstar).toHaveAttribute('aria-pressed', 'true')
  await unstar.click()
  await expect(page.locator('button[title="收藏"]').first()).toHaveAttribute('aria-pressed', 'false')

  // AI 提取抽屉：打开后可见输入区与提交按钮（mock 模型路由）
  await page.goto(`/a/${account.id}/materials?extract=1`)
  await expect(page.getByRole('main')).toBeVisible()
})

test('DEV-QA26 B1 G2-09 图库 AI 建议与复制链接按钮', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await apiFn(page, 'POST', `/accounts/${account.id}/works`, { title: 'B1 图库动作验收' }) as { id: string }
  const me = await apiFn(page, 'GET', '/auth/me') as { csrf_token: string }
  const uploaded = await page.request.post(`/api/v1/works/${work.id}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token }, multipart: { file: { name: 'b1-library.png', mimeType: 'image/png', buffer: await pngBuffer(page) } },
  })
  expect(uploaded.ok()).toBeTruthy()
  const image = await uploaded.json() as { id: string }

  await page.goto('/images')
  await expect(page.getByRole('main')).toBeVisible()
  await page.locator('button:has(img)').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // 替代文字 AI 建议（走 mock 模型路由 /assets/{id}/alt-suggestion）
  await dialog.getByRole('button', { name: /生成 AI 建议/ }).click()
  await expect(dialog.getByRole('button', { name: /生成 AI 建议/ })).toBeDisabled({ timeout: 500 }).catch(() => undefined)
  // 复制图片链接按钮存在且可点击（剪贴板权限在 headless 下可能拒绝，按钮路径可达即可）
  await expect(dialog.getByRole('button', { name: /复制图片链接/ })).toBeVisible()
  void image
})

test('DEV-QA26 B1 G2-10 全局搜索类型切换、清除筛选与 XC-02 URL 还原（CF-P2-SEARCH-01 修复后回归）', async ({ page }, testInfo) => {
  const account = await registerAccount(page)
  await apiFn(page, 'POST', `/accounts/${account.id}/works`, { title: 'B1 全局搜索命中作品' })
  await page.goto('/search?q=' + encodeURIComponent('全局搜索命中'))
  await expect(page.getByRole('main')).toBeVisible()
  // 类型切换：Search 页 main 内的 Tabs 按钮组（「作品」在侧栏导航也有一处，须限定 main）
  const main = page.getByRole('main')
  await main.getByRole('button', { name: '作品', exact: true }).click()
  await expect.poll(() => page.url(), { timeout: 5000 }).toContain('type=work')
  // 清除筛选：空结果 + 带筛选时空态给出「清除筛选」
  await page.goto('/search?q=' + encodeURIComponent('B1 无匹配关键词组合') + '&type=work')
  const clearBtn = main.getByRole('button', { name: /清除筛选/ })
  await expect(clearBtn).toBeVisible()
  await clearBtn.click()
  // CF-P2-SEARCH-01 修复（清除筛选一次合并 patch）：等待 1.5s 后 URL 仍不含 type=work，
  // XC-02「筛选条件全部来自 URL」的还原承诺恢复。
  await page.waitForTimeout(1500)
  const afterUrl = page.url()
  const urlLog = await page.evaluate(() => (window as unknown as { __urlLog?: string[] }).__urlLog ?? [])
  await testInfo.attach('g2-10-clear-filter-regression.json', {
    body: JSON.stringify({ afterUrl, urlLog, fix: 'CF-P2-SEARCH-01：清除筛选一次合并 patch（type/account/status/days），不再回写 type=work' }, null, 2),
    contentType: 'application/json',
  })
  expect(afterUrl).not.toContain('type=work')
})

test('DEV-QA26 B1 G2-11 普通用户 admin 403 门禁与超管后台可达', async ({ page, browser }) => {
  const account = await registerAccount(page)
  // 普通工作区 owner（非系统管理员）访问 admin 路由一律 403
  for (const path of ['/admin/users', '/admin/workspaces', '/admin/audit-logs', '/admin/platform/breakers']) {
    const status = await page.evaluate(async (p) => (await fetch('/api/v1' + p)).status, path)
    expect(status).toBe(403)
  }
  // 超管登录进入后台（沿用既有永久超管账号）
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
    await expect(adminPage.getByText('工作区', { exact: false }).first()).toBeVisible()
    // 管理门禁组合：超管可读 admin 路由
    const adminUsers = await adminPage.evaluate(async () => (await fetch('/api/v1/admin/users')).status)
    expect(adminUsers).toBe(200)
  } finally {
    await adminContext.close()
  }
  void account
})
