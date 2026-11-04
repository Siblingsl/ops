import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + text)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

function pdfFixture() {
  const stream = 'BT /F1 12 Tf 72 720 Td (AW11 PDF source) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ]
  let text = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(text)
    text += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'
    return offset
  })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 6\n0000000000 65535 f \n'
  for (const offset of offsets) text += String(offset).padStart(10, '0') + ' 00000 n \n'
  text += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
  return Buffer.from(text)
}

function docxFixture() {
  const files = {
    'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>AW11 DOCX 原始资料</w:t></w:r></w:p></w:body></w:document>',
    'docProps/app.xml': '<Properties><Pages>1</Pages></Properties>',
  }
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [filename, text] of Object.entries(files)) {
    const name = Buffer.from(filename), data = Buffer.from(text)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8)
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('aw11-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW11 资料验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW11 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  expect((await api(page, 'GET', '/agent/bootstrap')).features.document_parse).toBe(true)
}

type DownloadRecord = { filename: string; state?: string; options: { title?: string; defaultPath?: string } }

async function journey(page: Page, baseURL: string, desktop?: ElectronApplication, downloadDir?: string) {
  await prepare(page, baseURL)
  const uploadResults: { name: string; parse_status: string }[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST') {
      void response.json().then((data) => uploadResults.push({ name: data.name, parse_status: data.parse_status }))
    }
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await chooser).setFiles([
    { name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('title,value\nAW11 CSV source,' + 'x'.repeat(20010) + '\n') },
    { name: 'brief.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    { name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture() },
    { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from([0xff, 0xfe]) },
    { name: 'private.csv', mimeType: 'text/csv', buffer: Buffer.from('key,value\nsecret,sk-abcdefghijklmnopqrstuvwxyz0123456789\n') },
  ])
  for (const name of ['report.csv', 'brief.pdf', 'notes.docx']) await expect(page.getByLabel(name + ' ready', { exact: true })).toBeVisible({ timeout: 40_000 })
  await expect(page.getByLabel('bad.csv failed', { exact: true })).toContainText('UTF-8')
  await expect.poll(() => uploadResults.length, { timeout: 40_000 }).toBe(5)
  expect(uploadResults.find((result) => result.name === 'private.csv')?.parse_status).toBe('quarantined')
  const privateFile = page.locator('[aria-label^="private.csv "]')
  await expect.poll(() => privateFile.getAttribute('aria-label'), { timeout: 40_000 }).toBe('private.csv failed')
  await expect(privateFile).toContainText('已隔离')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(page.getByText(/第 20,001～/)).toBeVisible()
  expect(JSON.stringify(uploadResults)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
  await page.getByRole('button', { name: '移除 bad.csv', exact: true }).click()
  await page.getByRole('button', { name: '移除 private.csv', exact: true }).click()
  mkdirSync(resolve(process.cwd(), '../../.playwright-results'), { recursive: true })
  const prefix = desktop ? 'electron' : 'web'
  await page.screenshot({ path: resolve(process.cwd(), '../../.playwright-results/agent-workbench-aw11-' + prefix + '-upload.png') })
  const tableText = 'item,value\n<script>window.__aw11Injected=1</script>,plain\n=SUM(A1),+cmd\n'
  const title = 'AW11 文件产物 ' + Date.now()
  const composer = page.getByRole('textbox', { name: '发送消息' }).or(page.getByPlaceholder(/发送消息/))
  await composer.fill('读取上传资料并整理表格\n#tool present_artifact ' + JSON.stringify({ title, kind: 'table', chat_content: tableText }))
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
  const conversationID = page.url().split('/').pop()!
  await expect.poll(async () => (await api(page, 'GET', '/agent/conversations/' + conversationID)).active_run, { timeout: 30_000 }).toBeNull()
  const detail = await api(page, 'GET', '/agent/conversations/' + conversationID)
  const attachments = detail.messages.find((message: { role: string }) => message.role === 'user').attachments
  expect(attachments).toHaveLength(3)
  for (const attachment of attachments) expect(attachment.loaded_chars).toBe(attachment.injected_chars)
  await expect(page.getByText(/已装入请求/).first()).toBeVisible()
  let panel
  if (desktop) {
    const toggle = page.getByRole('button', { name: '任务面板', exact: true })
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    panel = page.getByTestId('desktop-agent-side-panel')
    await panel.getByRole('tab', { name: '产物', exact: true }).click()
  } else {
    await page.getByRole('button', { name: '查看产物', exact: true }).click()
    panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '本对话产物', exact: true }) })
  }
  await panel.getByRole('button', { name: new RegExp(title) }).click()
  await expect(panel.getByRole('cell', { name: '<script>window.__aw11Injected=1</script>', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __aw11Injected?: number }).__aw11Injected)).toBeUndefined()
  if (!desktop) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await panel.getByRole('button', { name: '复制内容', exact: true }).click()
  await expect.poll(() => desktop
    ? desktop.evaluate(({ clipboard }) => clipboard.readText().then((value) => value.replace(/\r\n/g, '\n')))
    : page.evaluate(() => navigator.clipboard.readText().then((value) => value.replace(/\r\n/g, '\n')))).toBe(tableText)
  if (desktop) {
    await desktop.evaluate(({ session }, directory) => {
      const downloads: DownloadRecord[] = []
      ;(globalThis as unknown as { __aw11Downloads: DownloadRecord[] }).__aw11Downloads = downloads
      session.fromPartition('persist:ops-business-development').on('will-download', (_event, item) => {
        const record = { filename: item.getFilename(), options: item.getSaveDialogOptions() } as DownloadRecord
        downloads.push(record)
        item.setSavePath(directory + '/' + item.getFilename())
        item.once('done', (_done, state) => { record.state = state })
      })
    }, downloadDir!)
    await panel.getByRole('button', { name: '保存 CSV', exact: true }).click()
    await expect.poll(() => desktop.evaluate(() => (globalThis as unknown as { __aw11Downloads: DownloadRecord[] }).__aw11Downloads[0]?.state)).toBe('completed')
    const download = await desktop.evaluate(() => (globalThis as unknown as { __aw11Downloads: DownloadRecord[] }).__aw11Downloads[0])
    expect(download.options.title).toBe('保存下载文件')
    expect(download.options.defaultPath).toBe('ops-artifact-v1.csv')
    expect(await readFile(join(downloadDir!, download.filename), 'utf8')).toContain("文本：=SUM(A1),文本：+cmd")
  } else {
    const downloading = page.waitForEvent('download')
    await panel.getByRole('button', { name: '保存 CSV', exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe('ops-artifact-v1.csv')
    expect(await readFile((await download.path())!, 'utf8')).toContain("文本：=SUM(A1),文本：+cmd")
  }
  await page.screenshot({ path: resolve(process.cwd(), '../../.playwright-results/agent-workbench-aw11-' + prefix + '-artifact.png') })
}

test('DEV-AW11 Windows Electron固定选择文件、文档回执与原生保存链路', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-aw11-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const downloadDir = join(userData, 'downloads')
    mkdirSync(downloadDir)
    await journey(await app.firstWindow(), baseURL!, app, downloadDir)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-aw11-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron图片与文本附件进入同一条持久消息', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-attachment-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    const account = (await api(page, 'GET', '/accounts'))[0]
    await page.goto(`${baseURL}/a/${account.id}`)
    await page.getByRole('button', { name: /^用户菜单/ }).click()
    await page.getByRole('menuitem', { name: '切换工作区与账号' }).click()
    const accountSwitcher = page.getByTestId('desktop-context-menu')
    await accountSwitcher.getByRole('tab', { name: /小红书/ }).click()
    await accountSwitcher.getByRole('button', { name: account.name, exact: true }).click()
    await page.getByRole('link', { name: 'AI 对话', exact: true }).click()
    const materialText = `DEV-QA26 Electron 本轮上下文 ${Date.now()}：引用内容应跟随本条消息保存。`
    await api(page, 'POST', '/materials', { account_id: account.id, kind: 'experience', content: materialText, source: 'DEV-QA26 Electron 验收' })
    const skillName = `QA26-${Date.now()}`
    const skill = (await api(page, 'POST', '/skills', {
      scope: 'personal', name: skillName, summary: '区分请求、加载与使用', triggers: '桌面对话验收',
      instructions: '只在模型实际加载后使用。', platforms: [], content_formats: [], task_types: [],
      task_enabled: true, agent_enabled: true, status: 'active',
    })).skill
    const bindings = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)
    await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skill.id}`, {
      enabled: true, base_revision: bindings.mine.base_revision,
    })
    await page.getByRole('button', { name: '引用资料（@）' }).click()
    const contextDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '引用工作区资料', exact: true }) })
    await contextDialog.getByRole('textbox', { name: '搜索资料' }).fill(materialText)
    const materialCandidate = contextDialog.getByRole('button', { name: new RegExp(materialText) })
    await expect(materialCandidate).toBeVisible()
    await materialCandidate.click()
    await contextDialog.getByRole('button', { name: '预览并校验', exact: true }).click()
    await expect(contextDialog.locator('pre')).toContainText(materialText)
    await contextDialog.getByRole('button', { name: '添加引用', exact: true }).click()
    await page.getByRole('button', { name: '请求技能（$）' }).click()
    const skillDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '请求使用技能', exact: true }) })
    const skillRow = skillDialog.getByText(skillName, { exact: true }).locator('..').locator('..')
    await expect(skillRow).toBeVisible()
    await skillRow.getByRole('button', { name: '请求使用', exact: true }).click()
    const imageBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 80
      const context = canvas.getContext('2d')!
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles([
      { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(imageBase64, 'base64') },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('只读文本附件：补充背景资料。', 'utf8') },
    ])
    await expect(page.getByLabel('reference.png ready', { exact: true })).toBeVisible({ timeout: 40_000 })
    await expect(page.getByLabel('notes.txt ready', { exact: true })).toBeVisible({ timeout: 40_000 })
    const composer = page.getByRole('textbox', { name: '发送消息' }).or(page.getByPlaceholder(/发送消息/))
    await composer.fill('图片是什么颜色？请同时参考文本附件。')
    const sendRequest = page.waitForRequest((request) => /\/api\/v1\/agent\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname) && request.method() === 'POST')
    const accepted = page.waitForResponse((response) => /\/agent\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const payload = (await sendRequest).postDataJSON()
    expect(payload.context_refs).toEqual([expect.objectContaining({ type: 'material', scope: 'turn' })])
    expect(payload.skill_requests).toEqual([expect.objectContaining({ skill_id: skill.id })])
    expect(payload.attachment_ids).toHaveLength(2)
    const response = await accepted
    expect(response.status()).toBe(202)
    await page.waitForURL(/\/agent\/c\/[a-f0-9-]+$/)
    const conversationID = page.url().split('/').pop()!
    await expect.poll(async () => (await api(page, 'GET', '/agent/conversations/' + conversationID)).active_run, { timeout: 30_000 }).toBeNull()
    const detail = await api(page, 'GET', '/agent/conversations/' + conversationID)
    const userMessage = detail.messages.find((message: { role: string }) => message.role === 'user')
    expect(userMessage.attachments).toHaveLength(2)
    expect(userMessage.context_refs).toEqual([expect.objectContaining({ type: 'material', scope: 'turn' })])
    expect(userMessage.skill_requests).toEqual([expect.objectContaining({ skill_id: skill.id })])
    const image = userMessage.attachments.find((item: { kind: string }) => item.kind === 'image')
    const text = userMessage.attachments.find((item: { kind: string }) => item.kind === 'text')
    expect(image).toMatchObject({ name: 'reference.png', mime: 'image/png', parse_status: 'ready' })
    expect(text).toMatchObject({ name: 'notes.txt', mime: 'text/plain', parse_status: 'ready' })
    const textFile = await page.evaluate(async (url) => {
      const response = await fetch(url)
      return { status: response.status, content: await response.text() }
    }, text.url)
    expect(textFile).toEqual({ status: 200, content: '只读文本附件：补充背景资料。' })
    await expect(page.getByText(`技能已请求 · ${skillName}`, { exact: true })).toBeVisible()
    await expect(page.getByText(`${materialText} · 本轮引用`, { exact: true })).toBeVisible()
    await expect(page.locator('article').getByText('红色', { exact: true })).toBeVisible()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-attachment-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

