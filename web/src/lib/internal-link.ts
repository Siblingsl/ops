// 站内链接判定（docs/28 §2.2）。模型输出的 Markdown 可以控制 href，
// 随后会交给 react-router 的 navigate()/Link，因此这里必须做严格白名单：
//   - 必须以单个 "/" 开头（协议相对地址 "//host" 直接拒绝）；
//   - 一律拒绝反斜杠——CVE-2026-53669 就是 "\" 被当作路径分隔符导致站外跳转；
//   - 拒绝控制字符与首尾空白（浏览器会裁剪/截断，容易藏东西）；
//   - 拒绝百分号编码的绕过（%5C / %2F%2F），只查前 16 个字符即可覆盖 host 位置。
// 注意：这不是「URL 校验器」，只回答「能不能作为站内路由交给 react-router」。

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const MAX_LENGTH = 2048

export function isInternalPath(href: string): boolean {
  if (!href || href.length > MAX_LENGTH) return false
  if (href !== href.trim()) return false
  if (!href.startsWith('/')) return false
  if (href.startsWith('//')) return false
  if (href.includes('\\')) return false
  if (CONTROL_CHARS.test(href)) return false
  const head = href.slice(0, 16).toLowerCase()
  if (head.includes('%5c') || head.includes('%2f%2f')) return false
  return true
}
