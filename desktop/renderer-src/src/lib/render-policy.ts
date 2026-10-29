/**
 * 渲染策略的纯函数部分（ED-06 / ED-07 / ED-08 / ED-12 / PB-15）。
 *
 * 这些逻辑原本埋在 `render.ts` 里，依赖 DOMParser 才能跑到，导致 web/tests 无法覆盖。
 * 抽出来后：预览白名单、降级样式、样式合并、标题层级归一化都能被 node:test 直接验证。
 * `render.ts` 只保留 DOM 操作，两份实现不会漂移。
 */

/**
 * 预览白名单：与服务端 `server/internal/app/publish.go:101-111` 的 bluemonday 策略对齐。
 *
 * 服务端是 `UGCPolicy()` + `AllowElements("section","span")` + `AllowAttrs("style")`，
 * 其 UGC 默认允许的元素包含 article/aside/div/dl/dt/dd/table/thead/tbody/tfoot/tr/td/th/
 * caption/pre/code/del/ins/s/strike/details/summary/h1-h6 等。
 * ED-08 的原始症状是前端只有 19 个标签，表格/代码块在预览里被降级成纯文本、推送后却保留。
 */
export const allowedTags: ReadonlySet<string> = new Set([
  'section', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'blockquote',
  'ul', 'ol', 'li',
  'dl', 'dt', 'dd',
  'strong', 'b', 'em', 'i',
  'a', 'img', 'br', 'hr', 'del', 's', 'strike', 'ins',
  'pre', 'code', 'kbd', 'mark', 'small', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'details', 'summary',
  'figure', 'figcaption',
])

export const allowedAttrs: ReadonlySet<string> = new Set(['href', 'src', 'alt', 'style', 'data-asset'])

/** 服务端 `AllowStyles(...)` 放行的 CSS 属性（publish.go:104-108），前端合并样式时不能超出这个范围。 */
export const allowedStyleProps: ReadonlySet<string> = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'border', 'border-left', 'border-right', 'border-top', 'border-radius',
  'display', 'width', 'max-width', 'height', 'word-break', 'white-space', 'font-family',
  'box-sizing', 'overflow-wrap', 'list-style-type', 'background',
  // 表格/代码块（ED-06）需要的属性，服务端 publish.go:104-112 已同步放行
  'border-collapse', 'caption-side', 'overflow-x',
])

/** 表格/代码块等不带主题样式的标签，给一份基础样式，避免在公众号里挤成一坨纯文本（ED-06）。 */
export const fallbackStyles: Readonly<Record<string, string>> = {
  table: 'border-collapse:collapse;width:100%;margin:0 0 18px;font-size:14px;',
  th: 'border:1px solid #e0e0e0;padding:6px 10px;background-color:#f7f7f7;text-align:left;font-weight:bold;',
  td: 'border:1px solid #e0e0e0;padding:6px 10px;',
  caption: 'caption-side:top;text-align:left;font-size:13px;color:#888;padding-bottom:6px;',
  pre: 'margin:0 0 18px;padding:12px 14px;background-color:#f6f8fa;border-radius:4px;overflow-x:auto;font-size:13px;line-height:1.6;',
  code: 'font-family:Menlo,Consolas,monospace;font-size:13px;background-color:#f6f8fa;padding:1px 4px;border-radius:3px;',
  dl: 'margin:0 0 18px;',
  dt: 'font-weight:bold;margin:0 0 6px;',
  dd: 'margin:0 0 12px;padding-left:16px;',
  figcaption: 'font-size:12.5px;color:#888;text-align:center;margin:-10px 0 18px;',
}

/** 把 `a:b;c:d` 解析成有序键值对。 */
export function parseStyle(value: string | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const piece of (value ?? '').split(';')) {
    const at = piece.indexOf(':')
    if (at <= 0) continue
    const key = piece.slice(0, at).trim().toLowerCase()
    const val = piece.slice(at + 1).trim()
    if (key && val) out.push([key, val])
  }
  return out
}

/**
 * PB-15 样式合并：主题默认值打底，作者内联样式按属性覆盖。
 * 原实现是「作者有 style 就整体跳过主题」，作者只改了一个颜色，段间距/字号/行距全丢。
 * 不在服务端白名单里的属性直接丢掉，避免预览好看、推送被 bluemonday 洗掉（ED-08 的同一类问题）。
 */
export function mergeStyle(themeStyle: string, authorStyle: string | null | undefined): string {
  const merged = new Map(parseStyle(themeStyle))
  for (const [key, val] of parseStyle(authorStyle)) {
    if (!allowedStyleProps.has(key)) continue
    merged.set(key, val)
  }
  return Array.from(merged, ([key, val]) => `${key}:${val}`).join(';') + (merged.size > 0 ? ';' : '')
}

/**
 * ED-12 标题层级归一化：
 *  - `section.heading`（段落小标题）由渲染层单独输出为 `<h2>`，与正文无关；
 *  - 正文里的 Markdown `#`/`##` 统一降到 `<h3>`，避免和段落小标题抢同一层；
 *  - 正文里的 `####` 及更深转成 `<p><strong>`，保留强调但不参与大纲。
 * ED-10：只改标签层级，不动 `---`、``` 围栏与行内代码，往返序列化交给编辑器。
 */
export function normalizeBodyHeadings(body: string): string {
  return body
    .replace(/<h[12]>([\s\S]*?)<\/h[12]>/g, '<h3>$1</h3>')
    .replace(/<h[4-6]>([\s\S]*?)<\/h[4-6]>/g, '<p><strong>$1</strong></p>')
}

/**
 * ED-11：tiptap-markdown 在 `html: false` 时会把不认识的 HTML 序列化成 `[markdownHTMLNode]`。
 * 渲染前把这些占位符去掉，避免字面量漏进预览和推送。
 */
export function stripMarkdownPlaceholders(md: string): string {
  return md.replace(/\[markdownHTMLNode\]/g, '')
}
