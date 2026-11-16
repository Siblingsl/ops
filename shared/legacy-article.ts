export interface LegacyArticleSection {
  heading: string
  content_md: string
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return Array.from(node.childNodes).map(inlineMarkdown).join('')
  const text = Array.from(node.childNodes).map(inlineMarkdown).join('')
  switch (node.tagName.toLowerCase()) {
    case 'br': return '\n'
    case 'strong':
    case 'b': return `**${text}**`
    case 'em':
    case 'i': return `*${text}*`
    case 'a': {
      const href = node.getAttribute('href')
      if (!href) return text
      try {
        const url = new URL(href, document.baseURI)
        return url.protocol === 'http:' || url.protocol === 'https:' ? `[${text}](${url.href})` : text
      } catch {
        return text
      }
    }
    case 'img': {
      const src = node.getAttribute('src')
      if (!src) return node.getAttribute('alt') ?? ''
      try {
        const url = new URL(src, document.baseURI)
        return url.protocol === 'http:' || url.protocol === 'https:' ? `![${node.getAttribute('alt') ?? ''}](${url.href})` : ''
      } catch {
        return ''
      }
    }
    default: return text
  }
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ?? ''
  if (!(node instanceof HTMLElement)) return Array.from(node.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n')
  const tag = node.tagName.toLowerCase()
  const inline = inlineMarkdown(node).trim()
  if (/^h[1-6]$/.test(tag)) return inline ? `## ${inline}` : ''
  if (tag === 'p') return inline
  if (tag === 'br') return '\n'
  if (tag === 'ul' || tag === 'ol') {
    return Array.from(node.children).map((item, index) => `${tag === 'ol' ? `${index + 1}.` : '-'} ${inlineMarkdown(item).trim()}`).join('\n')
  }
  if (tag === 'blockquote') return inline.split('\n').map(line => `> ${line}`).join('\n')
  const blocks = Array.from(node.childNodes).map(blockMarkdown).filter(Boolean)
  return blocks.length ? blocks.join('\n\n') : inline
}

export function clipboardHtmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.body.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n').trim()
}

export function parseLegacyArticle(source: string): LegacyArticleSection[] {
  const sections: LegacyArticleSection[] = []
  let heading = ''
  let lines: string[] = []
  const flush = () => {
    const content = lines.join('\n').trim()
    if (content) sections.push({ heading, content_md: content })
  }
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) {
      lines.push(line)
      continue
    }
    flush()
    heading = match[1].trim()
    lines = []
  }
  flush()
  return sections
}
