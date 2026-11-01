export type CanonicalValue = null | boolean | string | number | bigint | CanonicalValue[] | { [key: string]: CanonicalValue }

/** Canonical JSON bytes for docs/24 §4.6 immutable snapshots and parameters. */
export function canonicalJSON(value: CanonicalValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('规范 JSON 只接受安全整数；小数须先转成固定精度字符串')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (typeof value === 'object') {
    const normalized = new Map<string, CanonicalValue>()
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new TypeError('规范 JSON 不接受 undefined 字段')
      const normalizedKey = normalizeNewlines(key)
      if (normalized.has(normalizedKey)) throw new TypeError('对象键换行归一后发生冲突')
      normalized.set(normalizedKey, item)
    }
    const keys = [...normalized.keys()].sort(compareCodePoints)
    return `{${keys.map((key) => `${quote(key)}:${canonicalJSON(normalized.get(key)!)}`).join(',')}}`
  }
  throw new TypeError(`规范 JSON 不支持 ${typeof value}`)
}

function quote(input: string): string {
  const value = normalizeNewlines(input)
  let output = '"'
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new TypeError('规范 JSON 不接受无效 Unicode 字符串')
    switch (character) {
      case '"': output += '\\"'; break
      case '\\': output += '\\\\'; break
      case '\b': output += '\\b'; break
      case '\f': output += '\\f'; break
      case '\n': output += '\\n'; break
      case '\r': output += '\\r'; break
      case '\t': output += '\\t'; break
      default:
        output += codePoint < 0x20 ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character
    }
  }
  return `${output}"`
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!)
  const b = Array.from(right, (character) => character.codePointAt(0)!)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}
