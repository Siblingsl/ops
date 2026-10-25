// DEV-SK4 / 23 文档第 5.2.1 节：规范编码 C(v) 与指纹 H(v) 的前端实现。
// 必须与 server/internal/app/skills_canon.go 保持同一口径：
// UTF-8 紧凑 JSON；对象键按 UTF-8 字节序递归升序；数组保持给定顺序；
// 整数十进制；字符串只转义双引号、反斜杠与 U+0000–001F（小写四位 \u00xx），
// 不转义中文、/、<>&、U+2028/2029。测试向量与后端一致（skills_canon_test.go）。

export type CanonValue =
  | null
  | boolean
  | number
  | string
  | CanonValue[]
  | { [key: string]: CanonValue }

/** canonicalJSON 序列化；浮点数（非整数）会被拒绝，与后端一致。 */
export function canonicalJSON(v: CanonValue): string {
  return canonValue(v)
}

function canonValue(v: CanonValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('规范编码不接受浮点数')
    return String(v)
  }
  if (typeof v === 'string') return canonString(v)
  if (Array.isArray(v)) return '[' + v.map(canonValue).join(',') + ']'
  const keys = Object.keys(v).sort(utf8ByteCompare)
  const parts = keys.map((k) => canonString(k) + ':' + canonValue(v[k]))
  return '{' + parts.join(',') + '}'
}

function canonString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

// UTF-8 字节序比较：对 BMP 内字符与 String 默认序一致；
// 代理对（U+10000+）在 UTF-16 中小于 U+E000–U+FFFF，字节序中大于，这里按码位比较。
function utf8ByteCompare(a: string, b: string): number {
  const ia = Array.from(a).map((c) => c.codePointAt(0)!)
  const ib = Array.from(b).map((c) => c.codePointAt(0)!)
  const n = Math.min(ia.length, ib.length)
  for (let i = 0; i < n; i++) {
    if (ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1
  }
  return ia.length - ib.length
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** H(v) = C(v) 的 SHA-256 小写十六进制。 */
export async function canonHash(v: CanonValue): Promise<string> {
  return sha256Hex(canonicalJSON(v))
}

/** DefinitionFields 是指纹覆盖的最终规范化字段（不含 ID、归属、修订、来源或时间）。 */
export interface DefinitionFields {
  name: string
  summary: string
  triggers: string
  instructions: string
  platforms: string[]
  content_formats: string[]
  task_types: string[]
  task_enabled: boolean
  agent_enabled: boolean
  status: string
}

function definitionCanon(f: DefinitionFields): CanonValue {
  const n = normalizeDefinitionFields(f)
  return {
    name: n.name, summary: n.summary, triggers: n.triggers, instructions: n.instructions,
    platforms: n.platforms, content_formats: n.content_formats, task_types: n.task_types,
    task_enabled: n.task_enabled, agent_enabled: n.agent_enabled, status: n.status,
  }
}

/** normalizeDefinitionFields 与服务端 normalizeSkillText / validateSkillFields 同一口径：
 * CRLF/CR → LF；name/summary/triggers 去首尾 Unicode 空白；三个数组去重并按字节序升序。 */
export function normalizeDefinitionFields(f: DefinitionFields): DefinitionFields {
  const lf = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return {
    name: lf(f.name).trim(),
    summary: lf(f.summary).trim(),
    triggers: lf(f.triggers).trim(),
    instructions: lf(f.instructions),
    platforms: normArr(f.platforms),
    content_formats: normArr(f.content_formats),
    task_types: normArr(f.task_types),
    task_enabled: f.task_enabled,
    agent_enabled: f.agent_enabled,
    status: f.status,
  }
}

function normArr(a: string[]): string[] {
  return [...new Set(a)].sort(utf8ByteCompare)
}

export interface PublishTarget {
  operation: 'create' | 'update'
  skillId: string | null
  scope: string
  accountId: string | null
}

/** sp1 公开确认摘要："sp1:" + H({operation,skill_id,scope,account_id,fields})。 */
export async function publishDigest(op: PublishTarget, fields: DefinitionFields): Promise<string> {
  const h = await canonHash({
    operation: op.operation,
    skill_id: op.skillId,
    scope: op.scope,
    account_id: op.accountId,
    fields: definitionCanon(fields),
  })
  return 'sp1:' + h
}
