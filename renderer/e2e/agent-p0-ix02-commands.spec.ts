import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-02（DEV-AI-39）：10 条输入台命令逐条只改控件状态、不发消息；归档二次确认；新建遇草稿先确认。
test('DEV-AI-39 IX-02 十条命令只改状态、归档确认与草稿提示', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-02 验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const conversation = await api(page, 'POST', '/agent/conversations', { account_id: account.id }) as { id: string }
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, id: account.id,
  })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto(`/agent/c/${conversation.id}`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  const composer = page.getByRole('textbox', { name: '发送消息' })
  const candidates = page.locator('.agent-composer-candidates')
  const modeTrigger = page.getByRole('button', { name: /对话模式/ })
  const panel = page.getByTestId('desktop-agent-side-panel')
  let messagePosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/agent\/conversations\/[^/]+\/messages$/.test(request.url())) messagePosts += 1
  })
  const runCommand = async (name: string) => {
    await composer.fill(`/${name}`)
    await expect(candidates).toBeVisible()
    await expect(candidates.getByRole('option')).toHaveCount(1)
    await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
    await expect(candidates).toBeHidden()
  }

  // 1-3 模式：三条命令分别切到计划/讨论/执行，只改本地模式，不发送。
  await composer.fill('/')
  await expect(candidates).toBeVisible()
  await expect(candidates.getByRole('option')).toHaveCount(10)
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ix02-commands.png') })
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Escape')
  await expect(candidates).toBeHidden()
  await runCommand('plan')
  await expect(modeTrigger).toContainText('计划')
  await runCommand('discuss')
  await expect(modeTrigger).toContainText('讨论')
  await runCommand('execute')
  await expect(modeTrigger).toContainText('执行')

  // 4 模型菜单。
  await runCommand('model')
  await expect(page.getByRole('menu', { name: '选择模型' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: '选择模型' })).toBeHidden()

  // 5 上下文页。
  await runCommand('context')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: /上下文/ })).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('button', { name: '关闭任务面板' }).click()

  // 6 技能选择器。
  await runCommand('skills')
  const skillDialog = page.getByRole('dialog').filter({ hasText: '请求使用技能' })
  await expect(skillDialog).toBeVisible()
  await skillDialog.getByRole('button', { name: '关闭' }).click()
  await expect(skillDialog).toBeHidden()

  // 7 压缩：当前工作区未开启时只提示；开启时只打开预览，不发送也不伪造预览。
  await runCommand('compact')
  const bootstrap = await api(page, 'GET', '/agent/bootstrap') as { features: Record<string, boolean> }
  if (bootstrap.features.compact === true) {
    const compactDialog = page.getByRole('dialog').filter({ hasText: /压缩/ })
    await expect(compactDialog).toBeVisible()
    await compactDialog.getByRole('button', { name: '关闭' }).click()
    await expect(compactDialog).toBeHidden()
  } else {
    await expect(page.getByText('当前工作区未开启压缩。')).toBeVisible()
  }

  // 8 目标面板：切到任务页并展开，不创建目标。
  await runCommand('goal')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: /任务/ })).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('button', { name: '关闭任务面板' }).click()

  // 9 归档：必须二次确认；取消后对话仍保留。
  await runCommand('archive')
  const archiveDialog = page.getByRole('dialog').filter({ hasText: '归档这段对话？' })
  await expect(archiveDialog).toBeVisible()
  await archiveDialog.getByRole('button', { name: '取消' }).click()
  await expect(archiveDialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/agent/c/${conversation.id}$`))

  // 10 新建：有草稿时提示保留/丢弃；保留不跳转，丢弃后清空并新建。
  await composer.fill('未发送草稿 /new')
  await expect(candidates).toBeVisible()
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
  const draftDialog = page.getByRole('dialog').filter({ hasText: '当前输入还没有发送' }).last()
  await expect(draftDialog).toBeVisible()
  await draftDialog.getByRole('button', { name: '保留草稿' }).click()
  await expect(draftDialog).toBeHidden()
  await expect(composer).toHaveValue('未发送草稿 ')
  await expect(page).toHaveURL(new RegExp(`/agent/c/${conversation.id}$`))

  await composer.fill('未发送草稿 /new')
  await expect(candidates).toBeVisible()
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
  await expect(draftDialog).toBeVisible()
  await draftDialog.getByRole('button', { name: '丢弃草稿并新建' }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await expect(composer).toHaveValue('')
  expect(messagePosts).toBe(0)
})
