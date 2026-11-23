import { ipcRenderer } from 'electron'

// BR-03（38 §10）：应用内浏览的元素选择覆盖层。
// 只在主进程收到用户点击“选择元素”后注入；点击后回传同一 schema：
// { title, url, selector, text, tag, rect }。
// 安全边界：密码/文件/隐藏字段、contenteditable 编辑区、iframe 一律拒绝；
// 不上传整页 HTML，只回传用户点中的单个元素与 ≤200 字文本。

const HOST_ID = '__ops_element_picker_host__'
let active = false
let host: HTMLElement | null = null
let box: HTMLElement | null = null
let tip: HTMLElement | null = null

function cleanup(): void {
  active = false
  document.removeEventListener('mousemove', onMove, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('keydown', onKey, true)
  host?.remove()
  host = null
  box = null
  tip = null
}

function selectorFor(element: Element): string {
  if (element.id) {
    const escaped = `#${CSS.escape(element.id)}`
    try {
      if (document.querySelectorAll(escaped).length === 1) return escaped
    } catch { /* 非法 id 回退到路径 */ }
  }
  const parts: string[] = []
  let node: Element | null = element
  while (node !== null && node !== document.documentElement) {
    const current: Element = node
    let part: string = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((candidate: Element) => candidate.tagName === current.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

function rejectReason(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (tag === 'iframe' || tag === 'frame') return 'iframe_not_selectable'
  const sensitive = element.closest(
    'input[type="password"], input[type="file"], input[type="hidden"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  )
  if (sensitive) return 'sensitive_control'
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return 'hidden_element'
  return null
}

function pickedPayload(element: Element): Record<string, unknown> {
  const valueControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
  const text = (valueControl ? String((element as HTMLInputElement).value ?? '') : (element.textContent || ''))
    .trim()
    .slice(0, 200)
  const rect = element.getBoundingClientRect()
  return {
    title: document.title,
    url: location.href,
    selector: selectorFor(element),
    text,
    tag: element.tagName.toLowerCase(),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  }
}

function finish(result: Record<string, unknown>): void {
  if (!active) return
  cleanup()
  ipcRenderer.send('inbrowse:picker:result', result)
}

function targetAt(clientX: number, clientY: number): Element | null {
  const element = document.elementFromPoint(clientX, clientY)
  if (!element || element === host || host?.contains(element)) return null
  return element
}

function onMove(event: MouseEvent): void {
  if (!active || !box || !tip) return
  const element = targetAt(event.clientX, event.clientY)
  if (!element) {
    box.style.display = 'none'
    tip.style.display = 'none'
    return
  }
  const rect = element.getBoundingClientRect()
  box.style.display = 'block'
  box.style.left = `${rect.left}px`
  box.style.top = `${rect.top}px`
  box.style.width = `${Math.max(0, rect.width)}px`
  box.style.height = `${Math.max(0, rect.height)}px`
  const reason = rejectReason(element)
  tip.style.display = 'block'
  tip.textContent = reason
    ? `${element.tagName.toLowerCase()} · 不可选（密码/可编辑/跨域区域）`
    : `${element.tagName.toLowerCase()} · ${selectorFor(element)}`
  tip.style.left = `${Math.min(window.innerWidth - 260, event.clientX + 14)}px`
  tip.style.top = `${Math.max(8, event.clientY + 18)}px`
}

function onClick(event: MouseEvent): void {
  if (!active) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  const element = targetAt(event.clientX, event.clientY)
  if (!element) return
  const reason = rejectReason(element)
  if (reason) {
    finish({ ok: false, reason })
    return
  }
  finish({ ok: true, data: pickedPayload(element) })
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !active) return
  event.preventDefault()
  event.stopPropagation()
  finish({ ok: false, reason: 'cancelled' })
}

function start(): void {
  if (active) return
  active = true
  host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
  box = document.createElement('div')
  box.style.cssText = 'position:fixed;border:2px solid #7c3aed;background:rgba(124,58,237,0.10);border-radius:4px;pointer-events:none;display:none;'
  tip = document.createElement('div')
  tip.style.cssText = 'position:fixed;max-width:250px;padding:4px 8px;border-radius:6px;background:#231f33;color:#fff;font:12px/18px system-ui,sans-serif;pointer-events:none;display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  host.append(box, tip)
  document.documentElement.appendChild(host)
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
}

ipcRenderer.on('inbrowse:picker:start', () => start())
ipcRenderer.on('inbrowse:picker:stop', () => finish({ ok: false, reason: 'cancelled' }))
