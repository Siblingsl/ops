import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { desktopSettingsLabel, settingsEntries, settingsGroupOf } from '../src/lib/settings-registry'

export async function electronLocalSettingsEvaluate<T>(app: ElectronApplication, source: string): Promise<T> {
  return await app.evaluate(async ({ webContents }, script) => {
    const view = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith('ops-desktop://settings/embedded/'))
    if (!view) throw new Error('找不到统一设置中的本机面板')
    return view.executeJavaScript(script)
  }, source) as T
}

export function electronLocalSettingsClick(app: ElectronApplication, selector: string) {
  return electronLocalSettingsEvaluate<boolean>(app,
    `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('缺少本机设置控件：'+${JSON.stringify(selector)});element.click();return true})()`)
}

export function electronLocalSettingsSetValue(app: ElectronApplication, selector: string, value: string) {
  return electronLocalSettingsEvaluate<boolean>(app,
    `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('缺少本机设置控件：'+${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`)
}

export function electronLocalSettingsReadStatus(app: ElectronApplication) {
  return electronLocalSettingsEvaluate<string>(app, `document.querySelector('#action-status')?.textContent ?? ''`)
}

/**
 * 本机设置是 WebContentsView，切换面板时主进程才异步 loadURL
 * （desktop/src/settings-view.ts 的 show()：`if (panelChanged) await view.webContents.loadURL(...)`）。
 * 点完设置项立刻读 DOM 会读到上一个面板，所以先等这个面板的 webContents 真的出现。
 */
export async function electronLocalSettingsWaitPanel(app: ElectronApplication, panel: string) {
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL())))
    .toContain(`ops-desktop://settings/embedded/${panel}`)
  // URL 与初始 DOM 先出现；初始 IPC 读取完成后页面才解除 inert。
  // executeJavaScript 的 .click() 会绕过用户点击的 inert 限制，不能提前操作。
  await expect.poll(() => electronLocalSettingsEvaluate<boolean>(app,
    `document.body.dataset.embeddedPanel === ${JSON.stringify(panel)} && document.querySelector('#settings-content')?.inert === false`))
    .toBe(true)
}

/**
 * 本机设置的「忙」状态会挡住切换面板：业务窗收到 busy 时，离开面板前会弹
 * 「正在保存设置，请稍候再离开」并把 URL 退回去（web/src/layout/DesktopSettingsHost.tsx 的 askBeforeLeaving）。
 * settings.js 里 busy 由 `activeOperations > 0 || externalBusy` 决定，两个都是脚本顶层变量，
 * 可以直接在面板里读到。切面板前等它空闲，避免把「产品正确地拦住」当成失败。
 */
export async function electronLocalSettingsWaitIdle(app: ElectronApplication) {
  await expect.poll(() => electronLocalSettingsEvaluate<{ operations: number; external: boolean }>(app,
    `({operations:activeOperations,external:externalBusy})`))
    .toEqual({ operations: 0, external: false })
}

export async function api(page: Page, method: string, path: string, data?: unknown) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.fetch('/api/v1' + path, { method, data, headers: { 'X-CSRF-Token': me.csrf_token } })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.json()
}

/**
 * GL-02：设置分组只在 `src/lib/settings-registry.ts` 维护一份事实源。
 * 这里按设置窗的显示名反查条目，再用与 `DesktopSettingsHost` 相同的规则推导分组，
 * 不再维护第四份「设置名 → 分组」映射。
 */
export function desktopSettingGroup(name: string) {
  const entry = settingsEntries.find((item) => desktopSettingsLabel(item) === name)
  if (!entry) throw new Error(`缺少设置项：${name}`)
  return settingsGroupOf(entry)
}

export async function selectDesktopSetting(page: Page, name: string) {
  const nav = page.getByTestId('desktop-settings-window').getByRole('navigation', { name: '设置分类' })
  const item = nav.getByRole('button', { name, exact: true })
  if (!(await item.isVisible())) {
    const group = nav.getByRole('button', { name: desktopSettingGroup(name), exact: true })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  }
  await item.click()
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
 * 桌面端设置窗口会用 `?id=` 与「本机记住的当前账号」比对，不一致就只显示提示卡片。
 * 验收脚本里直接把偏好写到目标账号，避免依赖上一页 React 副作用写入的时机。
 */
export async function preferDesktopAccount(page: Page, accountId: string) {
  const me = await api(page, 'GET', '/auth/me')
  const key = `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`
  await page.evaluate(({ key: storageKey, id }) => localStorage.setItem(storageKey, id), { key, id: accountId })
}

export async function createOutline(page: Page) {
  await page.getByRole('button', { name: '新建作品', exact: true }).first().click()
  // NW-A1：所有入口都先打开同一个创建面板；标题可留空，直接开始创作。
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '新建作品', exact: true }) })
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '开始创作', exact: true }).click()
  await page.waitForURL(/\/works\/[a-f0-9-]+$/)
  const id = page.url().split('/').pop()!
  const desktopPresentation = await page.locator('html').getAttribute('data-presentation') === 'ops-creative-desktop'
  if (desktopPresentation) await page.getByTestId('desktop-editor-steps').getByRole('link', { name: '大纲', exact: true }).click()
  const outlineDialog = desktopPresentation
    ? page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '生成与确认大纲', exact: true }) })
    : page.locator('body')
  if (desktopPresentation) await expect(outlineDialog).toBeVisible()
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await expect(outlineDialog.getByRole('button', { name: 'AI 生成大纲', exact: true })).toBeDisabled()
  await viewpoint.fill('少而精的步骤更容易长期坚持，这是我的经验判断。')
  await viewpoint.blur()
  await outlineDialog.getByRole('button', { name: 'AI 生成大纲', exact: true }).click()
  await expect(outlineDialog.getByRole('button', { name: '确认大纲', exact: true })).toBeVisible()
  if (desktopPresentation) {
    const panel = await outlineDialog.boundingBox()
    expect(panel!.y).toBeGreaterThan(40)
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
  }
  await expect(page.getByRole('button', { name: '起草本段', exact: true })).toHaveCount(0)
  await outlineDialog.getByRole('button', { name: '确认大纲', exact: true }).click()
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
