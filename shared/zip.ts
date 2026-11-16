// 最小 ZIP（store，无压缩）打包器：组图交付包只含已压缩的 PNG，再压一遍没有收益。
// 不引第三方依赖；文件名按 UTF-8 写入并置 bit 11，与两端渲染器的序号命名保持一致。

export type ZipStoreEntry = { name: string; data: Uint8Array }

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function zipStore(entries: ZipStoreEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error('ZIP 至少需要一个条目')
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.name || entry.name.includes('/') || entry.name.includes('\\') || entry.name.startsWith('.')) {
      throw new Error('ZIP 条目名必须是单层安全文件名')
    }
    if (seen.has(entry.name)) throw new Error(`ZIP 条目名重复：${entry.name}`)
    seen.add(entry.name)
  }
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  // 固定 DOS 时间（1980-01-01 00:00），避免时区差异让同一输入产生不同字节。
  const dosTime = 0
  const dosDate = (0 << 9) | (1 << 5) | 1
  for (const entry of entries) {
    const nameBytes = utf8(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, dosTime, true)
    localView.setUint16(12, dosDate, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(entry.data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, dosTime, true)
    centralView.setUint16(14, dosDate, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((total, item) => total + item.length, 0)
  const output = new Uint8Array(offset + centralSize + 22)
  let cursor = 0
  for (const local of locals) {
    output.set(local, cursor)
    cursor += local.length
  }
  for (const central of centrals) {
    output.set(central, cursor)
    cursor += central.length
  }
  const end = new DataView(output.buffer)
  end.setUint32(cursor, 0x06054b50, true)
  end.setUint16(cursor + 4, 0, true)
  end.setUint16(cursor + 6, 0, true)
  end.setUint16(cursor + 8, entries.length, true)
  end.setUint16(cursor + 10, entries.length, true)
  end.setUint32(cursor + 12, centralSize, true)
  end.setUint32(cursor + 16, offset, true)
  end.setUint16(cursor + 20, 0, true)
  return output
}

/** dataURL（image/png;base64,...）转字节；组图渲染器只产出 PNG dataURL。 */
export function dataURLBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.startsWith('data:')) throw new Error('组图 PNG 数据格式无效')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
