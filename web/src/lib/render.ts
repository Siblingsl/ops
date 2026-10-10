import { marked } from 'marked'
import type { CustomTheme, Section } from './types'

/**
 * 公众号 HTML 渲染模块（FR-M6-01、D-015）。预览、检查统计和推送都使用这里的输出，保证所见即所得。
 * 主题只用基础样式（字号、颜色、行距、边框、背景色、边距），等 SP-02 实测后再校准（T-01）。
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

let activeCustom: CustomTheme | null = null
/** setCustomTheme registers the current account's custom theme so that themeById('custom') resolves to it. */
export function setCustomTheme(ct: CustomTheme | null) {
  activeCustom = ct
}

export const themeById = (id: string | null | undefined): Theme =>
  (id === CUSTOM_THEME_ID && activeCustom ? customTheme(activeCustom) : themes.find((t) => t.id === id)) ?? themes.find((t) => t.id === defaultThemeId)!

const allowedTags = new Set(['section', 'h2', 'h3', 'p', 'blockquote', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'a', 'img', 'br', 'hr', 'span', 'del', 's'])
const allowedAttrs = new Set(['href', 'src', 'alt', 'style'])

function sanitizeAndStyle(root: Element, theme: Theme) {
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (!allowedTags.has(tag)) {
        // 不支持的元素（如 h1、表格、代码块）降级为段落文字。
        const p = el.ownerDocument.createElement('p')
        p.textContent = child.textContent ?? ''
        child.replaceWith(p)
        p.setAttribute('style', theme.tags.p)
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        if (!allowedAttrs.has(attr.name)) child.removeAttribute(attr.name)
      }
      if (tag === 'a' && !/^https?:\/\//.test(child.getAttribute('href') ?? '')) child.removeAttribute('href')
      const style = tag === 'b' ? theme.tags.strong : tag === 'i' ? theme.tags.em : theme.tags[tag]
      if (style && !child.getAttribute('style')) child.setAttribute('style', style)
      walk(child)
    }
  }
  walk(root)
}

export function renderWechat(sections: Pick<Section, 'heading' | 'content_md'>[], themeOrId: string | Theme): string {
  const theme = typeof themeOrId === 'string' ? themeById(themeOrId) : themeOrId
  const parts = sections.map((s) => {
    const heading = s.heading.trim() ? `<h2>${escapeHTML(s.heading.trim())}</h2>` : ''
    const body = marked.parse(s.content_md, { async: false, gfm: true, breaks: false }) as string
    return heading + body.replace(/<h[1-2]>/g, '<h3>').replace(/<\/h[1-2]>/g, '</h3>').replace(/<h[4-6]>/g, '<p><strong>').replace(/<\/h[4-6]>/g, '</strong></p>')
  })
  const doc = new DOMParser().parseFromString(`<section>${parts.join('')}</section>`, 'text/html')
  const root = doc.body.firstElementChild!
  sanitizeAndStyle(root, theme)
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
