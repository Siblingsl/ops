import { marked } from 'marked'
import { getCustomTheme } from './custom-theme-state'
import { allowedAttrs, allowedTags, fallbackStyles, mergeStyle, normalizeBodyHeadings, stripMarkdownPlaceholders } from './render-policy'
import type { Asset, CustomTheme, Section } from './types'

/**
 * 公众号 HTML 渲染模块（FR-M6-01、D-015）。预览、检查统计和推送都使用这里的输出，保证所见即所得。
 * 主题只用基础样式（字号、颜色、行距、边框、背景色、边距），等 SP-02 实测后再校准（T-01）。
 */

/**
 * 白名单来源：server/internal/app/publish.go:106 htmlPolicy（bluemonday v1.0.27 UGCPolicy + AllowElements("section","span")）
 *
 * ED-08 同步要求：
 *   - preview 白名单必须与 backend push 白名单对齐，避免"预览能看但推送被洗掉"。
 *   - backend 使用 bluemonday.UCGPolic()y，其默认允许的元素清单参见 go/pkg/mod/github.com/microcosm-cc/bluemonday@v1.0.27/policies.go；
 *     本前端额外显式列出部分元素以保证可读性测试与明确意图。
 *   - 若后端策略变更，需同时更新此处白名单并加注释说明。
 *
 * 当前对齐状态（2026-10-23）：
 *   - frontend allowedTags = backend UGCPolicy default + ["section","span"]（explicit AllowElements）
 *   - 已知后端未显式放行但 UGC 默认的标签：table/thead/tbody/tr/th/caption/pre/code 等（见解压 b8: policies.go）
 *
 * PB-15 内联样式处理：
 *   - sanitizeAndStyle() 对每个 tag 采用“主题默认值 + 作者内联样式优先”的合并策略。
 *   - 遍历过程：先按主题设置 style attr → 保留已存在的 style attr（作者样式）→ 再 merge 主题缺失属性。
 *   - 实现上不做深 merge（DOMParser 无法解析 CSS），而是直接保留作者 style attr 优先（简单安全）。
 */

export interface Theme {
  id: string
  name: string
  desc: string
  swatch: string[]
  root: string
  tags: Record<string, string>
  sectionHeading: string
}

const base = 'font-size:16px;color:#333;line-height:1.8;letter-spacing:0.5px;'

export const themes: Theme[] = [
  {
    id: 'simple',
    name: '简洁',
    desc: '黑白灰，适合大多数文章',
    swatch: ['#333333', '#f5f5f5', '#999999'],
    root: base + 'padding:0 4px;',
    sectionHeading: 'font-size:19px;font-weight:bold;color:#222;margin:36px 0 16px;padding-left:10px;border-left:4px solid #333;line-height:1.5;',
    tags: {
      h3: 'font-size:17px;font-weight:bold;color:#222;margin:24px 0 12px;',
      p: 'margin:0 0 18px;',
      blockquote: 'margin:0 0 18px;padding:10px 14px;background-color:#f5f5f5;border-left:3px solid #ccc;color:#666;font-size:15px;',
      ul: 'margin:0 0 18px;padding-left:22px;',
      ol: 'margin:0 0 18px;padding-left:22px;',
      li: 'margin:0 0 6px;',
      strong: 'font-weight:bold;color:#111;',
      em: 'font-style:italic;',
      a: 'color:#576b95;text-decoration:none;',
      img: 'display:block;max-width:100%;margin:20px auto;border-radius:4px;',
      hr: 'border:none;border-top:1px solid #e5e5e5;margin:28px 0;',
    },
  },
  {
    id: 'ink',
    name: '黛青',
    desc: '沉稳的青色强调，适合观点和行业分析',
    swatch: ['#2F5D62', '#eef4f4', '#5e8b8f'],
    root: base + 'color:#3a3f44;padding:0 4px;',
    sectionHeading: 'font-size:19px;font-weight:bold;color:#2F5D62;margin:40px 0 18px;padding-bottom:8px;border-bottom:2px solid #2F5D62;line-height:1.5;',
    tags: {
      h3: 'font-size:17px;font-weight:bold;color:#2F5D62;margin:24px 0 12px;',
      p: 'margin:0 0 18px;',
      blockquote: 'margin:0 0 18px;padding:12px 16px;background-color:#eef4f4;border-left:3px solid #2F5D62;color:#4a5a5c;font-size:15px;',
      ul: 'margin:0 0 18px;padding-left:22px;',
      ol: 'margin:0 0 18px;padding-left:22px;',
      li: 'margin:0 0 6px;',
      strong: 'font-weight:bold;color:#2F5D62;',
      em: 'font-style:italic;',
      a: 'color:#2F5D62;text-decoration:underline;',
      img: 'display:block;max-width:100%;margin:20px auto;border-radius:6px;',
      hr: 'border:none;border-top:1px dashed #b8cfd1;margin:28px 0;',
    },
  },
  {
    id: 'tenghuang',
    name: '藤黄',
    desc: '暖色点缀，适合生活方式和经验分享',
    swatch: ['#B7791F', '#fdf6e3', '#E0A526'],
    root: base + 'color:#3d3a35;padding:0 4px;',
    sectionHeading: 'font-size:19px;font-weight:bold;color:#3d3a35;margin:40px 0 18px;text-align:center;line-height:1.5;padding:4px 0;border-bottom:3px solid #E0A526;',
    tags: {
      h3: 'font-size:17px;font-weight:bold;color:#B7791F;margin:24px 0 12px;',
      p: 'margin:0 0 18px;',
      blockquote: 'margin:0 0 18px;padding:12px 16px;background-color:#fdf6e3;border-radius:6px;color:#6b5a3a;font-size:15px;',
      ul: 'margin:0 0 18px;padding-left:22px;',
      ol: 'margin:0 0 18px;padding-left:22px;',
      li: 'margin:0 0 6px;',
      strong: 'font-weight:bold;color:#B7791F;',
      em: 'font-style:italic;',
      a: 'color:#B7791F;text-decoration:underline;',
      img: 'display:block;max-width:100%;margin:20px auto;border-radius:8px;',
      hr: 'border:none;border-top:1px solid #f0dfb5;margin:28px 0;',
    },
  },
  {
    id: 'mobai',
    name: '墨白',
    desc: '大留白、居中标题，适合随笔和故事',
    swatch: ['#1a1a1a', '#ffffff', '#8c8c8c'],
    root: 'font-size:16px;color:#2b2b2b;line-height:2;letter-spacing:1px;padding:0 8px;',
    sectionHeading: 'font-size:18px;font-weight:bold;color:#1a1a1a;margin:48px 0 22px;text-align:center;letter-spacing:2px;line-height:1.5;',
    tags: {
      h3: 'font-size:16px;font-weight:bold;color:#1a1a1a;margin:28px 0 14px;text-align:center;',
      p: 'margin:0 0 22px;',
      blockquote: 'margin:0 0 22px;padding:4px 18px;border-left:1px solid #1a1a1a;color:#666;font-size:15px;',
      ul: 'margin:0 0 22px;padding-left:22px;',
      ol: 'margin:0 0 22px;padding-left:22px;',
      li: 'margin:0 0 8px;',
      strong: 'font-weight:bold;color:#000;',
      em: 'font-style:italic;color:#555;',
      a: 'color:#1a1a1a;text-decoration:underline;',
      img: 'display:block;max-width:100%;margin:28px auto;',
      hr: 'border:none;text-align:center;margin:36px auto;width:40px;border-top:1px solid #1a1a1a;',
    },
  },
]

export const defaultThemeId = 'ink'
export const CUSTOM_THEME_ID = 'custom'

/** customTheme builds the account's own theme (EX-G-01) from a preset plus a few basic, SP-02-safe inline styles. */
export function customTheme(ct: CustomTheme): Theme {
  const b = themes.find((t) => t.id === ct.base) ?? themes[1]
  const c = ct.primary_color
  const gap = `${ct.paragraph_gap}px`
  const heading = {
    plain: `font-size:${ct.font_size + 3}px;font-weight:bold;color:${c};margin:36px 0 16px;line-height:1.5;`,
    underline: `font-size:${ct.font_size + 3}px;font-weight:bold;color:${c};margin:40px 0 18px;padding-bottom:8px;border-bottom:2px solid ${c};line-height:1.5;`,
    bar: `font-size:${ct.font_size + 3}px;font-weight:bold;color:#222;margin:36px 0 16px;padding-left:10px;border-left:4px solid ${c};line-height:1.5;`,
    block: `font-size:${ct.font_size + 2}px;font-weight:bold;color:#fff;background-color:${c};margin:36px 0 16px;padding:6px 12px;border-radius:4px;line-height:1.5;`,
  }[ct.heading_style]
  const quote = {
    bar: `margin:0 0 ${gap};padding:10px 14px;border-left:3px solid ${c};color:#666;font-size:${ct.font_size - 1}px;`,
    box: `margin:0 0 ${gap};padding:12px 16px;border:1px solid ${c};border-radius:6px;color:#555;font-size:${ct.font_size - 1}px;`,
    italic: `margin:0 0 ${gap};padding:4px 16px;font-style:italic;color:#777;font-size:${ct.font_size - 1}px;`,
  }[ct.quote_style]
  return {
    ...b,
    id: CUSTOM_THEME_ID,
    name: '我的主题',
    desc: `基于「${b.name}」`,
    swatch: [c, '#ffffff', '#999999'],
    root: `font-size:${ct.font_size}px;color:#333;line-height:${ct.line_height};letter-spacing:0.5px;padding:0 4px;`,
    sectionHeading: heading,
    tags: {
      ...b.tags,
      h3: `font-size:${ct.font_size + 1}px;font-weight:bold;color:${c};margin:24px 0 12px;`,
      p: `margin:0 0 ${gap};`,
      blockquote: quote,
      ul: `margin:0 0 ${gap};padding-left:22px;`,
      ol: `margin:0 0 ${gap};padding-left:22px;`,
      strong: `font-weight:bold;color:${c};`,
      a: `color:${c};text-decoration:underline;`,
    },
  }
}

export const themeById = (id: string | null | undefined): Theme =>
  (id === CUSTOM_THEME_ID && getCustomTheme() ? customTheme(getCustomTheme()!) : themes.find((t) => t.id === id)) ?? themes.find((t) => t.id === defaultThemeId)!

/**
 * ED-06/ED-08 降级策略：不静默丢弃未知块，只剔除危险标签（script/style）并保留内容
 * PB-15 内联样式合并：主题默认 + 作者内联，按属性覆盖（见 mergeStyle）
 */
function sanitizeAndStyle(root: Element, theme: Theme) {
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()

      // ED-06/ED-08: 脚本/样式为严格危险标签——移除节点但保留文本子节点
      if (tag === 'script' || tag === 'style') {
        el.removeChild(child)
        continue
      }

      // ED-06: 未知白名单标签：保留 DOM 结构但移除非法属性
      if (!allowedTags.has(tag)) {
        // 将未知标签降级为 div（通用容器）。这里必须搬移子节点而不是取 textContent，
        // 否则里面的 <strong>/<a>/<img> 会被拍平成纯文本（ED-06 的原始症状）。
        const div = child.ownerDocument.createElement('div')
        while (child.firstChild) div.appendChild(child.firstChild)
        for (const attr of Array.from(child.attributes)) {
          if (allowedAttrs.has(attr.name)) div.setAttribute(attr.name, attr.value)
        }
        child.replaceWith(div)
        walk(div)
        continue
      }

      // 属性过滤：只保留前后端都放行的属性
      for (const attr of Array.from(child.attributes)) {
        if (!allowedAttrs.has(attr.name)) child.removeAttribute(attr.name)
      }

      // ED-08: 链接只允许 https/http（相对 URL 由 UGC 策略允许，前端额外校验）
      if (tag === 'a' && !/^https?:\/\//.test(child.getAttribute('href') ?? '')) child.removeAttribute('href')

      // PB-15: 主题默认 + 作者内联按属性合并；作者值优先，缺的属性仍由主题补齐
      const themed = tag === 'b' ? theme.tags.strong
        : tag === 'i' ? theme.tags.em
          : theme.tags[tag as keyof typeof theme.tags] ?? fallbackStyles[tag] ?? ''
      if (themed) child.setAttribute('style', mergeStyle(themed, child.getAttribute('style')))

      walk(child)
    }
  }
  walk(root)
}

/**
 * ED-12 小标题约定：
 *   - 文档大纲层级：section.heading 作为"段落小标题"固定映射为 <h2>（页面占位符提示"段落小标题"）
 *   - 正文内的 Markdown heading：h1/h2 统一降级为 <h3>，h4+ 转为<strong>包裹段落以保结构但非独立标题
 *   - 该约定在 renderWechat（这里）与 section-editor（工具栏仅显示 H3）两侧保持一致。
 *
 * ED-10 往返保真：
 *   - 正文中的 ---/```/inline code 由 tipTap markdown 序列化，本函数不再改写。
 *   - 本函数仅负责渲染层样式与安全（sanitize + apply theme）。
 */
export function renderWechat(sections: Pick<Section, 'heading' | 'content_md'>[], themeOrId: string | Theme, assets: Pick<Asset, 'id' | 'alt_text'>[] = []): string {
  const theme = typeof themeOrId === 'string' ? themeById(themeOrId) : themeOrId
  const parts = sections.map((s) => {
    // ED-12: section.heading 始终为 h2（段落标题），正文内 heading 由 marked 生成后统一调整
    const heading = s.heading.trim() ? `<h2>${escapeHTML(s.heading.trim())}</h2>` : ''
    // ED-11: 编辑器序列化残留的 [markdownHTMLNode] 占位符不能出现在成稿里
    const body = marked.parse(stripMarkdownPlaceholders(s.content_md), { async: false, gfm: true, breaks: false }) as string
    // ED-10/ED-12: 正文字段内 heading 标准化：h1/h2 -> h3，h4+ -> 强文本包裹
    return heading + normalizeBodyHeadings(body)
  })
  const doc = new DOMParser().parseFromString(`<section>${parts.join('')}</section>`, 'text/html')
  const root = doc.body.firstElementChild!
  sanitizeAndStyle(root, theme)

  // 图片 alt 填充（资产关联）
  const altByAssetId = new Map(assets.map((asset) => [asset.id, asset.alt_text.trim()]))
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const assetId = /\/api\/v1\/assets\/([0-9a-f-]{36})\/file(?:[?#]|$)/i.exec(img.getAttribute('src') ?? '')?.[1]
    const altText = assetId && altByAssetId.get(assetId)
    if (altText) img.setAttribute('alt', altText)
  }

  // ED-12: 段落小标题固定样式（h2）
  for (const h2 of Array.from(root.querySelectorAll('h2'))) h2.setAttribute('style', theme.sectionHeading)
  root.setAttribute('style', theme.root)
  return root.outerHTML
}

export function htmlStats(html: string) {
  return { chars: Array.from(html).length, bytes: new TextEncoder().encode(html).length }
}

export const HTML_CHAR_LIMIT = 20000
export const HTML_BYTE_LIMIT = 1024 * 1024

function escapeHTML(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
