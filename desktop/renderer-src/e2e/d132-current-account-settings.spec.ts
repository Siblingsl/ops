import { openDesktopAccountSwitcher } from './support'
import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

async function desktopMode(page: Page) {
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${agent} Electron/44.8.0` })
    window.open = (() => null) as typeof window.open
  })
}

async function openCurrentSettings(page: Page, accountId: string, accountName: string) {
  await page.goto(`/a/${accountId}`)
  const switcher = page.locator('.desktop-statusbar-context')
  await expect(switcher).toBeVisible()
  await expect(switcher).toContainText(accountName)
  await page.goto(`/settings/accounts?id=${accountId}`)
  await expect(page.getByTestId('desktop-settings-window')).toBeVisible()
  await expect(page.getByRole('heading', { name: '平台账号与凭证', exact: true })).toBeVisible()
}

test('D-132 设置只显示当前账号，资料显式保存且窄窗不横向溢出', async ({ page }, testInfo) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '不应显示的公众号账号', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  const body = settings.locator('.desktop-settings-body')
  await expect(settings.getByText(current.name, { exact: true })).toBeVisible()
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
  await expect(settings.getByPlaceholder('搜索账号名称或平台')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '添加账号', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '全部', exact: false })).toHaveCount(0)
  await expect(settings.getByText('当前账号摘要', { exact: true })).toHaveCount(0)

  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  let patchCount = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/v1/accounts/${current.id}`)) patchCount++
  })
  await name.fill('尚未保存的账号名')
  await name.blur()
  await page.waitForTimeout(250)
  expect(patchCount).toBe(0)
  await settings.locator('.desktop-account-actions details > summary').click()
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/v1/accounts') && response.request().method() === 'GET')
  const disabled = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${current.id}/disable`) && response.request().method() === 'POST')
  await settings.getByRole('button', { name: '停用当前账号', exact: true }).click()
  const disableConfirm = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: new RegExp(current.name) }) })
  await disableConfirm.getByRole('button', { name: '停用', exact: true }).click()
  expect((await disabled).ok()).toBeTruthy()
  await refreshed
  await expect(name).toHaveValue('尚未保存的账号名')
  const reenabled = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${current.id}/enable`) && response.request().method() === 'POST')
  await settings.getByRole('button', { name: '重新启用', exact: true }).click()
  expect((await reenabled).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).status).toBe('active')
  await settings.getByRole('button', { name: '取消修改', exact: true }).click()
  await expect(name).toHaveValue(current.name)

  await name.fill('保存后的当前账号')
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${current.id}`) && response.request().method() === 'PATCH')
  await settings.getByRole('button', { name: '保存信息', exact: true }).click()
  expect((await saved).ok()).toBeTruthy()
  await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).name).toBe('保存后的当前账号')
  expect(patchCount).toBe(1)

  for (const [width, height] of [[1440, 900], [960, 640], [740, 640]]) {
    await page.setViewportSize({ width, height })
    await expect.poll(() => body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy()
    const panel = await settings.boundingBox()
    expect(panel).toBeTruthy()
    expect(panel!.x).toBeGreaterThanOrEqual(0)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width)
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(height - 24)
    await page.screenshot({ path: testInfo.outputPath(`d132-current-account-${width}x${height}.png`), animations: 'disabled' })
  }
})

test('D-132 基本信息校验阻止空名称与越界公众号上限提交', async ({ page }) => {
  const current = await registerAccount(page, '长图文', 'wechat_mp')
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)
  const settings = page.getByTestId('desktop-settings-window')
  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  const limit = settings.getByRole('spinbutton', { name: /每日写入草稿上限/ })
  const typeNote = settings.getByRole('textbox', { name: /类型补充说明/ })
  let patchCount = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/v1/accounts/${current.id}`)) patchCount++
  })

  await name.fill('   ')
  await settings.getByRole('button', { name: '保存信息', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('账号名称不能为空')
  expect(patchCount).toBe(0)

  await name.fill(current.name)
  await limit.fill('21')
  await settings.getByRole('button', { name: '保存信息', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('每日写入草稿上限必须是 1–20 的整数')
  expect(patchCount).toBe(0)
  await expect(typeNote).toHaveAttribute('maxlength', '200')
})

test('D-132 类型迁移影响读取失败可重试，迁移前作品仍保留原类型', async ({ page }) => {
  const account = await registerAccount(page)
  const workId = await createOutline(page)
  await desktopMode(page)
  await openCurrentSettings(page, account.id, account.name)
  const settings = page.getByTestId('desktop-settings-window')
  let worksReads = 0
  await page.route(`**/api/v1/accounts/${account.id}/works`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    worksReads++
    if (worksReads === 1) {
      await route.fulfill({ status: 500, json: { error: { code: 'internal', message: '测试作品列表读取失败' } } })
      return
    }
    await route.continue()
  })

  await settings.getByRole('button', { name: '修改类型', exact: true }).click()
  const migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
  await expect(migration.getByRole('alert')).toContainText('读取修改影响失败')
  await expect(migration.getByRole('button', { name: '确认修改', exact: true })).toBeDisabled()
  await expect(migration.getByText(/已有 0 篇作品保持原类型/)).toHaveCount(0)
  await expect(migration.getByRole('button', { name: '重新读取修改影响', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 740, height: 640 })
  const dialogBounds = await migration.boundingBox()
  expect(dialogBounds).toBeTruthy()
  expect(dialogBounds!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(740)
  const dialogBody = await migration.locator('.desktop-dialog-body').evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  expect(dialogBody.scroll).toBeLessThanOrEqual(dialogBody.width + 1)
  const alertBounds = await migration.getByRole('alert').boundingBox()
  const footerBounds = await migration.locator(':scope > div').last().boundingBox()
  expect(alertBounds).toBeTruthy()
  expect(footerBounds).toBeTruthy()
  expect(alertBounds!.y + alertBounds!.height).toBeLessThanOrEqual(footerBounds!.y)
  await page.screenshot({ path: '../../output/playwright/d132-migration-impact-error-narrow.png', animations: 'disabled' })

  await migration.getByRole('button', { name: '重新读取修改影响', exact: true }).click()
  await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
  await migration.getByRole('radio', { name: /漫画/ }).check()
  await migration.getByRole('button', { name: '确认修改', exact: true }).click()
  await expect(settings.getByText('漫画', { exact: true }).first()).toBeVisible()
  expect((await api(page, 'GET', `/accounts/${account.id}/works`)).find((work: { id: string }) => work.id === workId).content_format).toBe('image_note')
  expect((await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id).content_format).toBe('comic')
  await expect(settings.locator('.desktop-settings-heading')).toContainText(account.name)

  await settings.getByRole('button', { name: '修改类型', exact: true }).click()
  const reverse = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
  await expect(reverse.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
  await reverse.getByRole('radio', { name: /图文笔记/ }).check()
  await reverse.getByRole('button', { name: '确认修改', exact: true }).click()
  expect((await api(page, 'GET', `/accounts/${account.id}/works`)).find((work: { id: string }) => work.id === workId).content_format).toBe('image_note')
  expect((await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id).content_format).toBe('image_note')
})

test('D-132 角色卡影响读取失败时禁止类型迁移并可重试', async ({ page }) => {
  const account = await registerAccount(page, '漫画', 'xhs')
  await api(page, 'POST', `/accounts/${account.id}/characters`, {
    name: '迁移验收角色', appearance: '短发', personality: '谨慎', catchphrase: '先核对影响',
  })
  await desktopMode(page)
  await openCurrentSettings(page, account.id, account.name)
  const settings = page.getByTestId('desktop-settings-window')
  let reads = 0
  await page.route(`**/api/v1/accounts/${account.id}/characters`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    reads++
    if (reads === 1) {
      await route.fulfill({ status: 500, json: { error: { code: 'internal', message: '测试角色卡列表读取失败' } } })
      return
    }
    await route.continue()
  })

  await settings.getByRole('button', { name: '修改类型', exact: true }).click()
  const migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改账号类型', exact: true }) })
  await expect(migration.getByRole('alert')).toContainText('读取修改影响失败')
  await expect(migration.getByRole('alert')).toContainText('测试角色卡列表读取失败')
  await expect(migration.getByRole('button', { name: '确认修改', exact: true })).toBeDisabled()
  await expect(migration.getByText(/已有 0 篇作品保持原类型/)).toHaveCount(0)
  await migration.getByRole('button', { name: '重新读取修改影响', exact: true }).click()
  await expect(migration.getByText(/已有 0 篇作品保持原类型/)).toBeVisible()
  await expect(migration.getByText(/角色卡会保留（1 张）/)).toBeVisible()
  await migration.getByRole('radio', { name: /图文笔记/ }).check()
  await migration.getByRole('button', { name: '确认修改', exact: true }).click()
  await expect(settings.getByText('图文笔记', { exact: true }).first()).toBeVisible()
  expect((await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id).content_format).toBe('image_note')
})

test('D-132 头条默认形态切换只影响新作品且当前账号不变', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const oldWork = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '迁移前的头条文章' })
  expect(oldWork.content_format).toBe('long_article')
  await desktopMode(page)
  await openCurrentSettings(page, account.id, account.name)
  const settings = page.getByTestId('desktop-settings-window')

  await settings.getByRole('button', { name: '修改默认形态', exact: true }).click()
  let migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改默认创作形态', exact: true }) })
  await expect(migration.getByText(/已有 1 篇作品保持原类型/)).toBeVisible()
  await migration.getByRole('radio', { name: /微头条/ }).check()
  await migration.getByRole('button', { name: '确认修改', exact: true }).click()
  await expect(settings.getByText('微头条', { exact: true }).first()).toBeVisible()
  await expect(settings.locator('.desktop-settings-heading')).toContainText(account.name)

  const newWork = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '迁移后的微头条' })
  expect(newWork.content_format).toBe('micro_post')
  expect((await api(page, 'GET', `/works/${oldWork.id}`)).content_format).toBe('long_article')

  await settings.getByRole('button', { name: '修改默认形态', exact: true }).click()
  migration = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改默认创作形态', exact: true }) })
  await expect(migration.getByText(/已有 2 篇作品保持原类型/)).toBeVisible()
  await migration.getByRole('radio', { name: /^文章/ }).check()
  await migration.getByRole('button', { name: '确认修改', exact: true }).click()
  expect((await api(page, 'GET', `/works/${oldWork.id}`)).content_format).toBe('long_article')
  expect((await api(page, 'GET', `/works/${newWork.id}`)).content_format).toBe('micro_post')
  expect((await api(page, 'GET', '/accounts')).find((item: { id: string }) => item.id === account.id).content_format).toBe('long_article')
})

test('D-132 设置链接不切换账号；顶部平台 Tab 只浏览，明确选行后才切换', async ({ page }) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '指定头条目标', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  await page.goto(`/settings/accounts?id=${other.id}`)
  await expect(settings.getByText('当前账号与此链接不一致')).toBeVisible()
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
  await settings.getByRole('button', { name: '返回并选择账号', exact: true }).click()
  await expect(settings).toHaveCount(0)
  const picker = page.getByTestId('desktop-context-menu')
  await expect(picker).toBeVisible()
  const oldUrl = page.url()
  await picker.getByRole('tab', { name: /今日头条/ }).click()
  await expect(page).toHaveURL(oldUrl)
  await picker.getByRole('tabpanel').getByRole('button', { name: other.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${other.id}$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText(other.name)

  await page.goto(`/settings/accounts?id=${other.id}`)
  await expect(settings.getByText(other.name, { exact: true })).toBeVisible()
  await expect(settings.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: '打开头条官方登录页', exact: true })).toBeVisible()
})

test('D-132 无效或跨工作区设置链接不展示目标账号信息', async ({ page, browser }) => {
  const current = await registerAccount(page)
  const foreignPage = await browser.newPage()
  const foreign = await registerAccount(foreignPage, '长图文', 'wechat_mp', `foreign-${Date.now()}`)
  await api(foreignPage, 'PATCH', `/accounts/${foreign.id}`, { name: '另一工作区的公众号' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)
  const settings = page.getByTestId('desktop-settings-window')

  for (const id of [foreign.id, 'not-a-valid-account-id']) {
    await page.goto(`/settings/accounts?id=${id}`)
    await expect(settings.getByText('当前账号与此链接不一致')).toBeVisible()
    await expect(settings.getByText('另一工作区的公众号', { exact: true })).toHaveCount(0)
    await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('heading', { name: '公众号开发者凭证', exact: true })).toHaveCount(0)
  }

  await page.reload()
  await expect(settings.getByText('当前账号与此链接不一致')).toBeVisible()
  await expect(settings.getByText('另一工作区的公众号', { exact: true })).toHaveCount(0)
  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)

  await page.goto(`/settings/accounts?id=${current.id}`)
  await expect(settings.getByText(current.name, { exact: true })).toBeVisible()
  await expect(settings.getByText('另一工作区的公众号', { exact: true })).toHaveCount(0)
  await foreignPage.close()
})

test('D-132 旧账号搜索入口转到顶部选择器并清理旧参数', async ({ page }) => {
  const current = await registerAccount(page)
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)
  await page.goto('/settings/accounts?q=1')

  await expect(page).toHaveURL(new RegExp(`/a/${current.id}$`))
  await expect(page.getByTestId('desktop-settings-window')).toHaveCount(0)
  const picker = page.getByTestId('desktop-context-menu')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('tablist', { name: '账号平台' })).toBeVisible()
  await expect(picker.getByPlaceholder('搜索账号名称或平台')).toHaveCount(0)
})

test('D-132 切换账号前保护当前资料草稿', async ({ page }) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '切换目标头条号', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  await name.fill('不应带到另一个账号的草稿')
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  const discard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('不应带到另一个账号的草稿')

  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
    .getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/a/${current.id}$`))

  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tab', { name: /今日头条/ }).click()
  await picker.getByRole('tabpanel').getByRole('button', { name: other.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${other.id}$`))
  await page.goto(`/settings/accounts?id=${other.id}`)
  await expect(page.getByTestId('desktop-settings-window').getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(other.name)
  expect((await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).name).toBe(current.name)
})

test('D-132 同平台多账号只能通过顶部明确选择切换', async ({ page }) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '同平台第二个账号', content_format: 'image_note', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  await expect(picker.getByRole('tab', { name: /小红书 2/ })).toBeVisible()
  await expect(picker.getByRole('tabpanel').getByRole('button', { name: other.name, exact: true })).toBeVisible()
  await picker.getByRole('tabpanel').getByRole('button', { name: other.name, exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/a/${other.id}$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText(other.name)
  await page.goto(`/settings/accounts?id=${other.id}`)
  await expect(settings.getByText(other.name, { exact: true })).toBeVisible()
  await expect(settings.getByText(current.name, { exact: true })).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '关闭设置', exact: true })).toBeVisible()
})

test('D-132 只有停用账号时仍可从顶部找到并恢复', async ({ page }) => {
  const account = await registerAccount(page)
  await api(page, 'POST', `/accounts/${account.id}/disable`, {})
  await desktopMode(page)
  await page.goto('/settings/accounts')

  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings.getByText('请先在头像菜单选择账号', { exact: true })).toBeVisible()
  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)
  await settings.getByRole('button', { name: '返回并选择账号', exact: true }).click()
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tab', { name: /小红书/ }).click()
  await picker.getByText('已停用 1', { exact: true }).click()
  await picker.getByRole('button', { name: /浏览器验收号 已停用/ }).click()

  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveValue(account.name)
  await settings.locator('.desktop-account-actions details > summary').click()
  const enabled = page.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/enable`) && response.request().method() === 'POST')
  await settings.getByRole('button', { name: '重新启用', exact: true }).click()
  expect((await enabled).ok()).toBeTruthy()
  await expect(settings.getByText('使用中', { exact: true })).toBeVisible()
  await expect(page.locator('.desktop-statusbar-context')).toContainText(account.name)
})

test('D-132 删除最后一个账号后显示无账号中性态', async ({ page }) => {
  const account = await registerAccount(page)
  await desktopMode(page)
  await openCurrentSettings(page, account.id, account.name)
  const settings = page.getByTestId('desktop-settings-window')

  await settings.locator('.desktop-account-actions details > summary').click()
  await settings.getByRole('button', { name: '删除当前账号', exact: true }).click()
  const confirm = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '确认删除', exact: true }) })
  await confirm.getByRole('button', { name: '确认删除', exact: true }).click()

  await expect(settings.getByText('当前工作区还没有平台账号', { exact: true })).toBeVisible()
  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '打开账号入口', exact: true })).toBeVisible()
  expect(await api(page, 'GET', '/accounts')).toHaveLength(0)
})

test('D-132 创建网络失败保留表单，重试只创建一个账号', async ({ page }) => {
  const response = await page.request.post('/api/v1/auth/register', {
    data: { username: `d132-create-retry-${Date.now()}`, password: 'local-e2e-password-123' },
  })
  expect(response.ok()).toBeTruthy()
  await desktopMode(page)
  await page.goto('/settings/accounts')
  await page.getByRole('button', { name: '打开账号入口', exact: true }).click()
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tab', { name: /今日头条/ }).click()
  await picker.getByRole('button', { name: '添加今日头条账号', exact: true }).click()
  const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  const name = add.getByLabel('账号名称')
  await name.fill('失败后保留的头条账号')

  let posts = 0
  await page.route('**/api/v1/accounts', async (route) => {
    if (route.request().method() === 'POST') {
      posts++
      if (posts === 1) {
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  await add.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(add).toBeVisible()
  await expect(name).toHaveValue('失败后保留的头条账号')
  await expect(add.getByRole('button', { name: '添加账号', exact: true })).toBeEnabled()
  expect(posts).toBe(1)

  const created = page.waitForResponse((result) => result.url().endsWith('/api/v1/accounts') && result.request().method() === 'POST' && result.ok())
  await add.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json() as { id: string; platform: string }
  expect(account.platform).toBe('toutiao')
  expect(posts).toBe(2)
  const accounts = await api(page, 'GET', '/accounts')
  expect(accounts.filter((item: { name: string }) => item.name === '失败后保留的头条账号')).toHaveLength(1)
})

test('D-132 创建响应返回前上下文变化时不切换当前账号或保存新选择', async ({ page }) => {
  const current = await registerAccount(page)
  await desktopMode(page)
  await page.goto(`/a/${current.id}`)
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const userId = me.user_id ?? me.username
  const preferenceKey = `ops.currentAccount.v2:${userId}:${me.workspace.id}`
  await expect(page.locator('.desktop-statusbar-context')).toContainText(current.name)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe(current.id)
  const selectedBefore = await page.evaluate((key) => localStorage.getItem(key), preferenceKey)
  const routeBefore = new URL(page.url()).pathname

  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByTitle('添加账号').click()
  const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await add.getByLabel('账号名称').fill('上下文变化期间创建的账号')

  let markPosted!: () => void
  const posted = new Promise<void>((resolve) => { markPosted = resolve })
  let releasePost!: () => void
  const holdPost = new Promise<void>((resolve) => { releasePost = resolve })
  let posts = 0
  await page.route('**/api/v1/accounts', async (route) => {
    if (route.request().method() === 'POST') {
      posts++
      markPosted()
      await holdPost
    }
    await route.continue()
  })
  await add.getByRole('button', { name: '添加账号', exact: true }).click()
  await posted

  await page.route('**/api/v1/auth/me', async (route) => {
    const changed = {
      ...me,
      user_id: 'd132-changed-user',
      username: 'd132-changed-user',
      workspace: { ...me.workspace, id: '00000000-0000-4000-8000-000000000132', name: '已切换工作区' },
    }
    await route.fulfill({ status: 200, json: changed })
  })
  const changedContext = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/me') && response.ok(), { timeout: 10_000 })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('visibilitychange'))
  })
  await changedContext
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe(selectedBefore)

  releasePost()
  await expect(page.getByText('账号已创建，但当前工作区已变化；请在原工作区重新选择账号。')).toBeVisible()
  await expect.poll(() => new URL(page.url()).pathname).toBe(routeBefore)
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe(selectedBefore)
  const accounts = await api(page, 'GET', '/accounts')
  expect(accounts.filter((item: { name: string }) => item.name === '上下文变化期间创建的账号')).toHaveLength(1)
  expect(posts).toBe(1)
})

test('D-132 创建成功后账号列表刷新失败仍采用创建回执且不重复创建', async ({ page }) => {
  const response = await page.request.post('/api/v1/auth/register', {
    data: { username: `d132-create-refresh-${Date.now()}`, password: 'local-e2e-password-123' },
  })
  expect(response.ok()).toBeTruthy()
  await desktopMode(page)
  await page.goto('/settings/accounts')
  await page.getByRole('button', { name: '打开账号入口', exact: true }).click()
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tab', { name: /小红书/ }).click()
  await picker.getByTitle('添加账号').click()
  const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await add.getByLabel('账号名称').fill('刷新失败仍采用回执')

  let posts = 0
  let accountReads = 0
  await page.route('**/api/v1/accounts', async (route) => {
    if (route.request().method() === 'POST') {
      posts++
      await route.continue()
      return
    }
    if (route.request().method() === 'GET') {
      accountReads++
      await route.fulfill({ status: 500, json: { error: { code: 'internal', message: '测试账号列表刷新失败' } } })
      return
    }
    await route.continue()
  })
  const createdResponse = page.waitForResponse((result) => result.url().endsWith('/api/v1/accounts') && result.request().method() === 'POST' && result.ok())
  await add.getByRole('button', { name: '添加账号', exact: true }).click()
  const created = await (await createdResponse).json() as { id: string; name: string }
  await expect(page).toHaveURL(new RegExp(`/a/${created.id}/profile\\?wizard=1$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText('刷新失败仍采用回执')
  expect(accountReads).toBeGreaterThan(0)
  expect(posts).toBe(1)
  expect((await api(page, 'GET', '/accounts')).filter((item: { name: string }) => item.name === created.name)).toHaveLength(1)
})

test('D-132 无账号工作区显示中性态，所有者可从顶部创建首个账号', async ({ page }) => {
  const response = await page.request.post('/api/v1/auth/register', {
    data: { username: `d132-empty-${Date.now()}`, password: 'local-e2e-password-123' },
  })
  expect(response.ok()).toBeTruthy()
  await desktopMode(page)
  await page.goto('/settings/accounts')

  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings.getByText('当前工作区还没有平台账号', { exact: true })).toBeVisible()
  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)
  await settings.getByRole('button', { name: '打开账号入口', exact: true }).click()
  const picker = page.getByTestId('desktop-context-menu')
  await expect(picker).toBeVisible()
  await picker.getByRole('tab', { name: /今日头条/ }).click()
  await picker.getByRole('button', { name: '添加今日头条账号', exact: true }).click()

  const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(add.getByText('今日头条', { exact: true })).toBeVisible()
  const rejected = page.waitForResponse((result) => result.url().endsWith('/api/v1/accounts') && result.request().method() === 'POST')
  await add.getByRole('button', { name: '添加账号', exact: true }).click()
  expect((await rejected).status()).toBe(422)
  await expect(add.getByText('请填写账号名称', { exact: true })).toBeVisible()
  await add.getByLabel('账号名称').fill('取消后不应创建的账号')
  await page.keyboard.press('Escape')
  await expect(add).toHaveCount(0)
  expect(await api(page, 'GET', '/accounts')).toHaveLength(0)

  await openDesktopAccountSwitcher(page)
  const reopenedPicker = page.getByTestId('desktop-context-menu')
  await reopenedPicker.getByRole('tab', { name: /今日头条/ }).click()
  await reopenedPicker.getByRole('button', { name: '添加今日头条账号', exact: true }).click()
  const reopenedAdd = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await reopenedAdd.getByLabel('账号名称').fill('首个头条运营账号')
  const created = page.waitForResponse((result) => result.url().endsWith('/api/v1/accounts') && result.request().method() === 'POST')
  await reopenedAdd.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json() as { id: string; platform: string }
  expect(account.platform).toBe('toutiao')
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/profile\\?wizard=1$`))
  const wizard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '从过往作品生成档案', exact: true }) })
  await expect(wizard).toBeVisible()
  await wizard.getByRole('button', { name: '跳过，手动填写', exact: true }).click()
  await expect(wizard).toHaveCount(0)
})

test('D-132 无当前账号时关闭平台设置进入中性页面', async ({ page }) => {
  await registerAccount(page)
  await desktopMode(page)
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ops.currentAccount.v2:')) localStorage.removeItem(key)
    }
  })
  await page.goto('/settings/accounts')

  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings.getByText('请先在头像菜单选择账号', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(/\/images$/)
})

test('D-132 删除当前账号后不自动显示其他账号', async ({ page }) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '删除后仍须手动选择的账号', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  await settings.locator('.desktop-account-actions details > summary').click()
  await settings.getByRole('button', { name: '删除当前账号', exact: true }).click()
  const confirm = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '确认删除', exact: true }) })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '确认删除', exact: true }).click()

  await expect(settings.getByText('请先在头像菜单选择账号', { exact: true })).toBeVisible()
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
  await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toHaveCount(0)
  const accounts = await api(page, 'GET', '/accounts')
  expect(accounts.some((account: { id: string }) => account.id === current.id)).toBe(false)
  expect(accounts.some((account: { id: string }) => account.id === other.id)).toBe(true)

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/a/${current.id}$`))
  await expect(page.getByRole('heading', { name: '当前账号不可用', exact: true })).toBeVisible()
  await expect(page.getByText(other.name, { exact: true })).toHaveCount(0)
})

test('D-132 观察者只能查看当前账号，账号操作接口仍拒绝写入', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1 })
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const response = await context.request.post('/api/v1/auth/register', { data: { username: `d132-viewer-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code } })
    expect(response.ok()).toBeTruthy()
    const member = await context.newPage()
    await desktopMode(member)
    await member.goto(`/a/${account.id}`)
    await expect(member.locator('.desktop-statusbar-context')).toContainText(account.name)
    await member.goto(`/settings/accounts?id=${account.id}`)

    const settings = member.getByTestId('desktop-settings-window')
    await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toBeDisabled()
    await expect(settings.getByRole('button', { name: '保存信息', exact: true })).toHaveCount(0)
    await settings.locator('.desktop-account-actions details > summary').click()
    await expect(settings.getByRole('button', { name: '停用当前账号', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: '删除当前账号', exact: true })).toHaveCount(0)

    await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await openDesktopAccountSwitcher(member)
    const picker = member.getByTestId('desktop-context-menu')
    await expect(picker.getByTitle('添加账号')).toHaveCount(0)
    const me = await api(member, 'GET', '/auth/me')
    const denied = await context.request.post(`/api/v1/accounts/${account.id}/disable`, { headers: { 'X-CSRF-Token': me.csrf_token } })
    expect(denied.status()).toBe(403)
  } finally {
    await context.close()
  }
})

test('D-132 连接读取失败显示错误；头条不请求尚未支持的连接接口', async ({ page }) => {
  const xhs = await registerAccount(page)
  const toutiao = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '头条人工回填账号', content_format: 'micro_post', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, xhs.id, xhs.name)
  await page.route(`**/api/v1/accounts/${xhs.id}/platform-connection`, (route) => route.fulfill({ status: 500, json: { error: { code: 'internal', message: '连接读取测试故障' } } }))
  await page.reload()
  await expect(page.getByText('平台连接状态读取失败')).toBeVisible()
  await expect(page.getByText('连接读取测试故障')).toBeVisible()
  await expect(page.getByText('尚未连接。登录平台账号后需要本人核对稳定身份；登录不会自动同步历史作品。')).toHaveCount(0)

  const settings = page.getByTestId('desktop-settings-window')
  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  await name.fill('连接重试时保留的资料草稿')
  await page.unroute(`**/api/v1/accounts/${xhs.id}/platform-connection`)
  await settings.getByRole('button', { name: '重试', exact: true }).click()
  await expect(settings.getByText('尚未连接。登录平台账号后需要本人核对稳定身份；登录不会自动同步历史作品。')).toBeVisible()
  await expect(name).toHaveValue('连接重试时保留的资料草稿')
  await expect(settings.getByRole('button', { name: '保存信息', exact: true })).toBeEnabled()
  await settings.getByRole('button', { name: '取消修改', exact: true }).click()
  await expect(name).toHaveValue(xhs.name)

  await page.goto(`/a/${toutiao.id}`)
  let unsupportedCalls = 0
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/accounts/${toutiao.id}/platform-connection`) || request.url().includes(`/api/v1/accounts/${toutiao.id}/metrics/observations`)) unsupportedCalls++
  })
  await expect(page.locator('.desktop-statusbar-context')).toContainText(toutiao.name)
  await page.goto(`/settings/accounts?id=${toutiao.id}`)
  await expect(page.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  await expect(page.getByText(/尚未验证/)).toBeVisible()
  await page.waitForTimeout(250)
  expect(unsupportedCalls).toBe(0)
  await expect(page.getByRole('button', { name: '打开当前账号复盘与数据回填' })).toBeVisible()
})

test('D-132 公众号只显示当前号凭证与回填，窄窗下内容不溢出', async ({ page }, testInfo) => {
  const current = await registerAccount(page, '长图文', 'wechat_mp')
  const other = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '不应显示的小红书账号', content_format: 'image_note', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  const body = settings.locator('.desktop-settings-body')
  await expect(settings.getByRole('heading', { name: '公众号开发者凭证', exact: true })).toBeVisible()
  await expect(settings.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  await expect(settings.getByRole('heading', { name: '数据回填', exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: '打开当前账号复盘与数据回填', exact: true })).toBeVisible()
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)

  for (const [width, height] of [[1440, 900], [960, 640], [740, 640]]) {
    await page.setViewportSize({ width, height })
    await expect.poll(() => body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy()
    await page.screenshot({ path: testInfo.outputPath(`d132-wechat-account-${width}x${height}.png`), animations: 'disabled' })
  }
})

test('D-132 保存中阻止离开，取消未保存修改保留原值', async ({ page }) => {
  const current = await registerAccount(page)
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  await name.fill('等待中的保存')
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/v1/accounts/${current.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await pending
    await route.continue()
  })
  await settings.getByRole('button', { name: '保存信息', exact: true }).click()
  await expect(settings.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(page.getByText('正在保存设置，请稍候再离开')).toBeVisible()
  await expect(settings).toBeVisible()
  release()
  await expect(page.getByText('账号信息已保存', { exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: '保存信息', exact: true })).toBeDisabled()
  await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).name).toBe('等待中的保存')
  await page.unroute(`**/api/v1/accounts/${current.id}`)

  await name.fill('未提交的修改')
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  const discard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('未提交的修改')
  await settings.getByRole('button', { name: '取消修改', exact: true }).click()
  await expect(name).toHaveValue('等待中的保存')
})

test('D-132 停用当前账号不切到其他账号，可从顶部恢复原账号', async ({ page }) => {
  const current = await registerAccount(page)
  const other = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '不应自动切换的头条账号', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, current.id, current.name)

  const settings = page.getByTestId('desktop-settings-window')
  await settings.locator('.desktop-account-actions details > summary').click()
  await settings.getByRole('button', { name: '停用当前账号', exact: true }).click()
  const confirm = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: new RegExp(current.name) }) })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '停用', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).status).toBe('disabled')
  await expect(settings.getByText('已停用', { exact: true }).first()).toBeVisible()
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
  await expect(settings.getByText('此账号已停用，不能启动平台登录或新的采集。')).toBeVisible()

  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '当前账号已停用', exact: true })).toBeVisible()
  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  const disabledAccounts = picker.getByText('已停用 1', { exact: true })
  await expect(disabledAccounts).toBeVisible()
  await disabledAccounts.click()
  await picker.getByRole('button', { name: current.name }).click()
  await expect(settings).toBeVisible()
  await settings.locator('.desktop-account-actions details > summary').click()
  await expect(settings.getByRole('button', { name: '重新启用', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '重新启用', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', '/accounts')).find((account: { id: string }) => account.id === current.id).status).toBe('active')
  await expect(settings.getByText(other.name, { exact: true })).toHaveCount(0)
})

test('D-132 顶部按平台创建同平台账号及三平台账号，成功后明确进入新账号', async ({ page }) => {
  const initial = await registerAccount(page)
  await desktopMode(page)
  await page.goto(`/a/${initial.id}`)
  const picker = page.getByTestId('desktop-context-menu')

  const addFromTab = async (platform: '小红书' | '公众号' | '今日头条', name: string, useWorkspaceAdd = false) => {
    if (await picker.isVisible()) await page.keyboard.press('Escape')
    await openDesktopAccountSwitcher(page)
    await expect(picker).toBeVisible()
    await picker.getByRole('tab', { name: new RegExp(platform) }).click()
    if (useWorkspaceAdd) await picker.getByTitle('添加账号').click()
    else await picker.getByRole('button', { name: `添加${platform}账号`, exact: true }).click()

    const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
    await expect(add).toBeVisible()
    await expect(add.getByText(platform, { exact: true })).toBeVisible()
    await add.getByLabel('账号名称').fill(name)
    const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/accounts') && response.request().method() === 'POST')
    await add.getByRole('button', { name: '添加账号', exact: true }).click()
    const response = await created
    expect(response.ok()).toBeTruthy()
    const account = await response.json() as { id: string; platform: string; content_format: string }
    expect(account.platform).toBe(platform === '小红书' ? 'xhs' : platform === '公众号' ? 'wechat_mp' : 'toutiao')
    await expect(page).toHaveURL(new RegExp(`/a/${account.id}/profile\\?wizard=1$`))
    await expect(page.locator('.desktop-statusbar-context')).toContainText(name)
    const wizard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '从过往作品生成档案', exact: true }) })
    await expect(wizard).toBeVisible()
    await wizard.getByRole('button', { name: '跳过，手动填写', exact: true }).click()
    await expect(wizard).toHaveCount(0)
    return account
  }

  await addFromTab('小红书', '顶部创建的第二个小红书号', true)
  const wechat = await addFromTab('公众号', '顶部创建的公众号')
  expect(wechat.content_format).toBe('long_article')
  const toutiao = await addFromTab('今日头条', '顶部创建的头条号')
  expect(toutiao.content_format).toBe('long_article')
})

test('D-132 作品深链加载期间不回退到历史账号，归属校验只读取一次', async ({ page }) => {
  const previous = await registerAccount(page)
  const target = await api(page, 'POST', '/accounts', { platform: 'toutiao', name: '深链实际归属头条号', content_format: 'micro_post', type_note: '' })
  const work = await api(page, 'POST', `/accounts/${target.id}/works`, { title: '深链目标作品' })
  const me = await api(page, 'GET', '/auth/me')
  await desktopMode(page)
  await page.goto(`/a/${previous.id}`)
  await page.evaluate(({ userId, workspaceId, accountId }) => {
    localStorage.setItem(`ops.currentAccount.v2:${userId}:${workspaceId}`, accountId)
  }, { userId: me.user_id, workspaceId: me.workspace.id, accountId: previous.id })

  let workReads = 0
  let releaseWork!: () => void
  let signalWorkStarted!: () => void
  const workGate = new Promise<void>((resolve) => { releaseWork = resolve })
  const workStarted = new Promise<void>((resolve) => { signalWorkStarted = resolve })
  const accountRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/accounts/${previous.id}/`)) accountRequests.push(request.url())
  })
  await page.route(`**/api/v1/works/${work.id}`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    workReads++
    signalWorkStarted()
    await workGate
    await route.continue()
  })

  await page.goto(`/works/${work.id}`)
  await workStarted
  const switcher = page.locator('.desktop-statusbar-context')
  await expect(switcher).toBeVisible()
  await expect(switcher).not.toContainText(previous.name)
  await expect(page.getByRole('button', { name: '在本机扫码登录' })).toHaveCount(0)
  expect(accountRequests).toEqual([])
  releaseWork()
  await expect(switcher).toContainText(target.name)
  await expect(page.getByText('深链目标作品', { exact: true }).first()).toBeVisible()
  expect(workReads).toBe(1)
  expect(accountRequests).toEqual([])
})

test('D-132 切换当前账号后迟到的平台连接响应不会写入新账号卡片', async ({ page }) => {
  const previous = await registerAccount(page)
  const target = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '迟到响应目标账号', content_format: 'image_note', type_note: '' })
  await desktopMode(page)
  await page.goto(`/a/${previous.id}`)
  await expect(page.locator('.desktop-statusbar-context')).toContainText(previous.name)

  let releaseConnection!: () => void
  let connectionRequestStarted = false
  const connectionGate = new Promise<void>((resolve) => { releaseConnection = resolve })
  await page.route(`**/api/v1/accounts/${previous.id}/platform-connection`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    connectionRequestStarted = true
    await connectionGate
    try {
      await route.fulfill({ json: { connection: {
        external_account_key: '旧账号迟到连接', availability: 'ready', is_holder: true, state: 'active',
        auto_collect: false, auto_adopt: false, platform_consent_version: 1,
        last_verified_at: null, next_due_at: null, failure_count: 0,
        authorization_revision: 0, adoption_revision: 0,
      } } })
    } catch { /* 切换账号会主动取消旧账号的读取请求。 */ }
  })

  await page.goto(`/settings/accounts?id=${previous.id}`)
  await expect.poll(() => connectionRequestStarted, { timeout: 15_000 }).toBe(true)
  const settings = page.getByTestId('desktop-settings-window')
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await openDesktopAccountSwitcher(page)
  const picker = page.getByTestId('desktop-context-menu')
  await picker.getByRole('tabpanel').getByRole('button', { name: target.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${target.id}$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText(target.name)
  await page.goto(`/settings/accounts?id=${target.id}`)
  await expect(settings.getByText('尚未连接。登录平台账号后需要本人核对稳定身份；登录不会自动同步历史作品。')).toBeVisible()
  releaseConnection()
  await page.waitForTimeout(100)
  await expect(settings.getByText('旧账号迟到连接', { exact: true })).toHaveCount(0)
  await expect(settings.getByText(target.name, { exact: true })).toBeVisible()
})

test('D-132 编辑者的账号设置只读且账号写接口拒绝直接调用', async ({ page, browser }) => {
  const account = await registerAccount(page)
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 })
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const response = await context.request.post('/api/v1/auth/register', { data: { username: `d132-editor-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code } })
    expect(response.ok()).toBeTruthy()
    const member = await context.newPage()
    await desktopMode(member)
    await member.goto(`/a/${account.id}`)
    await expect(member.locator('.desktop-statusbar-context')).toContainText(account.name)
    await member.goto(`/settings/accounts?id=${account.id}`)

    const settings = member.getByTestId('desktop-settings-window')
    await expect(settings.getByRole('textbox', { name: '账号名称', exact: true })).toBeDisabled()
    await expect(settings.getByRole('button', { name: '保存信息', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: '修改类型', exact: true })).toHaveCount(0)
    await settings.locator('.desktop-account-actions details > summary').click()
    await expect(settings.getByRole('button', { name: '停用当前账号', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: '删除当前账号', exact: true })).toHaveCount(0)

    const me = await (await context.request.get('/api/v1/auth/me')).json()
    const denied = await context.request.patch(`/api/v1/accounts/${account.id}`, {
      data: { name: '编辑者不应能修改' }, headers: { 'X-CSRF-Token': me.csrf_token },
    })
    expect(denied.status()).toBe(403)
    const stillOriginal = await (await context.request.get(`/api/v1/accounts/${account.id}`)).json()
    expect(stillOriginal.name).toBe(account.name)
  } finally {
    await context.close()
  }
})

test('D-132 编辑者与观察者不能绕过界面写入平台账号管理接口', async ({ page, browser }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')

  for (const role of ['editor', 'viewer'] as const) {
    const invite = await api(page, 'POST', '/workspaces/current/invites', { role, max_uses: 1 })
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const joined = await context.request.post('/api/v1/auth/register', {
        data: { username: `d132-${role}-account-writes-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code },
      })
      expect(joined.ok(), `${role} 邀请注册`).toBeTruthy()
      const me = await (await context.request.get('/api/v1/auth/me')).json()
      const headers = { 'X-CSRF-Token': me.csrf_token }
      const accountPath = `/api/v1/accounts/${account.id}`
      const attempts = [
        ['PATCH', accountPath, { name: `${role} 不应写入` }],
        ['POST', `${accountPath}/disable`, undefined],
        ['POST', `${accountPath}/enable`, undefined],
        ['DELETE', `${accountPath}?confirm=true`, undefined],
        ['PUT', `${accountPath}/wechat-credential`, { app_id: 'e2e-only', app_secret: 'e2e-only-not-a-secret' }],
        ['POST', `${accountPath}/wechat-credential/test`, undefined],
        ['POST', '/api/v1/accounts', { platform: 'toutiao', name: '未授权创建', content_format: 'long_article', type_note: '' }],
      ] as const

      for (const [method, path, data] of attempts) {
        const response = await context.request.fetch(path.startsWith('/api/v1/') ? path : `/api/v1${path}`, {
          method,
          ...(data ? { data } : {}),
          headers,
        })
        expect(response.status(), `${role} ${method} ${path}`).toBe(403)
      }

      const unchanged = await (await context.request.get(accountPath)).json()
      expect(unchanged.name).toBe(account.name)
      expect(unchanged.status).toBe('active')
      const ownerAccounts = await api(page, 'GET', '/accounts')
      expect(ownerAccounts.some((item: { name: string }) => item.name === '未授权创建')).toBe(false)
    } finally {
      await context.close()
    }
  }
})

test('D-132 连接读取启动后稳定，不产生重复观测或自动采集请求', async ({ page }) => {
  const account = await registerAccount(page)
  await desktopMode(page)
  const reads = { connection: 0, policy: 0, observations: 0, collect: 0, writes: 0 }
  page.on('request', (request) => {
    const url = request.url()
    if (request.method() === 'GET' && url.includes(`/api/v1/accounts/${account.id}/platform-connection`)) reads.connection++
    if (request.method() === 'GET' && url.endsWith('/api/v1/platform-collection/policy')) reads.policy++
    if (request.method() === 'GET' && url.includes(`/api/v1/accounts/${account.id}/metrics/observations`)) reads.observations++
    if (request.method() === 'POST' && url.includes(`/api/v1/accounts/${account.id}/platform-sync`)) reads.collect++
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()) && url.includes(`/api/v1/accounts/${account.id}/platform-connection`)) reads.writes++
  })

  await page.goto(`/a/${account.id}`)
  await expect(page.locator('.desktop-statusbar-context')).toContainText(account.name)
  await page.goto(`/settings/accounts?id=${account.id}`)
  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings.getByRole('heading', { name: '平台登录与同步', exact: true })).toBeVisible()
  await expect(settings.getByText('尚未连接。登录平台账号后需要本人核对稳定身份；登录不会自动同步历史作品。')).toBeVisible()
  await page.waitForTimeout(1200)

  expect(reads.connection).toBeGreaterThanOrEqual(1)
  expect(reads.connection).toBeLessThanOrEqual(2)
  expect(reads.policy).toBe(1)
  expect(reads.observations).toBe(0)
  expect(reads.collect).toBe(0)
  expect(reads.writes).toBe(0)
  const initial = { ...reads }
  await page.waitForTimeout(1200)
  expect(reads).toEqual(initial)
})

test('D-132 当前账号的数据回填与作品入口跳转到同一账号', async ({ page }) => {
  const account = await registerAccount(page, '文章', 'toutiao')
  const other = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '不能被当前入口误跳的账号', content_format: 'long_article', type_note: '' })
  await desktopMode(page)
  await openCurrentSettings(page, account.id, account.name)

  const settings = page.getByTestId('desktop-settings-window')
  const openedPaths: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/v1/accounts/')) openedPaths.push(request.url())
  })
  await settings.getByRole('button', { name: '打开当前账号复盘与数据回填', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/review$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText(account.name)
  await expect(page.getByText(other.name, { exact: true })).toHaveCount(0)

  await page.goto(`/settings/accounts?id=${account.id}`)
  const name = settings.getByRole('textbox', { name: '账号名称', exact: true })
  await name.fill('取消离开后保留的资料草稿')
  await settings.getByRole('button', { name: '打开当前账号复盘与数据回填', exact: true }).click()
  const discard = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '放弃未保存的设置？', exact: true }) })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/settings/accounts\\?id=${account.id}$`))
  await expect(name).toHaveValue('取消离开后保留的资料草稿')
  await settings.getByRole('button', { name: '打开当前账号复盘与数据回填', exact: true }).click()
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/review$`))

  await page.goto(`/settings/accounts?id=${account.id}`)
  await expect(name).toHaveValue(account.name)
  await settings.getByRole('button', { name: '打开当前账号作品', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/works$`))
  await expect(page.locator('.desktop-statusbar-context')).toContainText(account.name)
  expect(openedPaths.some((url) => url.includes(`/api/v1/accounts/${other.id}/`))).toBe(false)
})
