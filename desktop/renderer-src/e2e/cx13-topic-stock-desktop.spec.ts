import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// DEV-CX13-C / FR-CX-19：选题库存五态与 Q-CX-06 渐进核验（桌面形态）。
// 与 web 端同契约、独立实现：存量待核验 → 核验 → 可排期 → 取消排期 → 放弃 → 恢复。

async function api(page: import('@playwright/test').Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
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

const NOTE19 = '一二三四五六七八九十一二三四五六七八九'
const NOTE20 = NOTE19 + '十'

test('DEV-CX13-C 桌面选题库存：待核验标注、核验进排期、水位随动、放弃可恢复', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx13-topic-stock-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`cx13-stock-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'xhs', name: 'CX13 库存验收号', content_format: 'image_note' }) as { id: string }
    const created = await api(page, origin, 'POST', `/accounts/${account.id}/topics`, {
      title: '新手如何稳定日更', angle: '从执行步骤说明',
    }) as { topic: { id: string } }
    const topicId = created.topic.id
    const topicsUrl = `${origin}/a/${account.id}/topics`
    await page.goto(topicsUrl)

    // 存量 unknown：待核验徽标（桌面列表隐藏 tags 行，徽标在详情面板）+ 空库存水位。
    const list = page.getByTestId('desktop-topic-list')
    await expect(page.getByTestId('desktop-topic-details')).toContainText('新手如何稳定日更')
    await expect(page.getByTestId('desktop-topic-details').getByTestId('stock-unknown')).toHaveText(/待核验/)
    const waterline = page.getByTestId('topic-stock-waterline')
    await expect(waterline).toBeVisible()
    await expect(waterline.getByTestId('stock-effective')).toContainText('0/12')
    await expect(waterline).toContainText('需补给 12')

    // 未核验 idea 不提供「进入可排期」入口，只有核验动作。
    await list.getByRole('button', { name: '更多', exact: true }).click()
    await expect(list.getByRole('button', { name: '进入可排期', exact: true })).toHaveCount(0)
    await list.getByRole('button', { name: '核验选题', exact: true }).click()

    // 核验对话框：note 19 码点拒绝（按钮禁用），20 码点通过。
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '核验选题', exact: true }) })
    const note = dialog.getByRole('textbox', { name: /核验说明/ })
    await note.fill(NOTE19)
    await expect(dialog.getByRole('button', { name: '确认核验', exact: true })).toBeDisabled()
    await note.fill(NOTE20)
    await dialog.getByRole('button', { name: '确认核验', exact: true }).click()
    await expect(page.getByTestId('desktop-topic-details').getByTestId('stock-verified')).toHaveText(/已核验/)
    const verified = await api(page, origin, 'GET', `/accounts/${account.id}/topics`) as { id: string; stock_status?: string; verified_at?: string | null }[]
    const verifiedTopic = verified.find((t) => t.id === topicId)
    expect(verifiedTopic?.stock_status).toBe('verified')
    expect(verifiedTopic?.verified_at).toBeTruthy()

    // verified → ready：缺计划日期禁用；填日期后进入可排期并计入水位。
    await list.getByRole('button', { name: '更多', exact: true }).click()
    await list.getByRole('button', { name: '进入可排期', exact: true }).click()
    const readyDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '进入可排期', exact: true }) })
    await expect(readyDialog.getByRole('button', { name: '进入可排期', exact: true })).toBeDisabled()
    await readyDialog.locator('input[type=date]').fill('2030-01-02')
    await readyDialog.getByRole('button', { name: '进入可排期', exact: true }).click()
    await expect(page.getByTestId('desktop-topic-details').getByTestId('stock-ready')).toHaveText(/库存·可排期/)
    await expect(waterline.getByTestId('stock-effective')).toContainText('1/12')

    // ready → verified：取消排期保留核验记录，水位回落。
    await list.getByRole('button', { name: '更多', exact: true }).click()
    await list.getByRole('button', { name: '取消排期', exact: true }).click()
    await expect(page.getByTestId('desktop-topic-details').getByTestId('stock-verified')).toHaveText(/已核验/)
    await expect(waterline.getByTestId('stock-effective')).toContainText('0/12')

    // 放弃（status 直改同步 dropped）→ 已放弃 tab → 显式恢复为想法。
    await list.getByRole('button', { name: '更多', exact: true }).click()
    await list.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByTestId('desktop-topic-list').getByTestId('stock-unknown')).toHaveCount(0)
    await page.goto(`${topicsUrl}?tab=dropped`)
    await page.getByTestId('desktop-topic-list').getByRole('button', { name: '更多', exact: true }).click()
    await page.getByTestId('desktop-topic-list').getByRole('button', { name: '恢复为想法', exact: true }).click()
    await page.goto(topicsUrl)
    await expect(page.getByTestId('desktop-topic-details').getByTestId('stock-unknown')).toHaveText(/待核验/)
    const restored = await api(page, origin, 'GET', `/accounts/${account.id}/topics`) as { id: string; stock_status?: string; status?: string; verified_at?: string | null }[]
    const restoredTopic = restored.find((t) => t.id === topicId)
    expect(restoredTopic?.stock_status).toBe('idea')
    expect(restoredTopic?.status).toBe('pending')
    // 恢复是显式动作：不继承任何核验记录（不伪造历史核验）。
    expect(restoredTopic?.verified_at).toBeFalsy()

    await page.goto(`${origin}/a/${account.id}/profile`)
    const target = page.getByLabel('目标库存', { exact: true })
    const warn = page.getByLabel('补给警戒', { exact: true })
    await expect(target).toHaveValue('12')
    await expect(warn).toHaveValue('6')
    await warn.fill('13')
    await expect(page.getByRole('button', { name: '保存档案', exact: true })).toBeDisabled()
    await target.fill('18')
    await warn.fill('7')
    await page.getByRole('button', { name: '保存档案', exact: true }).click()
    await expect.poll(async () => (await api(page, origin, 'GET', `/accounts/${account.id}/topic-stock`) as { warn: number }).warn).toBe(7)
    await page.goto(topicsUrl)
    await expect(page.getByTestId('stock-effective')).toContainText('0/18')
    // 桌面以编辑者身份呈现时不提供配置入口；服务端仍独立校验权限。
    await page.route('**/api/v1/auth/me', async (route) => {
      const response = await route.fetch()
      const me = await response.json()
      await route.fulfill({ response, json: { ...me, role: 'editor' } })
    })
    await page.goto(`${origin}/a/${account.id}/profile`)
    await expect(page.getByRole('button', { name: '保存档案', exact: true })).toBeVisible()
    await expect(page.getByLabel('目标库存', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('补给警戒', { exact: true })).toHaveCount(0)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
