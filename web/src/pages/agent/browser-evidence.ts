// A11（27 §11/§13）：Web 端不展示浏览器证据正文，只如实标注"仅桌面可见"。
// 规则抽成纯函数便于单测：无证据、请求失败（count=null）、非法计数都不渲染占位，
// 避免把"没有证据"显示成"加载失败"，也避免凭空显示 0 条。

export interface BrowserEvidenceNotice {
  count: number
  text: string
}

export function browserEvidenceNotice(count: number | null | undefined): BrowserEvidenceNotice | null {
  if (count === null || count === undefined) return null
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) return null
  return {
    count,
    text: `本对话包含 ${count} 条浏览器来源证据（页面读取与回查记录）。证据正文仅桌面端可查看，这里不展示、也不以摘要替代。`,
  }
}
