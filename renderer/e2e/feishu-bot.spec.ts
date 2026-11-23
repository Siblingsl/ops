import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// REF41 E1（docs/41 §E1；D-212）：桌面形态飞书通知配置。
// 桌面设置页为同构路由（settings/feishu），验证真实 Electron 窗口下：
// 新建机器人 → 明文不回显 → 绑定 → challenge → 错误签名 401。
// 与 web/e2e/feishu-bot.spec.ts 同旅程桌面形态，不共用文件。

test('REF41 E1 桌面飞书机器人配置与入站边界', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-e1-feishu-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`e1-feishu-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

    await page.goto(`${baseURL}/settings/feishu`)
    await expect(page.getByRole('heading', { name: '飞书通知' })).toBeVisible()
    await page.getByRole('button', { name: '新建机器人' }).click()
    const dialog = page.getByRole('dialog', { name: '新建飞书机器人' })
    await dialog.getByLabel(/名称/).fill('桌面 E1 机器人')
    await dialog.getByLabel(/Webhook 地址/).fill('https://open.feishu.cn/open-apis/bot/v2/hook/desktop-e1')
    await dialog.getByLabel(/签名密钥/).fill('desktop-e1-secret')
    await dialog.getByText('定时漂移').click()
    const created = page.waitForResponse(r => r.url().endsWith('/api/v1/feishu-bots') && r.request().method() === 'POST')
    await dialog.getByRole('button', { name: '创建' }).click()
    const res = await created
    expect(res.status()).toBe(200)
    const { id: botId } = await res.json()
    await expect(page.getByText('桌面 E1 机器人')).toBeVisible()
    expect((await page.textContent('body'))).not.toContain('desktop-e1')

    // 绑定。
    await page.getByRole('button', { name: '绑定与事件' }).click()
    const bindDialog = page.getByRole('dialog', { name: '绑定与事件' })
    await bindDialog.getByPlaceholder(/chat_id/).fill('oc_desktop_e1')
    const saved = page.waitForResponse(r => r.url().includes('/bindings') && r.request().method() === 'PUT')
    await bindDialog.getByRole('button', { name: '保存绑定' }).click()
    expect((await saved).ok()).toBeTruthy()
    await page.keyboard.press('Escape')

    // 入站 challenge + 错误签名。
    const challenge = await page.evaluate(async (id) => {
      const r = await fetch(`/api/v1/public/feishu/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url_verification', challenge: 'chw_desktop' }),
      })
      return r.json()
    }, botId)
    expect(challenge.challenge).toBe('chw_desktop')
    const badStatus = await page.evaluate(async (id) => {
      const r = await fetch(`/api/v1/public/feishu/${id}`, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'X-Lark-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
          'X-Lark-Request-Nonce': 'n',
          'X-Lark-Signature': 'bad',
        },
        body: JSON.stringify({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'oc_desktop_e1', chat_type: 'p2p', content: '{"text":"/状态"}' } } }),
      })
      return r.status
    }, botId)
    expect(badStatus).toBe(401)
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* exited */ } }
    try {
      const profileArg = profile.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profileArg}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' })
    } catch { /* best effort */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
})
