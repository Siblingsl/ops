// C3：Office OOXML 固定模板的最小 ZIP 读写器。
// 只支持 store/deflate 的普通条目（模板由本仓库离线生成），不处理 ZIP64、加密或分卷。
// 写出一律使用 store 与固定 DOS 时间 1980-01-01 00:00，保证同一输入输出同一字节序列。
import { inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset)
}

function u32(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

/** 读取 ZIP 中央目录，按条目原顺序返回 {name, data}。 */
export function readZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  let eocd = -1
  const lowerBound = Math.max(0, buffer.length - 65557)
  for (let offset = buffer.length - 22; offset >= lowerBound; offset--) {
    if (u32(buffer, offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Office 模板不是可解析的 ZIP（缺少中央目录结束记录）')
  const count = u16(buffer, eocd + 10)
  const centralSize = u32(buffer, eocd + 12)
  const centralOffset = u32(buffer, eocd + 16)
  if (count === 0 || centralOffset + centralSize > buffer.length) throw new Error('Office 模板 ZIP 中央目录无效')
  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index++) {
    if (u32(buffer, cursor) !== 0x02014b50) throw new Error('Office 模板 ZIP 中央目录条目签名无效')
    const flags = u16(buffer, cursor + 8)
    const method = u16(buffer, cursor + 10)
    const compressedSize = u32(buffer, cursor + 20)
    const uncompressedSize = u32(buffer, cursor + 24)
    const nameLength = u16(buffer, cursor + 28)
    const extraLength = u16(buffer, cursor + 30)
    const commentLength = u16(buffer, cursor + 32)
    const localOffset = u32(buffer, cursor + 42)
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    if ((flags & 0x0001) !== 0) throw new Error(`Office 模板 ZIP 条目已加密：${name}`)
    if (method !== 0 && method !== 8) throw new Error(`Office 模板 ZIP 条目压缩方式不受支持：${name}`)
    if (u32(buffer, localOffset) !== 0x04034b50) throw new Error(`Office 模板 ZIP 本地头签名无效：${name}`)
    const localNameLength = u16(buffer, localOffset + 26)
    const localExtraLength = u16(buffer, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (data.length !== uncompressedSize) throw new Error(`Office 模板 ZIP 条目解压长度不一致：${name}`)
    if (!name.endsWith('/')) entries.push({ name, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** store 方式写 ZIP：固定顺序、固定时间、UTF-8 文件名。 */
export function writeZipStore(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP 至少需要一个条目')
  const seen = new Set()
  for (const entry of entries) {
    const name = entry?.name
    if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00\r\n]/.test(name) ||
      name.startsWith('/') || name.endsWith('/')) {
      throw new Error('ZIP 条目名必须是安全的相对路径')
    }
    if (name.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error(`ZIP 条目名包含不安全的路径段：${name}`)
    }
    if (seen.has(name)) throw new Error(`ZIP 条目名重复：${name}`)
    seen.add(name)
    if (!Buffer.isBuffer(entry.data) && !(entry.data instanceof Uint8Array)) throw new Error(`ZIP 条目缺少字节：${name}`)
  }
  const locals = []
  const centrals = []
  let offset = 0
  const dosTime = 0
  const dosDate = (0 << 9) | (1 << 5) | 1
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    data.copy(local, 30 + nameBytes.length)
    locals.push(local)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((total, item) => total + item.length, 0)
  const output = Buffer.alloc(offset + centralSize + 22)
  let cursor = 0
  for (const local of locals) {
    local.copy(output, cursor)
    cursor += local.length
  }
  for (const central of centrals) {
    central.copy(output, cursor)
    cursor += central.length
  }
  output.writeUInt32LE(0x06054b50, cursor)
  output.writeUInt16LE(0, cursor + 4)
  output.writeUInt16LE(0, cursor + 6)
  output.writeUInt16LE(entries.length, cursor + 8)
  output.writeUInt16LE(entries.length, cursor + 10)
  output.writeUInt32LE(centralSize, cursor + 12)
  output.writeUInt32LE(offset, cursor + 16)
  output.writeUInt16LE(0, cursor + 20)
  return output
}
