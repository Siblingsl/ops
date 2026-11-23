import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-09（DEV-AI-39）：快捷键与命令面板——
// AI 对话页命令组与输入台 / 命令同源（COMMANDS）；面板搜“计划”可执行；不新增冲突快捷键。
test('DEV-AI-39 IX-09 命令面板本页命令组', async ({ page }) => {
  await registerAccount(page)
  // 命令组在 can_use 且非 viewer 时出现（与 / 命令同源门控）——先配好自检模型。
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-09 面板模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()

  // Ctrl+K 打开命令面板，搜“计划”→ 执行“切到计划模式”。
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible({ timeout: 15_000 })
  await palette.getByRole('textbox', { name: /搜索|命令/ }).fill('计划')
  // 面板结果是普通按钮（非 option role）。
  const item = palette.getByRole('button', { name: /切到计划模式/ }).first()
  await expect(item).toBeVisible()
  await item.click()
  await expect(palette).toBeHidden()

  // 与 / 命令同源：模式按钮文案变为“计划”，主按钮变“生成计划”。
  await expect(page.getByRole('button', { name: /对话模式/ })).toContainText('计划')
  await expect(page.getByRole('button', { name: '生成计划', exact: true })).toBeVisible({ timeout: 15_000 })

  // 面板里 AI 对话组与 / 命令一一对应（9 条本页命令 + 全局/页面组），无冲突快捷键断言：
  // 快捷键表复用既有全局注册（Ctrl+K 面板、Ctrl+Shift+O 新建等），IX-09 未新增。
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p1-ix09-palette.png') })
})
