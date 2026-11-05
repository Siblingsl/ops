import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'

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

function pdfFixture(options: { pages?: number; withText?: boolean; encrypted?: boolean } = {}) {
  const pageCount = options.pages ?? 1
  const fontID = pageCount + 3
  const contentID = pageCount + 4
  const stream = options.withText === false ? '' : 'BT /F1 12 Tf 72 720 Td (AW11 PDF source) Tj ET'
  const pageIDs = Array.from({ length: pageCount }, (_, index) => index + 3)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIDs.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageIDs.map((id) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontID} 0 R >> >> /Contents ${contentID} 0 R >>`),
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
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) text += String(offset).padStart(10, '0') + ' 00000 n \n'
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${options.encrypted ? ' /Encrypt 0 R' : ''} >>\nstartxref\n` + xref + '\n%%EOF'
  return Buffer.from(text)
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(data: Buffer) {
  let value = 0xffffffff
  for (const byte of data) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipFixture(files: Record<string, string | Buffer>, deflate = false) {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  const method = deflate ? 8 : 0
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename), data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const compressed = deflate ? deflateRawSync(data) : data
    const checksum = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(method, 8)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), entries = Object.keys(files).length
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function docxFixture(overrides: Record<string, string | Buffer> = {}) {
  return zipFixture({
    'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>AW11 DOCX 原始资料</w:t></w:r></w:p></w:body></w:document>',
    'docProps/app.xml': '<Properties><Pages>1</Pages></Properties>',
    ...overrides,
  })
}

function docxPageFixture(pages: number, overrides: Record<string, string> = {}) {
  const pageBreaks = '<w:lastRenderedPageBreak/>'.repeat(Math.max(0, pages - 1))
  return docxFixture({
    'word/document.xml': `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>分页边界资料</w:t></w:r>${pageBreaks}</w:p></w:body></w:document>`,
    'docProps/app.xml': `<Properties><Pages>${pages}</Pages></Properties>`,
    ...overrides,
  })
}

function docxEntryCountFixture(totalEntries: number) {
  const overrides: Record<string, string> = {}
  for (let index = 2; index < totalEntries; index++) overrides[`customXml/item${index}.xml`] = '<item />'
  return docxFixture(overrides)
}

function docxExternalEntityFixture() {
  return docxFixture({
    'word/document.xml': '<!DOCTYPE w:document [<!ENTITY ext SYSTEM "file:///OPS-QA26-NO-READ">]><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>&ext;</w:t></w:r></w:p></w:body></w:document>',
  })
}

function docxExpandedFixture(totalExpandedBytes: number) {
  const files: Record<string, Buffer> = {
    'word/document.xml': Buffer.from('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>ZIP 上界资料</w:t></w:r></w:p></w:body></w:document>'),
    'docProps/app.xml': Buffer.from('<Properties><Pages>1</Pages></Properties>'),
  }
  const baseBytes = Object.values(files).reduce((total, data) => total + data.length, 0)
  if (totalExpandedBytes < baseBytes) throw new Error('DOCX expanded fixture below its XML headers')
  files['customXml/payload.xml'] = Buffer.alloc(totalExpandedBytes - baseBytes, 0x61)
  return zipFixture(files, true)
}

async function prepare(page: Page, baseURL: string) {
  await page.goto(baseURL + '/register')
  await page.getByLabel('用户名', { exact: true }).fill('aw11-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7))
  await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
  await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'AW11 资料验收号', content_format: 'image_note', type_note: '' })
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'AW11 本地 mock', base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8191/v1', api_key: 'local-e2e-key', models: ['mock-agent-tested'],
  })
  await api(page, 'POST', '/model-providers/' + provider.id + '/selftest', {})
  await api(page, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: provider.id, model: 'mock-agent-tested' }])
  await page.goto(baseURL + '/agent')
  const privacy = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '智能体隐私说明', exact: true }) })
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click()
  expect((await api(page, 'GET', '/agent/bootstrap')).features.document_parse).toBe(true)
}

async function journey(page: Page, baseURL: string) {
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
  mkdirSync(resolve(process.cwd(), '../.playwright-results'), { recursive: true })
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-workbench-aw11-web-upload.png') })
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
  await page.getByRole('button', { name: '查看产物', exact: true }).click()
  const panel = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '本对话产物', exact: true }) })
  await panel.getByRole('button', { name: new RegExp(title) }).click()
  await expect(panel.getByRole('cell', { name: '<script>window.__aw11Injected=1</script>', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __aw11Injected?: number }).__aw11Injected)).toBeUndefined()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await panel.getByRole('button', { name: '复制内容', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText().then((value) => value.replace(/\r\n/g, '\n')))).toBe(tableText)
  const downloading = page.waitForEvent('download')
  await panel.getByRole('button', { name: '保存 CSV', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('ops-artifact-v1.csv')
  expect(await readFile((await download.path())!, 'utf8')).toContain("文本：=SUM(A1),文本：+cmd")
  await page.screenshot({ path: resolve(process.cwd(), '../.playwright-results/agent-workbench-aw11-web-artifact.png') })
}

test('DEV-AW11 Web文档上传、严格解析回执、隔离失败与安全产物保存', async ({ page, baseURL }) => {
  await journey(page, baseURL!)
  await expect(page.locator('.desktop-agent-workbench')).toHaveCount(0)
})

test('DEV-QA26 G7 Web逐项拒绝文档解析边界且不允许发送', async ({ page, baseURL }) => {
  await prepare(page, baseURL!)
  const failures: { status: number; code?: string }[] = []
  const accepted: { status: number; id?: string; parse_status?: string; page_count?: number }[] = []
  const attachmentDurations: number[] = []
  let messagePosts = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST') {
      void response.json().then((body) => {
        const result = { status: response.status(), code: body.error?.code, id: body.id, parse_status: body.parse_status, page_count: body.page_count }
        if (response.status() === 200) accepted.push(result)
        else failures.push(result)
      }).catch(() => undefined)
    }
  })
  page.on('requestfinished', (request) => {
    if (new URL(request.url()).pathname !== '/api/v1/agent/attachments' || request.method() !== 'POST') return
    const timing = request.timing()
    if (timing.requestStart >= 0 && timing.responseEnd >= timing.requestStart) attachmentDurations.push(timing.responseEnd - timing.requestStart)
  })
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await chooser).setFiles([
    { name: 'oversized.pdf', mimeType: 'application/pdf', buffer: oversized },
    { name: 'too-many-pages.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ pages: 101 }) },
    { name: 'scanned.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ withText: false }) },
    { name: 'encrypted.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ encrypted: true }) },
    { name: 'external.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxPageFixture(100, { 'word/_rels/document.xml.rels': '<Relationships xmlns="urn:r"><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>' }) },
    { name: 'macro.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxPageFixture(100, { '[Content_Types].xml': '<Types><Default ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>' }) },
  ])
  await expect(page.getByLabel('oversized.pdf failed', { exact: true })).toContainText('文件超过大小限制')
  await expect(page.getByLabel('too-many-pages.pdf failed', { exact: true })).toContainText('超过 100 页')
  await expect(page.getByLabel('scanned.pdf failed', { exact: true })).toContainText('不支持扫描件')
  await expect(page.getByLabel('encrypted.pdf failed', { exact: true })).toContainText('已加密或格式损坏')
  await expect(page.getByLabel('external.docx failed', { exact: true })).toContainText('宏、嵌入对象或外链资源')
  await expect(page.getByLabel('macro.docx failed', { exact: true })).toContainText('宏、嵌入对象或外链资源')
  await expect.poll(() => failures.length, { timeout: 40_000 }).toBe(5)
  expect(failures).toHaveLength(5)
  expect(failures.every((failure) => failure.status === 422 && failure.code === 'agent_attachment_parse_failed')).toBe(true)
  await page.getByRole('button', { name: '移除 encrypted.pdf', exact: true }).click()
  for (const [name, parts] of [
    ['missing-pages.docx', { 'docProps/app.xml': '<Properties></Properties>' }],
    ['mismatched-pages.docx', {
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>分页不一致</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p></w:body></w:document>',
    }],
  ] as const) {
    const nextChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await nextChooser).setFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture(parts) })
    await expect(page.getByLabel(name + ' failed', { exact: true })).toContainText('无法验证 DOCX 的保存分页信息')
    await expect.poll(() => failures.length, { timeout: 40_000 }).toBe(name === 'missing-pages.docx' ? 6 : 7)
    await page.getByRole('button', { name: '移除 ' + name, exact: true }).click()
  }
  expect(failures).toHaveLength(7)
  expect(failures.every((failure) => failure.status === 422 && failure.code === 'agent_attachment_parse_failed')).toBe(true)
  let expectedFailures = 7
  const additionalCases = [
    { name: 'too-many-rows.csv', mimeType: 'text/csv', buffer: Buffer.from('header\n' + 'value\n'.repeat(10_000)), message: 'CSV 最多 10000 行、100 列' },
    { name: 'too-many-columns.csv', mimeType: 'text/csv', buffer: Buffer.from(Array.from({ length: 101 }, (_, index) => `c${index}`).join(',') + '\n'), message: 'CSV 最多 10000 行、100 列' },
    { name: 'malformed.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n"unfinished'), message: 'CSV 为空或格式损坏' },
    { name: 'corrupt.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip package'), message: 'DOCX 已加密、损坏或解压内容超限' },
    { name: 'embedded.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture({ 'word/embeddings/oleObject1.bin': 'embedded object' }), message: '宏、嵌入对象或外链资源' },
    { name: 'malformed-xml.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture({ 'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:t>不完整 XML</w:p></w:body></w:document>' }), message: 'DOCX 已加密、损坏或解压内容超限' },
    { name: 'external-entity.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxExternalEntityFixture(), message: 'DOCX 已加密、损坏或解压内容超限' },
    { name: 'too-many-entries.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxEntryCountFixture(257), message: 'DOCX 已加密、损坏或解压内容超限' },
    { name: 'too-many-pages.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxPageFixture(101), message: '文档超过 100 页' },
  ]
  for (const item of additionalCases) {
    const nextChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await nextChooser).setFiles({ name: item.name, mimeType: item.mimeType, buffer: item.buffer })
    await expect(page.getByLabel(item.name + ' failed', { exact: true })).toContainText(item.message)
    expectedFailures++
    await expect.poll(() => failures.length, { timeout: 40_000 }).toBe(expectedFailures)
    await page.getByRole('button', { name: '移除 ' + item.name, exact: true }).click()
  }
  let expandedDocx = docxExpandedFixture(96 * 1024 * 1024 + 1)
  const expandedChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await expandedChooser).setFiles({ name: 'expanded-over-limit.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: expandedDocx })
  expandedDocx = Buffer.alloc(0)
  await expect(page.getByLabel('expanded-over-limit.docx failed', { exact: true })).toContainText('DOCX 已加密、损坏或解压内容超限')
  expectedFailures++
  await expect.poll(() => failures.length, { timeout: 40_000 }).toBe(expectedFailures)
  await page.getByRole('button', { name: '移除 expanded-over-limit.docx', exact: true }).click()
  expect(failures).toHaveLength(expectedFailures)
  expect(attachmentDurations).toHaveLength(expectedFailures)
  expect(failures.every((failure) => failure.status === 422 && failure.code === 'agent_attachment_parse_failed')).toBe(true)
  let expandedAtLimit = docxExpandedFixture(96 * 1024 * 1024)
  const exactZipChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await exactZipChooser).setFiles({ name: 'expanded-at-limit.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: expandedAtLimit })
  expandedAtLimit = Buffer.alloc(0)
  await expect(page.getByLabel('expanded-at-limit.docx ready', { exact: true })).toBeVisible({ timeout: 40_000 })
  await expect.poll(() => accepted.length, { timeout: 40_000 }).toBe(1)
  expect(accepted[0]).toMatchObject({ status: 200, parse_status: 'ready', page_count: 1 })
  const expandedFile = await page.evaluate(async (id) => {
    const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
  }, accepted[0].id!)
  expect(expandedFile.status).toBe(200)
  expect(expandedFile.bytes).toBeGreaterThan(0)
  expect(expandedFile.signature).toBe('PK\u0003\u0004')
  await page.getByRole('button', { name: '移除 expanded-at-limit.docx', exact: true }).click()
  const exactEntriesChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await exactEntriesChooser).setFiles({ name: 'exactly-256-entries.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxEntryCountFixture(256) })
  await expect(page.getByLabel('exactly-256-entries.docx ready', { exact: true })).toBeVisible({ timeout: 40_000 })
  await expect.poll(() => accepted.length, { timeout: 40_000 }).toBe(2)
  expect(accepted[1]).toMatchObject({ status: 200, parse_status: 'ready', page_count: 1 })
  await page.getByRole('button', { name: '移除 exactly-256-entries.docx', exact: true }).click()
  const exactPagesChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await exactPagesChooser).setFiles({ name: 'exactly-100-pages.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxPageFixture(100) })
  await expect(page.getByLabel('exactly-100-pages.docx ready', { exact: true })).toBeVisible({ timeout: 40_000 })
  await expect.poll(() => accepted.length, { timeout: 40_000 }).toBe(3)
  expect(accepted[2]).toMatchObject({ status: 200, parse_status: 'ready', page_count: 100 })
  await page.getByRole('button', { name: '移除 exactly-100-pages.docx', exact: true }).click()
  const exactBoundaryChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await (await exactBoundaryChooser).setFiles({ name: 'exactly-100-pages.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ pages: 100 }) })
  await expect(page.getByLabel('exactly-100-pages.pdf ready', { exact: true })).toBeVisible({ timeout: 40_000 })
  await expect.poll(() => accepted.length, { timeout: 40_000 }).toBe(4)
  expect(accepted[3]).toMatchObject({ status: 200, parse_status: 'ready', page_count: 100 })
  const originalFile = await page.evaluate(async (id) => {
    const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 8)) }
  }, accepted[3].id!)
  expect(originalFile.status).toBe(200)
  expect(originalFile.bytes).toBeGreaterThan(0)
  expect(originalFile.signature).toBe('%PDF-1.4')
  await expect.poll(() => attachmentDurations.length, { timeout: 10_000 }).toBe(expectedFailures + 4)
  const sortedDurations = [...attachmentDurations].sort((a, b) => a - b)
  console.log(`DEV-QA26_METRIC_DOCX_BOUNDARY_WEB ${JSON.stringify({ environment: 'Web Chromium; local E2E API and WASI parser', sample_count: attachmentDurations.length, rejected: failures.length, accepted: accepted.length, p50_ms: Number(sortedDurations[10].toFixed(2)), p95_ms: Number(sortedDurations[19].toFixed(2)), unexpected_failures: 0 })}`)
  console.log(`[DEV-QA26] Web exact-100-page upload ms: ${attachmentDurations.at(-1)}`)
  console.log(`[DEV-QA26] Web attachment rejection request ms: ${JSON.stringify(attachmentDurations.slice(0, expectedFailures))}`)
  expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(page).toHaveURL(/\/agent\/?$/)
  expect(messagePosts).toBe(0)
})


