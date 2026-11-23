// C3：独立 Node Office 渲染进程。
// 输入 stdin JSON（target/template/title/subtitle/sections/body/meta），输出固定模板的
// .pptx/.docx 到 --out。只做占位替换与文本填充，不做生成式排版；
// 模板部件顺序、ZIP 时间戳与文件内容完全固定，同一输入重复执行得到同一 SHA256。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip, writeZipStore } from './zip.mjs'

const COVER_MAX_BYTES = 24 << 20
const COVER_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
}

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : ''
if (!outPath) {
  process.stderr.write('Office 渲染器缺少 --out 输出路径\n')
  process.exit(2)
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function normalize(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').replace(/[\t ]+/g, ' ').trim()
  return Array.from(text).slice(0, max).join('')
}

function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim()
}

function bodyFromSections(sections) {
  if (!Array.isArray(sections)) return ''
  return sections.map(section => {
    const heading = String(section?.heading ?? '').trim()
    const content = plainText(section?.content_md ?? section?.content ?? section?.body)
    return heading ? `${heading}：${content}` : content
  }).filter(Boolean).join(' ')
}

// 封面主图：只接受位图，base64 输入；哈希参与文件名，保证同一图片/同一输入同字节。
function parseCover(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('cover 必须是对象')
  const raw = value.data_base64
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('cover.data_base64 必填')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) throw new Error('封面主图大小必须在 1 字节到 24 MiB 之间')
  const mime = String(value.mime ?? '').trim().toLowerCase()
  const ext = COVER_MIME_EXT[mime]
  if (!ext) throw new Error(`封面主图 MIME 不受支持：${mime || '(空)'}`)
  const png = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const gif = bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  if ((ext === 'png' && !png) || ((ext === 'jpeg' || ext === 'jpg') && !jpeg) || (ext === 'gif' && !gif)) {
    throw new Error('封面主图字节与声明格式不一致')
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const declaredHash = String(value.sha256 ?? '').trim().toLowerCase()
  if (declaredHash && declaredHash !== hash) throw new Error('封面主图哈希与字节不一致')
  return {
    data: bytes,
    ext,
    hash,
    width: Math.max(0, Number(value.width) || 0),
    height: Math.max(0, Number(value.height) || 0),
  }
}

function coverAspect(cover) {
  return cover.width > 0 && cover.height > 0 ? cover.width / cover.height : 16 / 9
}

function fitInside(boxW, boxH, aspect) {
  let cx = boxW
  let cy = Math.round(boxW / aspect)
  if (cy > boxH) {
    cy = boxH
    cx = Math.round(boxH * aspect)
  }
  return { cx, cy }
}

// PPTX 封面：图片固定在右侧面板内等比缩放，标题/副标题收窄到左侧，避免文字压图。
function pptxCoverXml(cover, relId) {
  const panelX = 7315200
  const panelY = 304800
  const panelW = 4572000
  const panelH = 6248400
  const { cx, cy } = fitInside(panelW, panelH, coverAspect(cover))
  const x = panelX + Math.round((panelW - cx) / 2)
  const y = panelY + Math.round((panelH - cy) / 2)
  return `<p:pic><p:nvPicPr><p:cNvPr id="10" name="Cover Image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

// DOCX 封面：图片居中放在副标题后，随后分页，正文从下一页开始。
function docxCoverXml(cover, relId) {
  const { cx, cy } = fitInside(5700000, 4200000, coverAspect(cover))
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Cover Image"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Cover Image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>`
}

function addCover(entries, target, cover) {
  if (!cover) return entries
  const mediaName = target === 'pptx'
    ? `ppt/media/cover-${cover.hash.slice(0, 16)}.${cover.ext}`
    : `word/media/cover-${cover.hash.slice(0, 16)}.${cover.ext}`
  const withMedia = entries.slice()
  const anchorName = target === 'pptx' ? 'ppt/slides/slide1.xml' : 'word/document.xml'
  const anchor = withMedia.findIndex(entry => entry.name === anchorName)
  if (anchor < 0) throw new Error(`模板缺少 ${anchorName}，无法嵌入封面主图`)
  withMedia.splice(anchor, 0, { name: mediaName, data: cover.data })
  return withMedia.map(entry => {
    if (target === 'pptx' && entry.name === 'ppt/slides/slide1.xml') {
      const pic = pptxCoverXml(cover, 'rId3')
      let text = Buffer.from(entry.data).toString('utf8')
      // 图片占右侧，标题/副标题同步收窄；固定值来自模板，不使用动态排版。
      text = text.replace(/cx="10881360"/g, 'cx="6200000"')
      text = text.replace('<p:sp>', `${pic}<p:sp>`)
      return { name: entry.name, data: Buffer.from(text, 'utf8') }
    }
    if (target === 'pptx' && entry.name === 'ppt/slides/_rels/slide1.xml.rels') {
      const text = Buffer.from(entry.data).toString('utf8').replace('</Relationships>',
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName.split('/').pop()}"/></Relationships>`)
      return { name: entry.name, data: Buffer.from(text, 'utf8') }
    }
    if (target === 'docx' && entry.name === 'word/document.xml') {
      let text = Buffer.from(entry.data).toString('utf8')
      const subtitleAt = text.indexOf('{{SUBTITLE}}')
      if (subtitleAt < 0) throw new Error('DOCX 模板缺少 {{SUBTITLE}}，无法定位封面主图')
      const paragraphEnd = text.indexOf('</w:p>', subtitleAt)
      if (paragraphEnd < 0) throw new Error('DOCX 模板副标题段落未闭合')
      const insertAt = paragraphEnd + '</w:p>'.length
      text = text.slice(0, insertAt) + docxCoverXml(cover, 'rId9') + text.slice(insertAt)
      return { name: entry.name, data: Buffer.from(text, 'utf8') }
    }
    if (target === 'docx' && entry.name === 'word/_rels/document.xml.rels') {
      const text = Buffer.from(entry.data).toString('utf8').replace('</Relationships>',
        `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName.split('/').pop()}"/></Relationships>`)
      return { name: entry.name, data: Buffer.from(text, 'utf8') }
    }
    return entry
  })
}

function readStdin() {
  return new Promise((resolveInput, reject) => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => resolveInput(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

try {
  const request = JSON.parse(await readStdin())
  const target = request?.target
  if (target !== 'pptx' && target !== 'docx') throw new Error('target 必须是 pptx 或 docx')
  const template = request?.template || (target === 'pptx' ? 'deck-v1' : 'doc-v1')
  const expectedTemplate = target === 'pptx' ? 'deck-v1' : 'doc-v1'
  if (template !== expectedTemplate) throw new Error(`target ${target} 只允许模板 ${expectedTemplate}`)
  if (request?.meta?.aigc === false) throw new Error('AIGC 标识不可关闭')

  const work = request?.work && typeof request.work === 'object' ? request.work : {}
  const title = normalize(request?.title ?? work.title, 240) || '未命名作品'
  const subtitle = normalize(request?.subtitle ?? work.summary ?? work.viewpoint, 240)
  const body = normalize(
    request?.body ?? bodyFromSections(request?.sections) ?? '',
    6000,
  ) || '暂无正文内容。'
  const revision = Math.max(1, Number.isFinite(Number(request?.meta?.revision)) ? Math.trunc(Number(request.meta.revision)) : Number(work.revision) || 1)

  const templatePath = join(here, 'templates', `${expectedTemplate}.${target}`)
  const entries = readZip(readFileSync(templatePath))
  const cover = parseCover(request?.cover)
  const sourceEntries = addCover(entries, target, cover)
  const values = {
    '{{TITLE}}': xmlEscape(title),
    '{{SUBTITLE}}': xmlEscape(subtitle),
    '{{BODY}}': xmlEscape(body),
    '{{REVISION}}': String(revision),
  }
  const rendered = sourceEntries.map(entry => {
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) return entry
    let text = entry.data.toString('utf8')
    text = text.replace(/\{\{TITLE\}\}|\{\{SUBTITLE\}\}|\{\{BODY\}\}|\{\{REVISION\}\}/g, token => values[token] ?? token)
    if (/\{\{(?:TITLE|SUBTITLE|BODY|REVISION)\}\}/.test(text)) throw new Error(`模板占位符未完全替换：${entry.name}`)
    return { name: entry.name, data: Buffer.from(text, 'utf8') }
  })
  const custom = rendered.find(entry => entry.name === 'docProps/custom.xml')
  if (!custom || !Buffer.from(custom.data).toString('utf8').match(/<property[^>]*name="AIGC"[^>]*>\s*<vt:bool>\s*true\s*<\/vt:bool>\s*<\/property>/i)) {
    throw new Error('渲染结果缺少 AIGC 文档属性')
  }
  const core = rendered.find(entry => entry.name === 'docProps/core.xml')
  if (!core || !Buffer.from(core.data).toString('utf8').match(/<dc:description>\s*由 OPS 生成\s*<\/dc:description>/)) {
    throw new Error('渲染结果缺少核心属性“由 OPS 生成”声明')
  }
  if (target === 'docx') {
    const footer = rendered.find(entry => entry.name.startsWith('word/footer') && entry.name.endsWith('.xml'))
    if (!footer || !Buffer.from(footer.data).toString('utf8').includes('AI 生成内容')) throw new Error('DOCX 渲染结果缺少 AI 生成内容页脚')
  }
  const bytes = writeZipStore(rendered)
  mkdirSync(dirname(outPath), { recursive: true })
  const tempPath = `${outPath}.tmp`
  writeFileSync(tempPath, bytes)
  renameSync(tempPath, outPath)
  process.stdout.write(JSON.stringify({ target, template, bytes: bytes.length, revision }) + '\n')
} catch (error) {
  process.stderr.write(`Office 渲染失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
