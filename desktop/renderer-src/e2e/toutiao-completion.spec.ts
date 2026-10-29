import { test, expect, _electron, type Page } from '@playwright/test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { api, registerAccount, selectDesktopSetting } from './support'

const output = resolve('../../output')
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
    app = await _electron.launch({ executablePath: resolve('../node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')], env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL } })
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
    // 空态卡片上（renderer-src/src/pages/settings/Accounts.tsx:474-482），不会自动弹「添加平台账号」。
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

