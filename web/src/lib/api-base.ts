// API 基址（D-153）。web 前端托管到 Cloudflare Pages 后，页面与 API 不再同源，
// 需要一个可配置的后端地址；但同一份代码还要服务三种同源场景：
//   1. 本地开发：vite 代理 /api 到 :8080；
//   2. 后端自己托管的静态页（桌面端 businessOrigin 指向 ops.88813888.xyz）；
//   3. 云服务器直连。
// 因此基址默认空串 = 继续用相对路径，只有显式配置 OPS_API_BASE 时才变成绝对地址。
//
// 构建期注入（见 vite.config.ts 的 define）：OPS_API_BASE=https://ops.88813888.xyz
const RAW_BASE = typeof __OPS_API_BASE__ === 'string' ? __OPS_API_BASE__ : ''

/** apiBase 返回不带结尾斜杠的 API 基址；空串表示同源相对路径。 */
export function apiBase(): string {
  return RAW_BASE.replace(/\/+$/, '')
}

/** apiUrl 把 /xxx 形式的业务路径拼成可请求的地址（/api/v1 前缀在此统一补）。 */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${apiBase()}/api/v1${p}`
}

/**
 * assetUrl 把后端返回的相对资产地址（/api/v1/assets/...）拼成可访问地址。
 * 后端所有资产 URL 都是相对路径（assets.go、comic.go 等），跨源时必须拼基址；
 * 已经是绝对地址（外链图片、data: URL）的原样返回。
 */
export function assetUrl(url: string): string {
  if (!url) return url
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url
  const base = apiBase()
  if (!base) return url
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

/** isCrossOrigin 表示当前是否跨源部署（决定 fetch 是否必须 credentials: 'include'）。 */
export function isCrossOrigin(): boolean {
  return apiBase() !== ''
}

/**
 * assetHtml 把渲染好的 HTML 里所有相对资产地址改写成可访问地址，仅用于浏览器展示。
 * 注意：只能用在"显示"路径上——推送到公众号的 HTML 必须保持相对路径，
 * 后端靠 assetIDFromURL 解析 `/api/v1/assets/{id}/file`（assets.go），
 * 换成绝对地址会被判成外链图片并拒绝。
 */
export function assetHtml(html: string): string {
  const base = apiBase()
  if (!base || !html) return html
  return html.replace(/(\ssrc=["'])\/api\/v1\//g, `$1${base}/api/v1/`)
}
