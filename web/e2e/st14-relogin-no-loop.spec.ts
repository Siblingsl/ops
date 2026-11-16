import { expect, test } from '@playwright/test'

// CF-P2-ST14-03（22 ST-14 / docs/34 §14.8）：
// 服务端会话被注销（真实 401）→ 跳登录 → 重新密码登录 → 回平台账号页无误跳环。
// ST14-01 的根因（客户端取消 ≠ 401）由服务端 499 分类与既有 session-failure/auth-failure 覆盖。

test('ST-14 真实 401 后重新密码登录并回到平台账号页不循环', async ({ page }) => {
  const username = `st14-${Date.now()}`
  const password = 'local-e2e-password-123'
  const registration = await page.request.post('/api/v1/auth/register', { data: { username, password } })
  expect(registration.ok()).toBeTruthy()

  // 正常登录（登录页旅程），进入平台账号页
  await page.goto('/login')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: /登录/ }).click()
  await expect.poll(async () => (await page.request.get('/api/v1/auth/me')).status()).toBe(200)

  await page.goto('/settings/accounts')
  await expect(page.getByRole('heading', { name: '平台账号与凭证' })).toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)

  // 服务端注销会话（模拟过期/被踢，真实 401，而非查询错误）。
  // 用页面内 fetch（带页面 Cookie 与 CSRF），确保登出作用于浏览器会话而非独立 request jar。
  await page.evaluate(async () => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const res = await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': me.csrf_token } })
    if (!res.ok) throw new Error('logout failed: ' + res.status)
  })

  // 平台账号页在会话失效后跳登录（真实 401 才跳，符合契约）。
  // reload 强制 /auth/me 重取（refetchOnWindowFocus 之外的确定路径），绕过 60s staleTime 缓存。
  await page.reload()
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

  // 重新密码登录 → 应回到 next 目标（平台账号页），停留后不再循环跳登录
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: /登录/ }).click()
  await page.waitForURL(/\/settings\/accounts/, { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: '平台账号与凭证' })).toBeVisible()
  await page.waitForTimeout(2000)
  await expect(page).not.toHaveURL(/\/login/)
})
