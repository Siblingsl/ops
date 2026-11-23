import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function api(page: Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async (url) => (await fetch(url, { credentials: 'include' })).json(), `${origin}/api/v1/auth/me`)
  const response = await page.evaluate(async ({ url, method, data, csrf }) => {
    const result = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await result.text()
    if (!result.ok) throw new Error(`${method} ${url}: ${result.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
  return response
}

test.describe('REF41 I4 桌面六维选题评分', () => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('详情抽屉显示六维小柱、AI 跳过原因与逐维依据', async ({ baseURL }) => {
    test.setTimeout(120_000)
    const userData = await mkdtemp(join(tmpdir(), 'ops-i4-topic-score-'))
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      app = await _electron.launch({
        executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
        args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
        env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
        timeout: 60_000,
      })
      const page = await app.firstWindow()
      const origin = baseURL ?? 'http://127.0.0.1:5288'

      await page.goto(`${origin}/register`)
      await page.getByLabel('用户名', { exact: true }).fill(`i4-topic-score-desktop-${Date.now()}`)
      await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
      await page.getByRole('button', { name: '创建账号', exact: true }).click()
      await expect.poll(() => page.evaluate(async (url) => (await fetch(url, { credentials: 'include' })).status, `${origin}/api/v1/auth/me`)).toBe(200)

      const account = await api(page, origin, 'POST', '/accounts', {
        platform: 'xhs', name: 'I4 桌面六维评分号', content_format: 'image_note',
      }) as { id: string }
      const created = await api(page, origin, 'POST', `/accounts/${account.id}/topics`, {
        title: '桌面端如何开始稳定写作',
        angle: '从每天可执行的一小步切入',
      }) as { topic: { id: string; title: string } }

      // 无定位/素材/计划日期/历史互动，规则分低于 60，用于验证桌面端 ai_skipped 展示。
      const scored = await api(page, origin, 'POST', `/topics/${created.topic.id}/score`, { mode: 'two_stage' }) as {
        result: { ai_skipped: boolean; threshold: number; dimensions: Record<string, unknown> }
      }
      expect(scored.result.ai_skipped).toBe(true)
      expect(scored.result.threshold).toBe(60)
      expect(Object.keys(scored.result.dimensions).sort()).toEqual([
        'audience', 'deliverability', 'demand', 'differentiation', 'material', 'timeliness',
      ])

      await page.goto(`${origin}/a/${account.id}/topics`)
      await expect(page.getByTestId('desktop-topics-layout')).toBeVisible()
      await page.getByRole('button', { name: created.topic.title, exact: true }).first().click()

      const bars = page.getByTestId('topic-score-bars')
      await expect(bars).toBeVisible()
      await expect(bars).toContainText('六维总分')
      await expect(bars).toContainText('AI 已跳过')
      await expect(page.locator('[data-testid^="topic-score-bar-"]')).toHaveCount(6)

      const panel = page.getByTestId('topic-score-panel')
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('阈值 60')
      await expect(panel.getByTestId('topic-score-ai-skipped')).toContainText('规则分未达阈值，未调用 AI（省成本）')
      await expect(panel.getByRole('button', { name: '仍要 AI 复核', exact: true })).toBeVisible()

      const dimensions = panel.locator('[data-testid^="topic-score-dim-"]')
      await expect(dimensions).toHaveCount(6)
      for (let i = 0; i < 6; i += 1) {
        await expect(dimensions.nth(i)).toContainText('依据：')
        await expect(dimensions.nth(i)).toContainText('为什么不是更高：')
      }
      await expect(panel.getByText(/推荐采纳|自动采纳/)).toHaveCount(0)

      await panel.scrollIntoViewIfNeeded()
      await page.screenshot({ path: '../.playwright-results/desktop-renderer/i4-topic-score-desktop.png' })
    } finally {
      // app.close() 在本机 Electron 会话里可能一直等不到窗口销毁；先让主进程退出，再限时 close。
      try { await app?.evaluate(({ app: electron }) => electron.exit(0)) } catch { /* 只关闭本用例创建的客户端。 */ }
      await Promise.race([app?.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
      await rm(userData, { recursive: true, force: true })
    }
  })
})
