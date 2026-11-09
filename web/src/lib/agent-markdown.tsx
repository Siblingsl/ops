import { marked } from 'marked'
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isInternalPath } from './internal-link'

const allowedTags = new Set([
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h3', 'h4', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
])

function safeHref(value: string) {
  // 站内链接必须过白名单：仅 "/" 开头不够，反斜杠与编码绕过都会变成站外跳转
  // （docs/28 §2.2 / CVE-2026-53669）。
  if (isInternalPath(value)) return value
  try {
    return new URL(value).protocol === 'https:' ? value : ''
  } catch {
    return ''
  }
}

function cleanNode(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      if (child.nodeType !== Node.TEXT_NODE) child.remove()
      continue
    }
    const el = child as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (!allowedTags.has(tag)) {
      if (['script', 'style', 'iframe', 'object', 'svg', 'math', 'img'].includes(tag)) el.remove()
      else el.replaceWith(document.createTextNode(el.textContent ?? ''))
      continue
    }
    const href = tag === 'a' ? safeHref(el.getAttribute('href') ?? '') : ''
    for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name)
    if (tag === 'a') {
      if (href) el.setAttribute('href', href)
      if (href.startsWith('https://')) {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer nofollow')
      }
    }
    cleanNode(el)
  }
}

function renderedMarkdown(text: string) {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false }) as string
  const doc = new DOMParser().parseFromString(html, 'text/html')
  cleanNode(doc.body)
  return doc.body.innerHTML
}

export function AgentMarkdown({ text }: { text: string }) {
  const navigate = useNavigate()
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLAnchorElement>('a[href]')
    const href = link?.getAttribute('href')
    if (!href || !isInternalPath(href) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }, [navigate])
  return <div onClick={onClick} className="agent-markdown min-w-0 break-words" dangerouslySetInnerHTML={{ __html: renderedMarkdown(text) }} />
}

