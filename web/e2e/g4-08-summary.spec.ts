import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { api, registerAccount } from './support'

async function startSummaryModel() {
  let mode: 'short' | 'long' | 'failure' = 'short'
  const server = createServer((_request, response) => {
    if (mode === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: '本地验收模型暂不可用' } }))
      return
    }
    const summary = mode === 'long' ? Array.from({ length: 130 }, () => '长').join('') : '这篇文章梳理了从真实经历提炼观点、说明做法并检查关键边界的过程。'
    const content = JSON.stringify({ summary })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地验收模型没有可用监听地址')
  return {
    baseURL: 'http://127.0.0.1:' + address.port + '/v1',
    setMode(next: 'short' | 'long' | 'failure') { mode = next },
    close: () => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

async function createWork(page: Parameters<typeof api>[0], accountId: string) {
  const title = 'QA26 Web摘要验收 ' + Date.now()
  const work = await api(page, 'POST', '/accounts/' + accountId + '/works', { title })
  const changed = await api(page, 'PATCH', '/works/' + work.id, { viewpoint: '先从真实经历提炼结论，再按读者能执行的顺序讲清做法。', base_revision: work.revision })
  await api(page, 'PUT', '/works/' + work.id + '/outline', {
    items: [{ heading: '从经历到做法', key_point: '先说明真实背景，再给出可复用步骤', material_ids: [] }],
    confirm: true, base_revision: changed.revision,
  })
  const outlined = await api(page, 'GET', '/works/' + work.id)
  await api(page, 'PATCH', '/sections/' + outlined.sections[0].id, {
    content_md: '这是一段用于本地摘要流程验收的正文。先写清经历，再说明读者可以照做的具体步骤。',
    base_revision: outlined.sections[0].revision,
  })
  return { id: work.id as string }
}

async function configureSummaryModel(page: Parameters<typeof api>[0], baseURL: string) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'DEV-QA26 Web 本地摘要契约模型 ' + Date.now(), base_url: baseURL,
    api_key: 'qa26-local-only-placeholder', models: ['qa26-summary'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', [{ task_type: 'summary', provider_id: provider.id, model: 'qa26-summary' }])
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]

test('DEV-QA26 G4-08 Web 摘要生成、120字边界、错误与 editor 持久化', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp', 'qa26-g408-web-' + Date.now())
  const work = await createWork(page, account.id)
  expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe('')
  const model = await startSummaryModel()
  await configureSummaryModel(page, model.baseURL)
  try {
    await page.goto('/works/' + work.id)
    await page.getByRole('link', { name: '标题与摘要', exact: true }).click()
    const summaryField = page.getByRole('textbox', { name: /摘要/ })
    const generateButton = page.getByRole('button', { name: '生成', exact: true })
    await expect(summaryField).toHaveValue('')
    await expect(page.getByText(/0\s*\/\s*120/)).toBeVisible()
    const expected = '这篇文章梳理了从真实经历提炼观点、说明做法并检查关键边界的过程。'
    const latencies: number[] = []
    for (let index = 0; index < 20; index++) {
      const started = performance.now()
      const generated = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
      const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
      await generateButton.click()
      const generation = await generated
      expect(generation.status(), await generation.text()).toBe(200)
      const result = await generation.json()
      expect(result.summary).toBe(expected)
      expect(result.truncated).toBe(false)
      const save = await saved
      expect(save.status(), await save.text()).toBe(200)
      expect(save.request().postDataJSON()).toEqual(expect.objectContaining({ summary: expected }))
      await expect(summaryField).toHaveValue(expected)
      expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(expected)
      latencies.push(performance.now() - started)
    }
    const p50 = percentile(latencies, 0.5)
    const p95 = percentile(latencies, 0.95)
    console.log('DEV-QA26 G4-08 Web 摘要生成+PATCH+GET：n=' + latencies.length + ' p50=' + p50.toFixed(2) + 'ms p95=' + p95.toFixed(2) + 'ms failures=0')
    await testInfo.attach('g4-08-web-summary-latencies', { body: JSON.stringify({ samples: latencies, p50, p95, failures: 0 }), contentType: 'application/json' })

    model.setMode('long')
    const boundaryGeneration = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    const boundarySave = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await generateButton.click()
    const boundaryResult = await (await boundaryGeneration).json()
    expect(boundaryResult.truncated).toBe(true)
    expect(Array.from(boundaryResult.summary).length).toBe(120)
    expect((await boundarySave).status()).toBe(200)
    await expect(summaryField).toHaveValue('长'.repeat(120))
    await expect(page.getByText('AI 写的摘要超过 120 字，已截断，请检查结尾', { exact: true })).toBeVisible()
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe('长'.repeat(120))

    const beforeManual = await api(page, 'GET', '/works/' + work.id)
    let patchCount = 0
    page.on('request', request => { if (request.url().endsWith('/api/v1/works/' + work.id) && request.method() === 'PATCH') patchCount++ })
    await summaryField.fill('手'.repeat(121))
    await expect(page.getByText(/121\s*\/\s*120/)).toBeVisible()
    await summaryField.press('Tab')
    await page.waitForTimeout(250)
    expect(patchCount).toBe(0)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(beforeManual.summary)
    await summaryField.fill('手'.repeat(120))
    const manualSave = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await summaryField.press('Tab')
    expect((await manualSave).status()).toBe(200)
    const beforeFailure = await api(page, 'GET', '/works/' + work.id)
    expect(beforeFailure.summary).toBe('手'.repeat(120))

    model.setMode('failure')
    const failurePatchCount = patchCount
    const failedGeneration = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    await generateButton.click()
    expect((await failedGeneration).status()).toBeGreaterThanOrEqual(500)
    await expect(page.getByText('生成摘要失败', { exact: true })).toBeVisible()
    expect(patchCount).toBe(failurePatchCount)
    await expect(summaryField).toHaveValue(beforeFailure.summary)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(beforeFailure.summary)

    model.setMode('short')
    const route = '**/api/v1/works/' + work.id
    await page.route(route, async intercepted => {
      if (intercepted.request().method() === 'PATCH') await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '本地模拟保存失败' } }) })
      else await intercepted.continue()
    })
    const generatedBeforeSaveFailure = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
    const failedSave = page.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
    await generateButton.click()
    expect((await generatedBeforeSaveFailure).status()).toBe(200)
    expect((await failedSave).status()).toBe(503)
    await expect(page.getByText(/本地模拟保存失败/)).toBeVisible()
    await expect(summaryField).toHaveValue(expected)
    expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(beforeFailure.summary)
    await page.unroute(route)
    await page.reload()
    await page.getByRole('link', { name: '标题与摘要', exact: true }).click()
    await expect(page.getByRole('textbox', { name: /摘要/ })).toHaveValue(beforeFailure.summary)

    const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1 }) as { code: string }
    const editorContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const registered = await editorContext.request.post('/api/v1/auth/register', { data: { username: 'qa26-g408-editor-' + Date.now(), password: 'local-e2e-password-123', invite_code: invite.code } })
      expect(registered.ok()).toBeTruthy()
      const editor = await editorContext.newPage()
      await editor.goto('/works/' + work.id)
      await expect.poll(() => editor.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).role)).toBe('editor')
      await expect(editor.getByRole('button', { name: '生成', exact: true })).toBeVisible()
      const editorGeneration = editor.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id + '/summary') && response.request().method() === 'POST')
      const editorSave = editor.waitForResponse(response => response.url().endsWith('/api/v1/works/' + work.id) && response.request().method() === 'PATCH')
      await editor.getByRole('button', { name: '生成', exact: true }).click()
      expect((await editorGeneration).status()).toBe(200)
      expect((await editorSave).status()).toBe(200)
      expect((await api(page, 'GET', '/works/' + work.id)).summary).toBe(expected)
    } finally { await editorContext.close() }
  } finally { await model.close() }
})
