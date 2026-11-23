import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, registerAccount } from './support'

// 39 文档 IX-03（DEV-AI-39）：$ 技能候选、3 项上限、payload 请求与撤权后 danger。
test('DEV-AI-39 IX-03 技能候选、3 项上限、payload 与撤权', async ({ page }) => {
  const account = await registerAccount(page)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'IX-03 验收模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  }) as { id: string }
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  const suffix = Date.now().toString().slice(-5)
  const skillNames = ['A', 'B', 'C', 'D'].map((letter) => `IX03技能${letter}${suffix}`)
  const skills: Array<{ id: string; name: string }> = []
  for (const name of skillNames) {
    const skill = (await api(page, 'POST', '/skills', {
      scope: 'personal', name, summary: 'IX-03 状态与配额验收', triggers: '技能验收',
      instructions: '仅在真实加载后执行。', platforms: [], content_formats: [], task_types: [],
      task_enabled: true, agent_enabled: true, status: 'active',
    })).skill as { id: string; name: string }
    const current = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`) as { mine: { base_revision: number } }
    await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skill.id}`, {
      enabled: true, base_revision: current.mine.base_revision,
    })
    skills.push(skill)
  }
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  await page.evaluate(({ key, id }) => localStorage.setItem(key, id), {
    key: `ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, id: account.id,
  })
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
  await page.goto('/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await expect(privacy).toBeVisible()
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  await expect(privacy).toBeHidden()

  const composer = page.getByRole('textbox', { name: '发送消息' })
  const candidates = page.locator('.agent-composer-candidates')
  let messagePosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/agent\/conversations\/[^/]+\/messages$/.test(request.url())) messagePosts += 1
  })
  const chooseSkill = async (name: string) => {
    await composer.fill(`$${name}`)
    await expect(candidates).toBeVisible()
    await expect(candidates.getByRole('option', { name: new RegExp(name) })).toBeVisible()
    await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
    await expect(candidates).toBeHidden()
  }

  for (const skill of skills.slice(0, 3)) await chooseSkill(skill.name)
  await expect(page.getByText('已请求，未加载', { exact: true })).toHaveCount(3)
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-p0-ix03-skill.png') })

  await composer.fill(`$${skills[3].name}`)
  await expect(candidates).toBeVisible()
  await expect(candidates.getByRole('option', { name: new RegExp(skills[3].name) })).toBeVisible()
  await candidates.getByRole('textbox', { name: '筛选候选' }).press('Enter')
  await expect(candidates.getByRole('alert')).toHaveText('已选 3 个技能，先移除一个再添加。')
  await expect(page.getByText('已请求，未加载', { exact: true })).toHaveCount(3)
  await composer.fill('')
  await expect(candidates).toBeHidden()

  let payload: Record<string, unknown> | null = null
  await page.route(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/, async (route) => {
    payload = route.request().postDataJSON()
    await route.abort()
  })
  await composer.press('Enter')
  await expect.poll(() => payload).not.toBeNull()
  expect(payload!.skill_requests).toHaveLength(3)
  expect((payload!.skill_requests as Array<{ skill_id: string }>).map((item) => item.skill_id).sort()).toEqual(skills.slice(0, 3).map((skill) => skill.id).sort())
  // 移除 abort 拦截，让后续 run 正常发送。
  await page.unroute(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/)

  // 撤权：重新进入空对话，先选择 A，再禁用其账号绑定；发送前必须拦截并标 danger，不得发请求。
  await page.goto('/agent')
  await chooseSkill(skills[0].name)
  const currentBindings = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`) as { mine: { base_revision: number } }
  await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skills[0].id}`, {
    enabled: false, base_revision: currentBindings.mine.base_revision,
  })
  const beforeRevokedSend = messagePosts
  await composer.press('Enter')
  await expect(page.getByText('不可用，移除', { exact: true })).toBeVisible()
  await expect(page.getByText('有技能已被撤权或下架，已标为不可用；请移除后再发送。')).toBeVisible()
  expect(messagePosts).toBe(beforeRevokedSend)

  // TL-04：技能状态三态的 E2E 呈现——撤权 danger 态已在上方断言；“已请求，未加载”初始态与
  // “未装入”语义由 skillStateLabel 单测四态锁定；loaded→“已加载到模型上下文；实际使用未验证”
  // 的数据链路（load_skill 回执 → snapshot UseItem.Used → skill_usage.Loaded → 前端 label）
  // 由 Go skills_agent_test（T-SK-11 回执/幂等/预算）与 agent.go 投影测试覆盖。
  // run 后任务面板“本轮技能状态”块（requested 态真实呈现）在此验证：先恢复技能 A 绑定。
  const reenabled = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`) as { mine: { base_revision: number } }
  await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skills[0].id}`, {
    enabled: true, base_revision: reenabled.mine.base_revision,
  })
  const conv = await api(page, 'POST', '/agent/conversations', {}) as { id: string }
  await page.goto(`/agent/c/${conv.id}`)
  await chooseSkill(skills[0].name)
  await composer.fill('核对一下技能状态即可，不执行任何工具。')
  await composer.press('Enter')
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conv.id}`)).active_run, { timeout: 30_000 }).toBeNull()
  await page.locator('.desktop-agent-panel-button').first().click()
  const usageSection = page.locator('.desktop-agent-side-panel')
  // busy 占位消失（前端 SSE/查询收敛）后再断言技能状态块。
  await expect(usageSection.getByText('任务可能仍在运行，恢复连接后可继续查看')).toBeHidden({ timeout: 15_000 })
  await expect(usageSection.getByText('本对话操作卡片', { exact: false })).toBeVisible({ timeout: 15_000 })
  // “本轮技能状态”在上下文页签。
  await usageSection.getByRole('tab', { name: /^上下文/ }).click()
  await expect(usageSection.getByText('本轮技能状态', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(usageSection.getByText(/已请求，未加载/).first()).toBeVisible()
})
