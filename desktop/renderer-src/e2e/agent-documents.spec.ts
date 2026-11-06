import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
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

function zipFixtureEntries(entries: Array<[string, string | Buffer]>, deflate = false) {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  const method = deflate ? 8 : 0
  for (const [filename, content] of entries) {
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
  const directory = Buffer.concat(central), end = Buffer.alloc(22), entryCount = entries.length
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entryCount, 8); end.writeUInt16LE(entryCount, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function zipFixture(files: Record<string, string | Buffer>, deflate = false) {
  return zipFixtureEntries(Object.entries(files), deflate)
}

function docxFixture(overrides: Record<string, string | Buffer> = {}) {
  return zipFixture({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>AW11 DOCX 原始资料</w:t></w:r></w:p></w:body></w:document>',
    'docProps/app.xml': '<Properties><Pages>1</Pages></Properties>',
    ...overrides,
  })
}

function docxCaseCollisionFixture() {
  return zipFixtureEntries([
    ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一部件</w:t></w:r></w:p></w:body></w:document>'],
    ['WORD/DOCUMENT.XML', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>冲突部件</w:t></w:r></w:p></w:body></w:document>'],
    ['docProps/app.xml', '<Properties><Pages>1</Pages></Properties>'],
  ])
}

function docxNonCanonicalPathFixture() {
  return zipFixtureEntries([
    ['word/./document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>点段路径</w:t></w:r></w:p></w:body></w:document>'],
    ['docProps/app.xml', '<Properties><Pages>1</Pages></Properties>'],
  ])
}

function docxCorruptCRCFixture() {
  const corrupted = docxFixture()
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let offset = corrupted.indexOf(signature)
  while (offset >= 0) {
    const nameLength = corrupted.readUInt16LE(offset + 28)
    const name = corrupted.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === 'word/document.xml') {
      corrupted.writeUInt32LE((corrupted.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16)
      return corrupted
    }
    offset = corrupted.indexOf(signature, offset + 4)
  }
  throw new Error('DOCX central directory entry not found')
}

function docxEncryptedEntryFlagFixture() {
  const encrypted = docxFixture()
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let offset = encrypted.indexOf(signature)
  while (offset >= 0) {
    const nameLength = encrypted.readUInt16LE(offset + 28)
    const name = encrypted.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === 'word/document.xml') {
      const centralFlags = encrypted.readUInt16LE(offset + 8) | 1
      const localOffset = encrypted.readUInt32LE(offset + 42)
      const localFlags = encrypted.readUInt16LE(localOffset + 6) | 1
      encrypted.writeUInt16LE(centralFlags, offset + 8)
      encrypted.writeUInt16LE(localFlags, localOffset + 6)
      return encrypted
    }
    offset = encrypted.indexOf(signature, offset + 4)
  }
  throw new Error('DOCX central directory entry not found')
}

function minimalOPCDocxFixture(externalRootRelationship = false, defect?: 'missing-content-types' | 'missing-root-relationships' | 'missing-office-document-relationship' | 'missing-main-document-content-type' | 'override-main-document-content-type' | 'foreign-main-document-namespace' | 'wrong-main-document-root' | 'missing-main-document-body' | 'foreign-main-document-relationship' | 'foreign-main-document-content-type' | 'missing-main-relationship-id' | 'duplicate-main-relationship-id' | 'foreign-main-relationship-attributes' | 'foreign-default-content-type-attributes' | 'foreign-override-content-type-attributes') {
  const external = externalRootRelationship
    ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/>'
    : ''
  const files: Record<string, string> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/>' + external + '</Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>最小 OPC 文档</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    'docProps/app.xml': '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Word</Application><Pages>1</Pages></Properties>',
  }
  if (defect === 'missing-content-types') delete files['[Content_Types].xml']
  if (defect === 'missing-root-relationships') delete files['_rels/.rels']
  if (defect === 'missing-office-document-relationship') {
    files['_rels/.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>'
  }
  if (defect === 'missing-main-document-content-type') {
    files['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
  }
  if (defect === 'override-main-document-content-type') {
    files['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>'
  }
  if (defect === 'foreign-main-document-namespace') {
    files['word/document.xml'] = '<w:document xmlns:w="urn:foreign"><w:body><w:p><w:r><w:t>错误命名空间</w:t></w:r></w:p></w:body></w:document>'
  }
  if (defect === 'wrong-main-document-root') {
    files['word/document.xml'] = '<w:body xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>错误根元素</w:t></w:r></w:p></w:body>'
  }
  if (defect === 'missing-main-document-body') {
    files['word/document.xml'] = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>缺失正文容器</w:t></w:r></w:p></w:document>'
  }
  if (defect === 'foreign-main-document-relationship') {
    files['_rels/.rels'] = files['_rels/.rels'].replace('<Relationship Id="rId1"', '<f:Relationship xmlns:f="urn:foreign" Id="rId1"')
  }
  if (defect === 'foreign-main-document-content-type') {
    files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('<Override PartName="/word/document.xml"', '<f:Override xmlns:f="urn:foreign" PartName="/word/document.xml"')
  }
  if (defect === 'missing-main-relationship-id') {
    files['_rels/.rels'] = files['_rels/.rels'].replace(' Id="rId1"', '')
  }
  if (defect === 'duplicate-main-relationship-id') {
    files['_rels/.rels'] = files['_rels/.rels'].replace('Id="rId2"', 'Id="rId1"')
  }
  if (defect === 'foreign-main-relationship-attributes') {
    files['_rels/.rels'] = files['_rels/.rels']
      .replace('<Relationship Id="rId1"', '<Relationship xmlns:f="urn:foreign" f:Id="rId1"')
      .replace(' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"', ' f:Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"')
      .replace(' Target="word/document.xml"', ' f:Target="word/document.xml"')
  }
  if (defect === 'foreign-default-content-type-attributes') {
    files['[Content_Types].xml'] = files['[Content_Types].xml']
      .replace('<Default Extension="xml" ContentType="application/xml"/>', '<Default xmlns:f="urn:foreign" f:Extension="xml" f:ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>')
      .replace('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>', '')
  }
  if (defect === 'foreign-override-content-type-attributes') {
    files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>', '<Override xmlns:f="urn:foreign" f:PartName="/word/document.xml" f:ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>')
  }
  return zipFixture(files)
}

function docxPageFixture(pages: number, overrides: Record<string, string> = {}) {
  const pageBreaks = '<w:lastRenderedPageBreak/>'.repeat(Math.max(0, pages - 1))
  return docxFixture({
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>分页边界资料</w:t></w:r>${pageBreaks}</w:p></w:body></w:document>`,
    'docProps/app.xml': `<Properties><Pages>${pages}</Pages></Properties>`,
    ...overrides,
  })
}

function docxEntryCountFixture(totalEntries: number) {
  const overrides: Record<string, string> = {}
  for (let index = 0; index < totalEntries - 4; index++) overrides[`customXml/item${index}.xml`] = '<item />'
  return docxFixture(overrides)
}

function docxExternalEntityFixture() {
  return docxFixture({
    'word/document.xml': '<!DOCTYPE w:document [<!ENTITY ext SYSTEM "file:///OPS-QA26-NO-READ">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&ext;</w:t></w:r></w:p></w:body></w:document>',
  })
}

function docxExpandedFixture(totalExpandedBytes: number) {
  const files: Record<string, Buffer> = {
    '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'),
    '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>'),
    'word/document.xml': Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ZIP 上界资料</w:t></w:r></w:p></w:body></w:document>'),
    'docProps/app.xml': Buffer.from('<Properties><Pages>1</Pages></Properties>'),
  }
  const baseBytes = Object.values(files).reduce((total, data) => total + data.length, 0)
  if (totalExpandedBytes < baseBytes) throw new Error('DOCX expanded fixture below its XML headers')
  files['customXml/payload.xml'] = Buffer.alloc(totalExpandedBytes - baseBytes, 0x61)
  return zipFixture(files, true)
}

function docxLargeDocumentFixture(expandedDocumentBytes: number) {
  const prefix = Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>')
  const suffix = Buffer.from('</w:t></w:r></w:p></w:body></w:document>')
  const textBytes = expandedDocumentBytes - prefix.length - suffix.length
  if (textBytes < 1) throw new Error('DOCX document entry must contain text')
  return zipFixture({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'word/document.xml': Buffer.concat([prefix, Buffer.alloc(textBytes, 0x61), suffix]),
    'docProps/app.xml': '<Properties><Pages>1</Pages></Properties>',
  }, true)
}

function docxLargePageDocumentFixture(expandedDocumentBytes: number, pages: number, totalEntries: number) {
  const prefix = Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>')
  const pageBreaks = Buffer.from('<w:lastRenderedPageBreak/>'.repeat(Math.max(0, pages - 1)))
  const closeRun = Buffer.from('</w:t></w:r>')
  const closeDocument = Buffer.from('</w:p></w:body></w:document>')
  const textBytes = expandedDocumentBytes - prefix.length - pageBreaks.length - closeRun.length - closeDocument.length
  if (textBytes < 1) throw new Error('DOCX document entry must contain text')
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'word/document.xml': Buffer.concat([prefix, Buffer.alloc(textBytes, 0x61), closeRun, pageBreaks, closeDocument]),
    'docProps/app.xml': `<Properties><Pages>${pages}</Pages></Properties>`,
  }
  for (let index = 0; index < totalEntries - 4; index++) files[`customXml/item${index}.xml`] = '<item />'
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

test('DEV-QA26 G7-03 Windows Electron真实文件选择器拒绝DOCX ZIP CRC损坏', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-crc-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const document = docxCorruptCRCFixture()
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'crc-damaged.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document })
    const response = await upload
    const uploadMs = performance.now() - started
    const body = await response.json() as { error?: { code?: string } }
    expect(response.status()).toBe(422)
    expect(body.error?.code).toBe('agent_attachment_parse_failed')
    const card = page.getByLabel('crc-damaged.docx failed', { exact: true })
    await expect(card).toContainText('DOCX 已加密、损坏或解压内容超限')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_CRC_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', uploaded_bytes: document.byteLength, status: response.status(), upload_ms: Number(uploadMs.toFixed(2)), conversations: 0, message_posts: messagePosts })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-crc-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7-03 Windows Electron真实文件选择器拒绝带ZIP加密标志的DOCX条目', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-encrypted-flag-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const document = docxEncryptedEntryFlagFixture()
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'encrypted-entry.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document })
    const response = await upload
    const uploadMs = performance.now() - started
    const body = await response.json() as { error?: { code?: string } }
    expect(response.status()).toBe(422)
    expect(body.error?.code).toBe('agent_attachment_parse_failed')
    await expect(page.getByLabel('encrypted-entry.docx failed', { exact: true })).toContainText('DOCX 已加密、损坏或解压内容超限')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_ENCRYPTED_FLAG_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', sample: 'ZIP general-purpose bit flag 0 set; payload is not password-encrypted', uploaded_bytes: document.byteLength, status: response.status(), upload_ms: Number(uploadMs.toFixed(2)), conversations: 0, message_posts: messagePosts })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-encrypted-flag-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7-03 Windows Electron真实文件选择器验证最小OPC DOCX与根关系外链', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-minimal-opc-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })

    const valid = minimalOPCDocxFixture()
    const validChooser = page.waitForEvent('filechooser')
    const validUpload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const validStarted = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await validChooser).setFiles({ name: 'minimal-opc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: valid })
    const validResponse = await validUpload
    const validUploadMs = performance.now() - validStarted
    expect(validResponse.status()).toBe(200)
    const validBody = await validResponse.json() as { id: string; parse_status: string; page_count: number }
    expect(validBody).toMatchObject({ parse_status: 'ready', page_count: 1 })
    await expect(page.getByLabel('minimal-opc.docx ready', { exact: true })).toBeVisible()
    const original = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
    }, validBody.id)
    expect(original.status).toBe(200)
    expect(original.bytes).toBe(valid.byteLength)
    expect(original.signature).toBe('PK\u0003\u0004')
    const remove = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments/' + validBody.id && response.request().method() === 'DELETE')
    await page.getByRole('button', { name: '移除 minimal-opc.docx', exact: true }).click()
    expect((await remove).status()).toBe(200)
    const deletedStatus = await page.evaluate(async (id) => (await fetch('/api/v1/agent/attachments/' + id + '/file?qa26=' + Date.now(), { cache: 'no-store' })).status, validBody.id)
    expect(deletedStatus).toBe(404)

    const external = minimalOPCDocxFixture(true)
    const externalChooser = page.waitForEvent('filechooser')
    const externalUpload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const externalStarted = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await externalChooser).setFiles({ name: 'external-root.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: external })
    const externalResponse = await externalUpload
    const externalUploadMs = performance.now() - externalStarted
    const externalBody = await externalResponse.json() as { error?: { code?: string } }
    expect(externalResponse.status()).toBe(422)
    expect(externalBody.error?.code).toBe('agent_attachment_parse_failed')
    await expect(page.getByLabel('external-root.docx failed', { exact: true })).toContainText('宏、嵌入对象或外链资源')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '移除 external-root.docx', exact: true }).click()
    await expect(page.getByLabel('external-root.docx failed', { exact: true })).toHaveCount(0)

    const incompleteCases = [
      { defect: 'missing-content-types', name: 'missing-content-types.docx' },
      { defect: 'missing-root-relationships', name: 'missing-root-relationships.docx' },
      { defect: 'missing-office-document-relationship', name: 'missing-office-document-relationship.docx' },
      { defect: 'missing-main-document-content-type', name: 'missing-main-document-content-type.docx' },
      { defect: 'override-main-document-content-type', name: 'override-main-document-content-type.docx' },
      { defect: 'foreign-main-document-namespace', name: 'foreign-main-document-namespace.docx' },
      { defect: 'wrong-main-document-root', name: 'wrong-main-document-root.docx' },
      { defect: 'missing-main-document-body', name: 'missing-main-document-body.docx' },
      { defect: 'foreign-main-document-relationship', name: 'foreign-main-document-relationship.docx' },
      { defect: 'foreign-main-document-content-type', name: 'foreign-main-document-content-type.docx' },
      { defect: 'missing-main-relationship-id', name: 'missing-main-relationship-id.docx' },
      { defect: 'duplicate-main-relationship-id', name: 'duplicate-main-relationship-id.docx' },
      { defect: 'foreign-main-relationship-attributes', name: 'foreign-main-relationship-attributes.docx' },
      { defect: 'foreign-default-content-type-attributes', name: 'foreign-default-content-type-attributes.docx' },
      { defect: 'foreign-override-content-type-attributes', name: 'foreign-override-content-type-attributes.docx' },
    ] as const
    const incompleteUploadMs: number[] = []
    for (const item of incompleteCases) {
      const incomplete = minimalOPCDocxFixture(false, item.defect)
      const chooser = page.waitForEvent('filechooser')
      const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
      const started = performance.now()
      await page.getByRole('button', { name: '添加附件', exact: true }).click()
      await (await chooser).setFiles({ name: item.name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: incomplete })
      const response = await upload
      incompleteUploadMs.push(Number((performance.now() - started).toFixed(2)))
      const body = await response.json() as { error?: { code?: string }; id?: string }
      if (response.status() === 200 && body.id) await api(page, 'DELETE', '/agent/attachments/' + body.id)
      expect(response.status()).toBe(422)
      expect(body.error?.code).toBe('agent_attachment_parse_failed')
      await expect(page.getByLabel(`${item.name} failed`, { exact: true })).toContainText('DOCX 已加密、损坏或解压内容超限')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: `移除 ${item.name}`, exact: true }).click()
      await expect(page.getByLabel(`${item.name} failed`, { exact: true })).toHaveCount(0)
    }
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_MINIMAL_OPC_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', valid_bytes: valid.byteLength, valid_status: validResponse.status(), valid_upload_ms: Number(validUploadMs.toFixed(2)), original_get_status: original.status, original_bytes: original.bytes, delete_status: 200, deleted_file_status: deletedStatus, external_bytes: external.byteLength, external_status: externalResponse.status(), external_upload_ms: Number(externalUploadMs.toFixed(2)), incomplete_cases: incompleteCases.map((item, index) => ({ defect: item.defect, upload_ms: incompleteUploadMs[index], status: 422 })), conversations: 0, message_posts: messagePosts })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-minimal-opc-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7-03 Windows Electron真实文件选择器拒绝DOCX大小写冲突部件', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-case-collision-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const document = docxCaseCollisionFixture()
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'case-collision.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document })
    const response = await upload
    const uploadMs = performance.now() - started
    const body = await response.json() as { error?: { code?: string } }
    expect(response.status()).toBe(422)
    expect(body.error?.code).toBe('agent_attachment_parse_failed')
    await expect(page.getByLabel('case-collision.docx failed', { exact: true })).toContainText('DOCX 已加密、损坏或解压内容超限')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_CASE_COLLISION_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', uploaded_bytes: document.byteLength, status: response.status(), upload_ms: Number(uploadMs.toFixed(2)), conversations: 0, message_posts: messagePosts })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-case-collision-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 G7-03 Windows Electron真实文件选择器拒绝DOCX非规范点段路径', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-dot-segment-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const document = docxNonCanonicalPathFixture()
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST')
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'noncanonical-path.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document })
    const response = await upload
    const uploadMs = performance.now() - started
    const body = await response.json() as { error?: { code?: string } }
    expect(response.status()).toBe(422)
    expect(body.error?.code).toBe('agent_attachment_parse_failed')
    await expect(page.getByLabel('noncanonical-path.docx failed', { exact: true })).toContainText('DOCX 已加密、损坏或解压内容超限')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_NONCANONICAL_PATH_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', uploaded_bytes: document.byteLength, status: response.status(), upload_ms: Number(uploadMs.toFixed(2)), conversations: 0, message_posts: messagePosts })}`)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-dot-segment-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron逐项拒绝文档解析边界且不允许发送', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc-boundary-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
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
    const pageBreakDoc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>分页不一致</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p></w:body></w:document>'
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
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>分页不一致</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p></w:body></w:document>',
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
      { name: 'malformed-xml.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:t>不完整 XML</w:p></w:body></w:document>' }), message: 'DOCX 已加密、损坏或解压内容超限' },
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
    console.log(`DEV-QA26_METRIC_DOCX_BOUNDARY_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', sample_count: attachmentDurations.length, rejected: failures.length, accepted: accepted.length, p50_ms: Number(sortedDurations[10].toFixed(2)), p95_ms: Number(sortedDurations[19].toFixed(2)), unexpected_failures: 0 })}`)
    console.log(`[DEV-QA26] Electron exact-100-page upload ms: ${attachmentDurations.at(-1)}`)
    console.log(`[DEV-QA26] Electron attachment rejection request ms: ${JSON.stringify(attachmentDurations.slice(0, expectedFailures))}`)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(page).toHaveURL(/\/agent\/?$/)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc-boundary-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser上传4MiB DOCX并核对解析回执与原件', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc4mib-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 4 * 1024 * 1024
    const file = docxLargeDocumentFixture(expandedBytes)
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-4mib.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    expect(response.status()).toBe(200)
    const receipt = await response.json() as { id: string; parse_status: string; page_count: number; extracted_chars: number; injected_chars: number; truncated_from: number; truncated_to: number }
    await expect(page.getByLabel('electron-document-4mib.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(receipt).toMatchObject({ parse_status: 'ready', page_count: 1, injected_chars: 20_000, truncated_from: 20_001 })
    expect(receipt.extracted_chars).toBeGreaterThan(expandedBytes - 100)
    expect(receipt.truncated_to).toBe(receipt.extracted_chars)
    const originalFile = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
    }, receipt.id)
    expect(originalFile).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
    expect(originalFile.bytes).toBeGreaterThan(0)
    const timing = response.request().timing()
    const uploadMs = timing.responseEnd - timing.requestStart
    console.log(`DEV-QA26_METRIC_DOCX_4MIB_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_document_bytes: expandedBytes, uploaded_bytes: file.byteLength, extracted_chars: receipt.extracted_chars, injected_chars: receipt.injected_chars, upload_ms: Number(uploadMs.toFixed(2)), unexpected_failures: 0 })}`)
    await page.getByRole('button', { name: '移除 electron-document-4mib.docx', exact: true }).click()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc4mib-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser上传4MiB 100页256条目DOCX并核对解析回执', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc4mib100p-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 4 * 1024 * 1024
    const pages = 100
    const totalEntries = 256
    const file = docxLargePageDocumentFixture(expandedBytes, pages, totalEntries)
    const directoryEnd = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(directoryEnd).toBe(file.length - 22)
    expect(file.readUInt16LE(directoryEnd + 10)).toBe(totalEntries)
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-4mib-100p-256e.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    expect(response.status()).toBe(200)
    const receipt = await response.json() as { id: string; parse_status: string; page_count: number; extracted_chars: number; injected_chars: number; truncated_from: number; truncated_to: number }
    await expect(page.getByLabel('electron-document-4mib-100p-256e.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(receipt).toMatchObject({ parse_status: 'ready', page_count: pages, injected_chars: 20_000, truncated_from: 20_001 })
    expect(receipt.extracted_chars).toBeGreaterThan(expandedBytes - 10_000)
    expect(receipt.truncated_to).toBe(receipt.extracted_chars)
    const original = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
    }, receipt.id)
    expect(original).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
    expect(original.bytes).toBeGreaterThan(0)
    const timing = response.request().timing()
    console.log(`DEV-QA26_METRIC_DOCX_4MIB_100P_256E_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_document_bytes: expandedBytes, pages, entries: totalEntries, uploaded_bytes: file.byteLength, extracted_chars: receipt.extracted_chars, upload_ms: Number((timing.responseEnd - timing.requestStart).toFixed(2)), failures: 0 })}`)
    await page.getByRole('button', { name: '移除 electron-document-4mib-100p-256e.docx', exact: true }).click()
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc4mib100p-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser上传5MiB 100页256条目DOCX并核对解析回执', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc5mib100p-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 5 * 1024 * 1024
    const pages = 100
    const totalEntries = 256
    const file = docxLargePageDocumentFixture(expandedBytes, pages, totalEntries)
    const directoryEnd = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(directoryEnd).toBe(file.length - 22)
    expect(file.readUInt16LE(directoryEnd + 10)).toBe(totalEntries)
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-5mib-100p-256e.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    expect(response.status()).toBe(200)
    const receipt = await response.json() as { id: string; parse_status: string; page_count: number; extracted_chars: number; injected_chars: number; truncated_from: number; truncated_to: number }
    await expect(page.getByLabel('electron-document-5mib-100p-256e.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
    expect(receipt).toMatchObject({ parse_status: 'ready', page_count: pages, injected_chars: 20_000, truncated_from: 20_001 })
    expect(receipt.extracted_chars).toBeGreaterThan(expandedBytes - 10_000)
    expect(receipt.truncated_to).toBe(receipt.extracted_chars)
    const original = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
    }, receipt.id)
    expect(original).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
    expect(original.bytes).toBeGreaterThan(0)
    const deletion = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/v1/agent/attachments/${receipt.id}` && item.request().method() === 'DELETE')
    await page.getByRole('button', { name: '移除 electron-document-5mib-100p-256e.docx', exact: true }).click()
    expect((await deletion).status()).toBe(200)
    const timing = response.request().timing()
    console.log(`DEV-QA26_METRIC_DOCX_5MIB_100P_256E_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_document_bytes: expandedBytes, pages, entries: totalEntries, uploaded_bytes: file.byteLength, extracted_chars: receipt.extracted_chars, upload_ms: Number((timing.responseEnd - timing.requestStart).toFixed(2)), unexpected_failures: 0 })}`)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc5mib100p-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser探测5.5MiB 100页256条目DOCX期限边界', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc55mib100p-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 5.5 * 1024 * 1024
    const pages = 100
    const totalEntries = 256
    const file = docxLargePageDocumentFixture(expandedBytes, pages, totalEntries)
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-5p5mib-100p-256e.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    const elapsedMs = performance.now() - started
    const result = await response.json() as { id?: string; parse_status?: string; page_count?: number; extracted_chars?: number; injected_chars?: number; truncated_from?: number; truncated_to?: number; error?: { code: string; message: string } }
    expect([200, 422]).toContain(response.status())
    if (response.status() === 200) {
      await expect(page.getByLabel('electron-document-5p5mib-100p-256e.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
      expect(result).toMatchObject({ parse_status: 'ready', page_count: pages, injected_chars: 20_000, truncated_from: 20_001 })
      expect(result.extracted_chars).toBeGreaterThan(expandedBytes - 10_000)
      expect(result.truncated_to).toBe(result.extracted_chars)
      const original = await page.evaluate(async (id) => {
        const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
      }, result.id!)
      expect(original).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
      expect(original.bytes).toBeGreaterThan(0)
      const deletion = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/v1/agent/attachments/${result.id}` && item.request().method() === 'DELETE')
      await page.getByRole('button', { name: '移除 electron-document-5p5mib-100p-256e.docx', exact: true }).click()
      expect((await deletion).status()).toBe(200)
    } else {
      expect(result.error).toMatchObject({ code: 'agent_attachment_parse_failed' })
      expect(result.error?.message).toMatch(/30 秒/)
      await expect(page.getByLabel('electron-document-5p5mib-100p-256e.docx failed', { exact: true })).toBeVisible()
      await expect(page.getByText(/30 秒/).last()).toBeVisible()
    }
    const timing = response.request().timing()
    console.log(`DEV-QA26_METRIC_DOCX_55MIB_100P_256E_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_document_bytes: expandedBytes, pages, entries: totalEntries, uploaded_bytes: file.byteLength, status: response.status(), outcome: result.parse_status ?? result.error?.code, click_to_response_ms: Number(elapsedMs.toFixed(2)), upload_post_ms: Number((timing.responseEnd - timing.requestStart).toFixed(2)), unexpected_failures: 0 })}`)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc55mib100p-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser探测6MiB DOCX解析边界', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc6mib-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 6 * 1024 * 1024
    const file = docxLargeDocumentFixture(expandedBytes)
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-6mib.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    const uploadMs = performance.now() - started
    const result = await response.json() as { id?: string; parse_status?: string; page_count?: number; extracted_chars?: number; injected_chars?: number; truncated_from?: number; truncated_to?: number; error?: { code: string; message: string } }
    expect([200, 422]).toContain(response.status())
    if (response.status() === 200) {
      await expect(page.getByLabel('electron-document-6mib.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
      expect(result).toMatchObject({ parse_status: 'ready', page_count: 1, injected_chars: 20_000, truncated_from: 20_001 })
      expect(result.extracted_chars).toBeGreaterThan(expandedBytes - 100)
      expect(result.truncated_to).toBe(result.extracted_chars)
      const original = await page.evaluate(async (id) => {
        const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
      }, result.id!)
      expect(original).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
      expect(original.bytes).toBeGreaterThan(0)
      await page.getByRole('button', { name: '移除 electron-document-6mib.docx', exact: true }).click()
    } else {
      expect(result.error).toMatchObject({ code: 'agent_attachment_parse_failed' })
      expect(result.error?.message).toMatch(/30 秒/)
      await expect(page.getByLabel('electron-document-6mib.docx failed', { exact: true })).toBeVisible()
      await expect(page.getByText(/30 秒/).last()).toBeVisible()
    }
    console.log(`DEV-QA26_METRIC_DOCX_6MIB_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_bytes: expandedBytes, uploaded_bytes: file.byteLength, status: response.status(), outcome: result.parse_status ?? result.error?.code, upload_ms: Number(uploadMs.toFixed(2)), failures: 0 })}`)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(page).toHaveURL(/\/agent\/?$/)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc6mib-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron filechooser探测5MiB DOCX解析边界', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-doc5mib-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 60_000 })
    const expandedBytes = 5 * 1024 * 1024
    const file = docxLargeDocumentFixture(expandedBytes)
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'electron-document-5mib.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file })
    const response = await upload
    const uploadMs = performance.now() - started
    const result = await response.json() as { id?: string; parse_status?: string; page_count?: number; extracted_chars?: number; injected_chars?: number; truncated_from?: number; truncated_to?: number; error?: { code: string; message: string } }
    expect([200, 422]).toContain(response.status())
    if (response.status() === 200) {
      await expect(page.getByLabel('electron-document-5mib.docx ready', { exact: true })).toBeVisible({ timeout: 60_000 })
      expect(result).toMatchObject({ parse_status: 'ready', page_count: 1, injected_chars: 20_000, truncated_from: 20_001 })
      expect(result.extracted_chars).toBeGreaterThan(expandedBytes - 100)
      expect(result.truncated_to).toBe(result.extracted_chars)
      const original = await page.evaluate(async (id) => {
        const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { status: response.status, bytes: bytes.byteLength, signature: new TextDecoder().decode(bytes.slice(0, 4)) }
      }, result.id!)
      expect(original).toMatchObject({ status: 200, signature: 'PK\u0003\u0004' })
      expect(original.bytes).toBeGreaterThan(0)
      const deletion = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/v1/agent/attachments/${result.id}` && item.request().method() === 'DELETE')
      await page.getByRole('button', { name: '移除 electron-document-5mib.docx', exact: true }).click()
      expect((await deletion).status()).toBe(200)
    } else {
      expect(result.error).toMatchObject({ code: 'agent_attachment_parse_failed' })
      expect(result.error?.message).toMatch(/30 秒/)
      await expect(page.getByLabel('electron-document-5mib.docx failed', { exact: true })).toBeVisible()
      await expect(page.getByText(/30 秒/).last()).toBeVisible()
    }
    console.log(`DEV-QA26_METRIC_DOCX_5MIB_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', expanded_bytes: expandedBytes, uploaded_bytes: file.byteLength, status: response.status(), outcome: result.parse_status ?? result.error?.code, parse_success: response.status() === 200, error_message: result.error?.message, upload_ms: Number(uploadMs.toFixed(2)) })}`)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(page).toHaveURL(/\/agent\/?$/)
    expect(messagePosts).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-doc5mib-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('DEV-QA26 Windows Electron DOCX解析后疑似密钥隔离且不回显', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要Windows Electron')
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-agent-qa26-docx-secret-'))
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ executablePath: resolve(process.cwd(), '../node_modules/electron/dist/electron.exe'),
      args: ['--user-data-dir=' + userData, resolve(process.cwd(), '../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000 })
    const page = await app.firstWindow()
    await prepare(page, baseURL!)
    let messagePosts = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/v1\/agent\/conversations\/[^/]+\/messages$/) && request.method() === 'POST') messagePosts++
    })
    const secret = 'sk-qa26docxsecret0123456789ABCDEF'
    const document = docxFixture({ 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>密钥 ${secret}</w:t></w:r></w:p></w:body></w:document>` })
    const chooser = page.waitForEvent('filechooser')
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/agent/attachments' && response.request().method() === 'POST', { timeout: 30_000 })
    const started = performance.now()
    await page.getByRole('button', { name: '添加附件', exact: true }).click()
    await (await chooser).setFiles({ name: 'suspect-key.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document })
    const response = await upload
    const uploadMs = performance.now() - started
    const receipt = await response.json() as { id: string; kind: string; name: string; url: string; parse_status: string; quarantine_code: string; injected_chars: number }
    expect(response.status()).toBe(200)
    expect(receipt).toMatchObject({ kind: 'document', name: 'suspect-key.docx', url: '', parse_status: 'quarantined', quarantine_code: 'suspected_secret', injected_chars: 0 })
    expect(JSON.stringify(receipt)).not.toContain(secret)
    const card = page.locator('[aria-label^="suspect-key.docx "]')
    await expect.poll(() => card.getAttribute('aria-label')).toBe('suspect-key.docx failed')
    await expect(card).toContainText('已隔离')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    const fileRead = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/agent/attachments/' + id + '/file')
      const body = await response.text()
      return { status: response.status, body }
    }, receipt.id)
    expect(fileRead.status).toBe(404)
    expect(fileRead.body).not.toContain(secret)
    expect((await api(page, 'GET', '/agent/conversations')).items).toHaveLength(0)
    expect(messagePosts).toBe(0)
    console.log(`DEV-QA26_METRIC_DOCX_SECRET_ELECTRON ${JSON.stringify({ environment: 'Windows native Electron; local E2E API and WASI parser', outcome: receipt.parse_status, uploaded_bytes: document.byteLength, upload_ms: Number(uploadMs.toFixed(2)), file_read_status: fileRead.status, conversations: 0, message_posts: messagePosts, failures: 0 })}`)
    await page.getByRole('button', { name: '移除 suspect-key.docx', exact: true }).click()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close()
    if (!resolve(userData).startsWith(resolve(tmpdir()) + sep) || !basename(userData).startsWith('ops-agent-qa26-docx-secret-')) throw new Error('拒绝清理测试目录之外路径')
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

