import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function plansQuestionsJourney(page: Page, baseURL: string, screenshot: string) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw07-flow-${Date.now()}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  const account = await api(page, 'POST', '/accounts', { platform: 'xhs', name: '计划问题验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW07 计划问题模型', base_url: 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) }).getByRole('button', { name: '我知道了', exact: true }).click()
  const accountButton = page.getByRole('button', { name: '选择操作账号', exact: true })
  if (await accountButton.count()) await accountButton.click()
  else await page.getByRole('button', { name: '对话设置', exact: true }).click()
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '对话设置', exact: true }) })
  await settings.getByRole('combobox', { name: '选择账号', exact: true }).selectOption(account.id)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('combobox', { name: '对话模式', exact: true }).selectOption('plan')

  const planArgs = { summary: '核对本周内容方向并形成一条可审阅建议', steps: [
    { id: 'read', title: '读取近期内容', target_ref: '当前账号近期作品', acceptance: '引用已保存的读取结果' },
    { id: 'draft', title: '形成一条内容建议', acceptance: '生成待逐张审阅的操作卡片' },
  ] }
  const questionArgs = { questions: [{ id: 'focus', title: '本次优先关注什么？', required: true,
    options: [{ id: 'reach', label: '提升触达' }, { id: 'save', label: '增加收藏' }] }] }
  const initial = `先给出计划并确认目标\n#tool present_plan ${JSON.stringify(planArgs)}\n#tool request_input ${JSON.stringify(questionArgs)}`
  const firstResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.locator('textarea').fill(initial)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await firstResponse).status()).toBe(202)
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  const awaiting = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(awaiting.last_run.status).toBe('awaiting_input')
  expect(awaiting.plans).toHaveLength(1)
  expect(awaiting.questions[0].status).toBe('pending')
  const plan = awaiting.plans[0]
  const question = awaiting.questions[0]
  const planCard = page.getByTestId(`agent-plan-${plan.id}`)
  const questionCard = page.getByTestId(`agent-question-${question.id}`)
  await expect(planCard).toContainText('仍须逐张')
  await expect(questionCard).toContainText('本次优先关注什么？')
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../../.playwright-results/${screenshot}.png`) })
  await questionCard.getByLabel('提升触达').check()
  const answerResponse = page.waitForResponse((response) => response.url().endsWith(`/agent/questions/${question.id}/answer`) && response.request().method() === 'POST')
  await questionCard.getByRole('button', { name: '提交整组回答并继续' }).click()
  expect((await answerResponse).status()).toBe(202)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).questions[0].status).toBe('answered')
  await expect(planCard.getByRole('button', { name: '按此计划继续' })).toBeEnabled()

  const acceptResponse = page.waitForResponse((response) => response.url().endsWith(`/agent/plans/${plan.id}/accept`) && response.request().method() === 'POST')
  await planCard.getByRole('button', { name: '按此计划继续' }).click()
  expect((await acceptResponse).status()).toBe(202)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).last_run.trigger).toBe('plan_accept')
  const accepted = await api(page, 'GET', `/agent/conversations/${conversationID}`)
  expect(accepted.conversation.mode).toBe('execute')
  expect(accepted.plans[0].accepted_at).not.toBeNull()
  expect(accepted.actions).toHaveLength(0)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()

  const nextQuestionArgs = { questions: [{ id: 'replace', title: '新任务还需要澄清什么？', required: true,
    options: [{ id: 'one', label: '选项一' }, { id: 'two', label: '选项二' }] }] }
  const composer = page.locator('textarea[aria-label="发送消息"], textarea[placeholder="发送消息…（Enter 发送，Shift+Enter 换行）"]')
  const sendButton = page.getByRole('button', { name: '发送', exact: true })
  // 服务端 active_run 变 null 不等于客户端这一轮流已经收尾：桌面工作台在运行中输入框仍可用，
  // 但发送键仍是禁用态。不先等 enabled 就直接 click，会卡在 actionability 上直到用例超时。
  const send = async (value: string) => {
    await composer.fill(value)
    await expect(composer).toHaveValue(value)
    await expect(sendButton).toBeEnabled({ timeout: 60_000 })
    await sendButton.click()
  }
  await send(`再次澄清\n#tool request_input ${JSON.stringify(nextQuestionArgs)}`)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).questions.length).toBe(2)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).active_run).toBeNull()
  const pending = (await api(page, 'GET', `/agent/conversations/${conversationID}`)).questions.find((item: { status: string }) => item.status === 'pending')
  await send('改为检查另一条选题')
  const supersedeDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '用这条消息替代待办问题？' }) })
  const replaceResponse = page.waitForResponse((response) => response.url().endsWith(`/agent/conversations/${conversationID}/messages`) && response.request().method() === 'POST', { timeout: 60_000 })
  await supersedeDialog.getByRole('button', { name: '替代问题并发送' }).click()
  const replaced = await replaceResponse
  expect(replaced.status()).toBe(202)
  expect(replaced.request().postDataJSON().supersede_question_id).toBe(pending.id)
  await expect.poll(async () => (await api(page, 'GET', `/agent/conversations/${conversationID}`)).questions.find((item: { id: string }) => item.id === pending.id).status).toBe('superseded')
}

test('DEV-AW07 真实Electron计划与问题恢复', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  // 一次跑完 计划 → 结构化澄清 → 接受计划 → 再次澄清 → 用新消息替代待办问题。
  test.setTimeout(240_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw07-plans-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    await plansQuestionsJourney(await app.firstWindow(), baseURL!, 'agent-workbench-aw07-plans-electron')
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw07-plans-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

