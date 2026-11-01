import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function api(page: import('@playwright/test').Page, origin: string, method: string, path: string, data?: unknown) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }, { url: `${origin}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

// DEV-CX12 / FR-CX-18 真实 Electron 旅程：对标库登记、四问保存与笔记登记；
// 第二个窗口持有旧 revision 保存四问 → CAS 409 在界面呈现（多窗口并发编辑隔离）。
test('DEV-CX18 真实 Electron 对标库四问保存与多窗口 CAS 409', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Electron 客户端验收需要 Windows')
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-cx18-benchmark-electron-'))
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
    const username = `cx18-electron-${Date.now()}`
    await page.getByLabel('用户名', { exact: true }).fill(username)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, origin, 'POST', '/accounts', { platform: 'xhs', name: 'CX18 Electron 验收号', content_format: 'image_note', type_note: '' }) as { id: string }

    await page.goto(`${origin}/a/${account.id}/profile?tab=benchmarks`)
    const panel = page.getByTestId('benchmark-tab')
    await expect(panel).toBeVisible()
    await panel.getByLabel('名称（1..100 码点）').fill('Electron 真实窗口对标')
    await panel.getByLabel('主页 URL（可选）').fill('https://www.xiaohongshu.com/user/electron-a')
    await panel.getByRole('button', { name: '添加对标', exact: true }).click()
    await expect(panel.getByTestId('benchmark-target-item')).toHaveCount(1)

    // 第一窗口保存四问（2 问即可产生 revision）。
    const card = panel.getByTestId('benchmark-target-item').first()
    await card.getByLabel('起点可持续答案').selectOption('yes')
    await card.getByLabel('起点可持续理由').fill('选题方向可以长期产出')
    await card.getByLabel('效果非单篇答案').selectOption('no')
    await card.getByLabel('效果非单篇理由').fill('数据主要靠一篇爆款')
    const saved = page.waitForResponse((r) => r.url().includes('/benchmarks/') && r.request().method() === 'PATCH' && r.status() === 200)
    await card.getByRole('button', { name: '保存四问', exact: true }).click()
    await saved
    await expect(card).toContainText('已答 2/4')

    // 第二窗口（同账号同页面）持有旧 revision：先记下当前 revision，再从第一窗口再保存一次推进它。
    const staleRevision = await api(page, origin, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; revision: number }> }
    const targetId = staleRevision.items[0].id
    const currentRevision = staleRevision.items[0].revision
    // 模拟另一窗口基于 currentRevision 保存（服务端接受，revision +1）。
    await api(page, origin, 'PATCH', `/benchmarks/${targetId}`, {
      base_revision: currentRevision,
      answers: {
        sustainable: { answer: 'yes', reason: '另一窗口给出的理由' },
        beyond_single: { answer: 'no', reason: '另一窗口给出的理由' },
      },
    })
    // 第一窗口界面仍持有旧 revision → 界面保存触发 CAS 409 并在卡片内呈现。
    await card.getByLabel('读者匹配答案').selectOption('yes')
    await card.getByLabel('读者匹配理由').fill('第一窗口稍后给出的理由')
    await card.getByRole('button', { name: '保存四问', exact: true }).click()
    await expect(card.getByText('内容已被其他窗口修改，请刷新后重试。')).toBeVisible({ timeout: 15_000 })

    // 刷新后读到最新 revision，可再次保存成功。
    await page.reload()
    const reloaded = page.getByTestId('benchmark-target-item').first()
    await reloaded.getByLabel('材料能力支持答案').selectOption('no')
    await reloaded.getByLabel('材料能力支持理由').fill('刷新后第一窗口的补充理由')
    await expect(reloaded.getByRole('button', { name: '保存四问', exact: true })).toBeEnabled()
    const finalSave = page.waitForResponse((r) => r.url().includes('/benchmarks/') && r.request().method() === 'PATCH' && r.status() === 200)
    await reloaded.getByRole('button', { name: '保存四问', exact: true }).click()
    await finalSave
    const after = await api(page, origin, 'GET', `/benchmarks/${targetId}`) as { revision: number }
    expect(after.revision).toBeGreaterThan(currentRevision)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
})
