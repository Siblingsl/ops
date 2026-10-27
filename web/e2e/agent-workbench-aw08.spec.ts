import { _electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function localApi(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

async function registerWorkbenchUser(page: Page, baseURL: string, desktop: boolean) {
  await page.goto(`${baseURL}/register`)
  await page.getByLabel('用户名', { exact: true }).fill(`aw08-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`)
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  if (desktop) return
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /小红书/ }).click()
  await dialog.getByLabel('账号名称').fill('AW08 验收号')
  await dialog.getByRole('radio', { name: /^图文笔记/ }).check()
  const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/accounts') && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  const account = await (await created).json()
  await page.goto(`${baseURL}/a/${account.id}`)
  await expect(page.getByRole('heading', { name: /今天写点什么/ })).toBeVisible()
}

async function prepareWorkbench(page: Page, baseURL: string, slow = false, desktop = false) {
  await registerWorkbenchUser(page, baseURL, desktop)
  const provider = await localApi(page, 'POST', '/model-providers', {
    name: `AW08 ${slow ? '慢速输入' : '产物版本'}模型`, base_url: 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key',
    models: [slow ? 'mock-slow' : 'mock-agent-tested'],
  })
  await localApi(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await localApi(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: slow ? 'mock-slow' : 'mock-agent-tested' }])
  await page.goto(`${baseURL}/agent`)
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  const bootstrap = await localApi(page, 'GET', '/agent/bootstrap')
  expect(bootstrap.features.artifacts).toBe(true)
  expect(bootstrap.features.run_control).toBe(true)
}

async function artifactVersionAndForkJourney(page: Page, screenshotName: string, desktop: boolean, baseURL: string, prepared = false) {
  if (!prepared) await prepareWorkbench(page, baseURL, false, desktop)
  const artifactTitle = `AW08 版本反馈产物 ${Date.now()}`
  const original = '原始版本：可精确引用的片段应该保持原样。'
  const edited = `${original}\n二版增补：分段反馈要重新校验。`
  const prompt = `创建一份用于版本验收的聊天草稿\n#tool present_artifact ${JSON.stringify({ title: artifactTitle, kind: 'markdown', chat_content: original })}`
  const composer = page.getByRole('textbox', { name: '发送消息' }).or(page.getByPlaceholder(/发送消息/))
  await composer.fill(prompt)
  const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect([200, 202]).toContain((await sendResponse).status())
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const sourceID = page.url().split('/').pop()!
  await expect.poll(async () => (await localApi(page, 'GET', `/agent/conversations/${sourceID}`)).active_run, { timeout: 30_000 }).toBeNull()
  const artifacts = await localApi(page, 'GET', `/agent/conversations/${sourceID}/artifacts`)
  const artifact = artifacts.items.find((item: { title: string }) => item.title === artifactTitle)
  expect(artifact, 'the model tool should persist the requested artifact').toBeTruthy()

  let panel
  if (desktop) {
    const panelToggle = page.getByRole('button', { name: '任务面板', exact: true })
    if (await panelToggle.getAttribute('aria-expanded') !== 'true') await panelToggle.click()
    panel = page.getByTestId('desktop-agent-side-panel')
    await panel.getByRole('tab', { name: '产物', exact: true }).click()
  } else {
    await page.getByRole('button', { name: '查看产物', exact: true }).click()
    panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '本对话产物', exact: true }) })
  }
  await panel.getByRole('button', { name: new RegExp(artifactTitle) }).click()
  await expect(panel.getByTestId('artifact-text-content')).toContainText(original)
  await panel.getByRole('button', { name: '编辑当前内容并保存为新版本', exact: true }).click()
  const editor = panel.getByRole('textbox', { name: '编辑产物内容' })
  await expect(editor).toBeVisible()
  await editor.fill(edited)
  const versionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/artifacts/${artifact.id}/versions` && response.request().method() === 'POST')
  const saveVersion = panel.getByRole('button', { name: '保存新版本', exact: true })
  await expect(saveVersion).toBeEnabled()
  await saveVersion.focus()
  await saveVersion.press('Enter')
  expect((await versionResponse).status()).toBe(200)
  await expect(panel.getByRole('combobox', { name: '选择产物版本' })).toHaveValue('2')
  await expect(panel.getByTestId('artifact-text-content')).toContainText('二版增补')
  await panel.getByRole('combobox', { name: '对照版本' }).selectOption('1')
  await expect(panel.getByText('v1', { exact: true }).first()).toBeVisible()
  await expect(panel.getByText('v2', { exact: true }).first()).toBeVisible()
  await panel.getByRole('combobox', { name: '选择产物版本' }).selectOption('2')

  const beforeQuote = (await localApi(page, 'GET', `/agent/conversations/${sourceID}`)).messages.length
  const quote = '可精确引用的片段'
  await panel.getByTestId('artifact-text-content').evaluate((element, phrase) => {
    const content = element.textContent ?? ''
    const start = content.indexOf(phrase)
    const node = element.firstChild
    if (start < 0 || !node) throw new Error('fixture quote was not found in the selected artifact version')
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + phrase.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, quote)
  await panel.getByRole('button', { name: '引用选段追问', exact: true }).click()
  await expect(composer).toHaveValue(/请基于引用的产物选段继续分析。/)
  await expect(page.getByText(`${artifactTitle} · v2`, { exact: true })).toBeVisible()
  expect((await localApi(page, 'GET', `/agent/conversations/${sourceID}`)).messages).toHaveLength(beforeQuote)

  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/${screenshotName}.png`) })

  const sourceDetail = await localApi(page, 'GET', `/agent/conversations/${sourceID}`)
  const promptMessage = sourceDetail.messages.find((message: { role: string; content: string }) => message.role === 'user' && message.content.includes('创建一份用于版本验收的聊天草稿'))
  if (!promptMessage) throw new Error('the user prompt must be persisted before it can be forked')
  const artifactPromptMessage = page.locator(`[data-message-seq="${promptMessage.seq}"]`)
  const sourceURL = page.url()
  const branchNavigation = page.waitForURL((url) => /\/agent\/c\/[a-f0-9-]+$/.test(url.pathname) && url.href !== sourceURL)
  await artifactPromptMessage.getByRole('button', { name: /从第 \d+ 条消息创建分支/ }).click()
  await branchNavigation
  const branchID = page.url().split('/').pop()!
  const branch = await localApi(page, 'GET', `/agent/conversations/${branchID}`)
  expect(branch.conversation.parent_id).toBe(sourceID)
  expect(branch.active_run).toBeNull()
  expect(branch.actions).toHaveLength(0)
  const cutoff = branch.conversation.fork_upto_seq ?? promptMessage.seq
  expect(cutoff).toBeLessThanOrEqual(promptMessage.seq)
  expect(branch.messages).toHaveLength(sourceDetail.messages.filter((message: { seq: number }) => message.seq <= cutoff).length)
}

async function queuedInputJourney(page: Page, screenshotName: string, baseURL: string) {
  await prepareWorkbench(page, baseURL, true, true)
  const first = `慢速输出测试\n#text ${'较慢输出。'.repeat(150)}`
  const composer = page.getByRole('textbox', { name: '发送消息' })
  await composer.fill(first)
  const sendResponse = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect([200, 202]).toContain((await sendResponse).status())
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect(page.getByRole('button', { name: '补充当前任务', exact: true })).toBeVisible({ timeout: 10_000 })
  const queuedText = '#text 排队输入已安全接收并处理。'
  await composer.fill(queuedText)
  const inputResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/agent/conversations/${conversationID}/inputs` && response.request().method() === 'POST')
  await page.getByRole('button', { name: '排到下一条', exact: true }).click()
  expect((await inputResponse).status()).toBe(202)
  await page.getByRole('button', { name: '任务面板', exact: true }).click()
  const taskPanel = page.getByTestId('desktop-agent-side-panel')
  await expect(taskPanel.getByRole('heading', { name: '补充与排队', exact: true })).toBeVisible()
  await expect(taskPanel.getByText(/排队输入已安全接收并处理。/)).toBeVisible()
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), `../.playwright-results/${screenshotName}.png`) })
  await expect.poll(async () => (await localApi(page, 'GET', `/agent/conversations/${conversationID}`)).inputs[0].status, { timeout: 30_000 }).toBe('consumed')
  await expect.poll(async () => (await localApi(page, 'GET', `/agent/conversations/${conversationID}`)).active_run, { timeout: 30_000 }).toBeNull()
  await expect(page.getByText('排队输入已安全接收并处理。', { exact: true })).toBeVisible()
}

test('DEV-AW08 Web产物版本、精确选段反馈和消息分支', async ({ page, baseURL }) => {
  await artifactVersionAndForkJourney(page, 'agent-workbench-aw08-web-artifacts', false, baseURL!)
})

test('DEV-AW08 Electron补充排队、产物反馈与分支完整路径', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw08-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await queuedInputJourney(page, 'agent-workbench-aw08-electron-queue', baseURL!)
    await artifactVersionAndForkJourney(page, 'agent-workbench-aw08-electron-artifacts', true, baseURL!, true)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw08-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
