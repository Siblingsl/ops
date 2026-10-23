import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'

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

export async function api(page: Page, method: string, path: string, data?: unknown) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.fetch('/api/v1' + path, { method, data, headers: { 'X-CSRF-Token': me.csrf_token } })
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy()
  return response.json()
}

const desktopSettingGroups: Record<string, string> = {
  '偏好设置': '个人', '登录与安全': '个人',
  '平台账号与凭证': '当前账号',
  '成员与邀请': '工作区', '服务器模型': '工作区', '桌面 AI 策略': '工作区', '智能体设置': '工作区', 'AI 用量与成本': '工作区',
  '敏感词库': '工作区', '热点来源': '工作区', '每日推荐设置': '工作区', '邀请邮件': '工作区',
  '数据导出': '数据与工具', '完整用量报表': '数据与工具', 'AI 质量看板': '数据与工具',
  '提示词模板与测试集': '数据与工具', '操作日志': '数据与工具', '回收站': '数据与工具',
  '系统管理': '数据与工具', '热点采集与日志': '数据与工具',
  '客户端连接': '本机与系统', '本机 AI 配置': '本机与系统', '账号与设备': '本机与系统', '诊断与关于': '本机与系统',
}

export async function selectDesktopSetting(page: Page, name: string) {
  const nav = page.getByTestId('desktop-settings-window').getByRole('navigation', { name: '设置分类' })
  const item = nav.getByRole('button', { name, exact: true })
  if (!(await item.isVisible())) {
    const groupName = desktopSettingGroups[name]
    if (!groupName) throw new Error(`缺少设置分类映射：${name}`)
    const group = nav.getByRole('button', { name: groupName, exact: true })
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
