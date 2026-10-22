import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('真实 Electron 三平台键盘循环、上下文隔离与头条窄视口布局', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const prefix = join(tmpdir(), 'ops-toutiao-acceptance-')
  const profile = await mkdtemp(prefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5179' },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    await page.goto('http://127.0.0.1:5179/register')
    await page.getByLabel('用户名', { exact: true }).fill(`tt-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
    await expect(add).toBeVisible()
    await add.getByRole('button', { name: /今日头条/ }).click()
    await add.getByLabel('账号名称').fill('真实头条窗口验收号')
    await add.getByRole('radio', { name: /^文章/ }).check()
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/accounts') && r.request().method() === 'POST')
    await add.getByRole('button', { name: '添加账号', exact: true }).click()
    const account = await (await created).json()
    const accountURL = `http://127.0.0.1:5179/a/${account.id}`
    await page.goto(accountURL)
    const trigger = page.getByRole('button', { name: '切换工作区与账号', exact: true })
    await trigger.click()
    const menu = page.getByTestId('desktop-context-menu')
    const tabs = menu.getByRole('tablist', { name: '账号平台' })
    await expect(tabs.getByRole('tab')).toHaveCount(3)
    const selected = async (platform: string) => {
      const tab = tabs.locator(`#topbar-platform-${platform}`)
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(tab).toBeFocused()
      await expect(page).toHaveURL(accountURL)
      await expect(trigger).toContainText('今日头条 · 真实头条窗口验收号')
      return tab
    }
    const toutiao = tabs.locator('#topbar-platform-toutiao')
    await toutiao.focus()
    await toutiao.press('Home')
    let tab = await selected('wechat_mp')
    await tab.press('ArrowRight')
    tab = await selected('xhs')
    await tab.press('ArrowRight')
    tab = await selected('toutiao')
    await tab.press('ArrowRight')
    tab = await selected('wechat_mp')
    await tab.press('ArrowLeft')
    tab = await selected('toutiao')
    await tab.press('ArrowLeft')
    tab = await selected('xhs')
    await tab.press('End')
    await selected('toutiao')
    for (const size of [{ width: 1440, height: 900 }, { width: 960, height: 640 }, { width: 740, height: 640 }]) {
      // Pin the real Electron renderer's CSS viewport; the shell retains its existing 960px native minimum.
      await page.setViewportSize(size)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      const bounds = await menu.boundingBox()
      expect(bounds).toBeTruthy()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
      for (const platformTab of await tabs.getByRole('tab').all()) {
        const tabBounds = await platformTab.boundingBox()
        expect(tabBounds!.height).toBeLessThanOrEqual(40)
        await expect.poll(() => platformTab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy()
      }
      await page.screenshot({ path: testInfo.outputPath(`toutiao-native-tabs-${size.width}x${size.height}.png`) })
    }
    // 窗口变化后焦点可能已离开菜单，Escape 仍需把键盘操作交还给触发按钮。
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2000))])
    }
    expect(profile.startsWith(prefix)).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
