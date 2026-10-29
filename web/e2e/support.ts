import { test, expect, type Page } from '@playwright/test'

/**
 * Web 端 E2E 辅助（纯浏览器形态）。
 *
 * 桌面形态的辅助在本文件里没有副本，统一放在 `desktop/renderer-src/e2e/support.ts`。
 * 本文件不允许出现 Electron 类型、UA 注入、`data-presentation` 判断，
 * 由 `tests/web-boundary.test.mjs` 静态约束。
 */

export async function api(page: Page, method: string, path: string, data?: unknown) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.fetch('/api/v1' + path, { method, data, headers: { 'X-CSRF-Token': me.csrf_token } })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.json()
}

export async function registerAccount(page: Page, type = '图文笔记', platform: 'xhs' | 'wechat_mp' | 'toutiao' = 'xhs', username = `e2e-${Date.now()}-${test.info().workerIndex}`) {
  await page.goto('/register')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: platform === 'xhs' ? /小红书/ : platform === 'toutiao' ? /今日头条/ : /公众号/ }).click()
  await dialog.getByLabel('账号名称').fill('浏览器验收号')
  await dialog.getByRole('radio', { name: new RegExp('^' + type) }).check()
  const created = page.waitForResponse(r => r.url().endsWith('/api/v1/accounts') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json()
  await page.goto(`/a/${account.id}`)
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  if (process.env.OPS_E2E_PROD === '1') {
    const provider = await api(page, 'POST', '/model-providers', {
      name: '隔离生产验收模拟模型', base_url: 'http://mock:8191/v1', api_key: 'local-e2e-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'default', provider_id: provider.id, model: 'mock-writer' }])
    // 注册已经创建会话；生产形态另验一次退出与密码登录。
    await api(page, 'POST', '/auth/logout')
    await page.goto('/login')
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill('local-e2e-password-123')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
    await page.goto(`/a/${account.id}`)
    await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
  }
  return account
}

/**
 * Web 形态：大纲直接嵌在编辑页步骤流里，没有桌面侧栏步骤导航，也没有大纲对话框。
 * 桌面形态的对应实现见 `desktop/renderer-src/e2e/support.ts`。
 */
export async function createOutline(page: Page) {
  await page.getByRole('button', { name: '新建作品', exact: true }).first().click()
  // NW-A1：所有入口都先打开同一个创建面板；标题可留空，直接开始创作。
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  const outline = page.locator('body')
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await expect(outline.getByRole('button', { name: 'AI 生成大纲', exact: true })).toBeDisabled()
  await viewpoint.fill('少而精的步骤更容易长期坚持，这是我的经验判断。')
  await viewpoint.blur()
  await outline.getByRole('button', { name: 'AI 生成大纲', exact: true }).click()
  await expect(outline.getByRole('button', { name: '确认大纲', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '起草本段', exact: true })).toHaveCount(0)
  await outline.getByRole('button', { name: '确认大纲', exact: true }).click()
  await expect(page.getByText('已确认', { exact: true }).first()).toBeVisible()
  return id
}

export async function finishChecks(page: Page, id: string) {
  await page.goto(`/works/${id}/check`)
  // NW-D1：检查页不再自动开始；没有 run 时显式发起，过期时显式重新检查。
  const initial = await api(page, 'GET', `/works/${id}/checks/latest`)
  if (!initial.run) await page.getByRole('button', { name: '开始检查', exact: true }).click()
  else if (initial.run.stale || initial.run.material_basis_stale) {
    const restarted = page.waitForResponse((response) => response.url().endsWith(`/works/${id}/checks`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '重新检查', exact: true }).first().click()
    await restarted
  }
  await expect.poll(async () => {
    const { run } = await api(page, 'GET', `/works/${id}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 20_000 }).toBeTruthy()
  await expect(page.getByText('事实核查', { exact: true }).locator('..')).toContainText('已完成')
  const { run } = await api(page, 'GET', `/works/${id}/checks/latest`)
  expect(run).toBeTruthy()
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      if (item.category === 'ai_disclosure') {
        const saved = page.waitForResponse(r => r.url().endsWith(`/check-items/${item.id}`) && r.request().method() === 'PATCH')
        const checkbox = page.getByRole('checkbox', { name: '已知悉，发布时会声明' })
        await checkbox.click()
        expect((await saved).ok()).toBeTruthy()
        await expect(checkbox).toBeChecked()
      }
      else await page.locator(`input[name="${item.id}"]`).first().check()
    }
  }
  await page.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).status).toBe('ready')
}
