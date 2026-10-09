export function runeLen(s: string): number {
  return [...(s || '')].length
}

export function fmtTime(iso?: string | null, withYear = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay && !withYear) return `今天 ${hm}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString() && !withYear) return `昨天 ${hm}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() !== now.getFullYear() || withYear ? `${d.getFullYear()}年${md} ${hm}` : `${md} ${hm}`
}

export function relTime(iso?: string | null): string {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return fmtTime(iso)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtNum(n?: number | null): string {
  if (n === null || n === undefined) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`
  return n.toLocaleString('zh-CN')
}

export function toLocalInput(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function parseTopics(s: string): string[] {
  return s.split(/[\s,，]+/).map((t) => t.replace(/^#/, '')).filter(Boolean)
}

export interface AIRefs {
  profile?: boolean
  style_samples?: number
  style_summary?: boolean
  materials?: string[] | null
  works?: number
}

/** describeRefs renders "本次参考了什么" for an AI result (FR-M2-04). */
export function describeRefs(r?: AIRefs | null): string {
  if (!r) return ''
  const parts: string[] = []
  if (r.profile) parts.push('定位档案')
  if (r.style_samples) parts.push(`风格样本 ${r.style_samples} 篇`)
  if (r.style_summary) parts.push('风格描述')
  if (r.materials?.length) parts.push('素材' + r.materials.map((m) => `「${m}」`).join(''))
  if (r.works) parts.push(`作品数据 ${r.works} 篇`)
  return parts.length ? `本次参考：${parts.join('、')}` : ''
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}
