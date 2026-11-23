// C3：由 shared/office-templates.json 生成固定 OOXML 模板文件。
// 模板部件以 base64 存放，避免仓库里出现不可审查的二进制中间态；
// 本脚本是唯一的模板发布入口，render.mjs 运行时只读取生成的 .pptx/.docx。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZipStore } from './zip.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const templatesDir = join(here, 'templates')
mkdirSync(templatesDir, { recursive: true })
const data = JSON.parse(readFileSync(join(here, '..', '..', 'shared', 'office-templates.json'), 'utf8'))
if (data.version !== 'office-render-v1') throw new Error(`模板版本不是 office-render-v1：${data.version}`)

for (const kind of ['pptx', 'docx']) {
  const parts = data[kind]
  if (!Array.isArray(parts) || parts.length === 0) throw new Error(`缺少 ${kind} 模板部件`)
  const entries = parts.map(part => {
    if (typeof part.name !== 'string' || typeof part.base64 !== 'string') throw new Error(`${kind} 模板部件格式无效`)
    return { name: part.name, data: Buffer.from(part.base64, 'base64') }
  })
  const core = entries.find(entry => entry.name === 'docProps/core.xml')
  if (!core || !Buffer.from(core.data).toString('utf8').match(/<dc:description>\s*由 OPS 生成\s*<\/dc:description>/)) {
    throw new Error(`${kind} 模板 docProps/core.xml 缺少 dc:description“由 OPS 生成”`)
  }
  const output = writeZipStore(entries)
  const target = join(templatesDir, kind === 'pptx' ? 'deck-v1.pptx' : 'doc-v1.docx')
  writeFileSync(target, output)
  console.log(`${kind}: ${entries.length} parts, ${output.length} bytes -> ${target}`)
}
