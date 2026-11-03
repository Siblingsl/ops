import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { BubbleMenu, EditorContent, useEditor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Quote, Redo2, Undo2 } from 'lucide-react'
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { Markdown } from 'tiptap-markdown'
import { apiBase, assetUrl } from '@/lib/api-base'
import { cn } from './ui'

// D-153：正文里存的图片地址是相对路径 /api/v1/assets/...（后端推送公众号时按这个格式解析，
// 存储值不能改）。前端部署在 Cloudflare、后端在云服务器时，相对路径会指向前端域名而 404，
// 所以只在渲染时补上 API 基址，解析回文档时再剥掉——文档模型里始终是相对路径，
// getMarkdown() 输出不变，后端推送链路不受影响。
function relativeAssetUrl(value: string | null): string | null {
  if (!value) return value
  const base = apiBase()
  return base && value.startsWith(`${base}/`) ? value.slice(base.length) : value
}

const AssetImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => relativeAssetUrl(el.getAttribute('src')),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.src ? { src: assetUrl(String(attrs.src)) } : {}),
      },
    }
  },
})

export interface EditorHandle {
  selectedText: () => string
  replaceSelection: (text: string) => void
  /** Character offsets of the current selection inside the document text. */
  selectionRange: () => { from: number; to: number } | null
  setMarkdown: (md: string) => void
  insertImage: (url: string) => void
  focus: () => void
  /** Plain text before and after the cursor (selection collapses to its ends). */
  textAround: () => { before: string; after: string }
  insertAtCursor: (text: string) => void
  /** DOM node holding the rendered text; null for the plain textarea editor. */
  root: () => HTMLElement | null
}

interface Props {
  value: string
  resetKey: number
  onChange: (md: string) => void
  editable: boolean
  placeholder?: string
  onSelection?: (text: string) => void
  bubble?: React.ReactNode
  onPickImage?: () => void
  /** FR-CX-11：粘贴/拖拽图片入库，返回图片地址；null 表示失败（调用方已提示）。 */
  onPasteImage?: (file: File) => Promise<string | null>
  /** FR-CX-11：粘贴相关的可见提示（多图、图文混排、内容已变化未自动插入等）。 */
  onPasteNotice?: (message: string) => void
}

function ToolBtn({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cn('flex size-7 cursor-pointer items-center justify-center rounded-md text-mist-500 transition hover:bg-mist-100 hover:text-mist-800',
        active && 'bg-ink-50 text-ink-700')}>
      {children}
    </button>
  )
}

/** RichEditor edits one section as WYSIWYG while storing Markdown (D-022). */
export const RichEditor = React.memo(forwardRef<EditorHandle, Props>(function RichEditor({ value, resetKey, onChange, editable, placeholder, onSelection, bubble, onPickImage, onPasteImage, onPasteNotice }, ref) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSelRef = useRef(onSelection)
  onSelRef.current = onSelection
  const pasteImageRef = useRef(onPasteImage)
  pasteImageRef.current = onPasteImage
  const pasteNoticeRef = useRef(onPasteNotice)
  pasteNoticeRef.current = onPasteNotice
  // 文档版本：粘贴锚点只在版本未变时有效，避免上传完成后把图片插到错误位置。
  const tokenRef = useRef(0)

  // FR-CX-11：先记锚点再上传；文档在等待期间被修改（撤销、删段、重排）则放弃自动插入。
  const insertPasted = async (view: EditorView, file: File, pos: number, token: number) => {
    const url = await pasteImageRef.current?.(file)
    if (!url) return
    if (view.isDestroyed) return
    if (tokenRef.current !== token) {
      pasteNoticeRef.current?.('内容已变化，图片已入库但没有自动插入；可用工具栏「插入图片」放到想要的位置。')
      return
    }
    const node = view.state.schema.nodes.image?.create({ src: url })
    if (!node) return
    view.dispatch(view.state.tr.insert(Math.min(pos, view.state.doc.content.size), node))
  }

  const handlePasteFiles = (view: EditorView, event: ClipboardEvent) => {
    const data = event.clipboardData
    if (!data) return false
    const files = Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return false
    if (!view.editable || !pasteImageRef.current) return false
    event.preventDefault()
    const text = (data.getData('text/plain') || '').trim()
    if (text) {
      // 图文混排不静默丢文本：只粘文字，并明确告知图片没有插入。
      pasteNoticeRef.current?.('剪贴板里同时有文字和图片，本次只粘贴了文字；图片请单独粘贴。')
      if (typeof view.pasteText === 'function') view.pasteText(text)
      else view.dispatch(view.state.tr.insertText(text, view.state.selection.from, view.state.selection.to))
      return true
    }
    if (files.length > 1) {
      pasteNoticeRef.current?.(`一次只能粘贴一张图片（本次 ${files.length} 张），请逐张粘贴。`)
      return true
    }
    void insertPasted(view, files[0], view.state.selection.from, tokenRef.current)
    return true
  }

  const handleDropFiles = (view: EditorView, event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return false
    // 无论是否可编辑都要阻止默认行为，否则浏览器会把图片当成导航目标打开。
    event.preventDefault()
    if (!view.editable || !pasteImageRef.current) return true
    if (files.length > 1) {
      pasteNoticeRef.current?.(`一次只能拖入一张图片（本次 ${files.length} 张），请逐张拖入。`)
      return true
    }
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
    void insertPasted(view, files[0], at?.pos ?? view.state.selection.from, tokenRef.current)
    return true
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [3] }, codeBlock: false, code: false, horizontalRule: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      AssetImage,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: false }),
    ],
    content: value,
    editable,
    editorProps: {
      attributes: { class: 'prose-editor min-h-[3.5em]' },
      handlePaste: (view, event) => handlePasteFiles(view, event),
      handleDrop: (view, event) => handleDropFiles(view, event),
    },
    onUpdate: ({ editor }) => {
      tokenRef.current += 1
      if (editor.isEditable) onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection
      onSelRef.current?.(from === to ? '' : editor.state.doc.textBetween(from, to, '\n'))
    },
  })
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      tokenRef.current += 1
      editor.commands.setContent(value, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, editor])
  useEffect(() => {
    // setEditable 默认会触发 update 事件，导致没改内容也自动保存。
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editable, editor])
  useImperativeHandle(ref, () => ({
    selectedText: () => {
      if (!editor) return ''
      const { from, to } = editor.state.selection
      return from === to ? '' : editor.state.doc.textBetween(from, to, '\n')
    },
    selectionRange: () => {
      if (!editor) return null
      const { from, to } = editor.state.selection
      return from === to ? null : { from, to }
    },
    replaceSelection: (text) => {
      if (!editor) return
      const { from, to } = editor.state.selection
      // ED-09：没有选区时是「插入」，绝不能 setContent——那会把整段正文换成一句 AI 建议。
      if (from === to) editor.chain().focus().insertContentAt(from, text).run()
      else editor.chain().focus().insertContentAt({ from, to }, text).run()
      onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    setMarkdown: (md) => {
      tokenRef.current += 1
      editor?.commands.setContent(md)
      if (editor) onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    insertImage: (url) => editor?.chain().focus().setImage({ src: url }).run(),
    focus: () => editor?.commands.focus(),
    textAround: () => {
      if (!editor) return { before: '', after: '' }
      const { from, to } = editor.state.selection
      const doc = editor.state.doc
      return { before: doc.textBetween(0, from, '\n'), after: doc.textBetween(to, doc.content.size, '\n') }
    },
    insertAtCursor: (text) => {
      if (!editor) return
      editor.chain().focus().insertContent(text).run()
      onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    root: () => (editor && !editor.isDestroyed ? (editor.view.dom as HTMLElement) : null),
  }), [editor])
  if (!editor) return null
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('链接地址（正文中只有已关联且有权限访问的文章链接可以点击）', prev ?? 'https://')
    if (url === null) return
    if (url === '') editor.chain().focus().unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }
  return (
    <div>
      <div className={cn('rich-editor-toolbar mb-2 flex items-center gap-0.5 opacity-60 transition group-focus-within/sec:opacity-100', !editable && 'hidden')}>
          <ToolBtn label="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="size-3.5" /></ToolBtn>
          <ToolBtn label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="size-3.5" /></ToolBtn>
          <span className="rich-toolbar-divider" />
          <ToolBtn label="小标题" active={editor.isActive('heading')} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 className="size-3.5" /></ToolBtn>
          <ToolBtn label="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="size-3.5" /></ToolBtn>
          <ToolBtn label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="size-3.5" /></ToolBtn>
          <ToolBtn label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="size-3.5" /></ToolBtn>
          <ToolBtn label="链接" active={editor.isActive('link')} onClick={setLink}><Link2 className="size-3.5" /></ToolBtn>
          {onPickImage && <ToolBtn label="插入图片" onClick={onPickImage}><ImagePlus className="size-3.5" /></ToolBtn>}
          <span className="rich-toolbar-divider" />
          <ToolBtn label="撤销" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="size-3.5" /></ToolBtn>
          <ToolBtn label="重做" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="size-3.5" /></ToolBtn>
      </div>
      <EditorContent editor={editor} />
      {/* BubbleMenu 的节点会被 tippy 移走，必须包在稳定的容器里，否则 React 增删兄弟节点时会报错。 */}
      <div>
        {bubble && (
          <BubbleMenu editor={editor} tippyOptions={{ duration: 120, placement: 'top' }}
            shouldShow={({ editor: e, from, to }) => e.isEditable && from !== to && !e.isActive('image')}>
            <div>{bubble}</div>
          </BubbleMenu>
        )}
      </div>
    </div>
  )
}))

/** PlainEditor is used for Xiaohongshu: plain text only (06 文档第 5.4 节). */
export const PlainEditor = forwardRef<EditorHandle, Props>(function PlainEditor({ value, resetKey, onChange, editable, placeholder, onSelection }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const sel = useRef<[number, number]>([0, 0])
  useEffect(() => {
    if (ta.current && ta.current.value !== value) ta.current.value = value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  const grow = () => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }
  useLayoutEffect(grow, [resetKey, value])
  const track = () => {
    const el = ta.current
    if (!el) return
    sel.current = [el.selectionStart, el.selectionEnd]
    onSelection?.(el.value.slice(el.selectionStart, el.selectionEnd))
  }
  useImperativeHandle(ref, () => ({
    selectedText: () => (ta.current ? ta.current.value.slice(sel.current[0], sel.current[1]) : ''),
    selectionRange: () => {
      const el = ta.current
      if (!el || el.selectionStart === el.selectionEnd) return null
      return { from: el.selectionStart, to: el.selectionEnd }
    },
    replaceSelection: (text) => {
      const el = ta.current
      if (!el) return
      const [a, b] = sel.current
      // ED-09：没有选区时是「插入」，不能把整段正文替换成一句 AI 建议。
      el.value = el.value.slice(0, a) + text + el.value.slice(b)
      onChange(el.value)
      grow()
    },
    setMarkdown: (md) => {
      if (ta.current) ta.current.value = md
      onChange(md)
      grow()
    },
    insertImage: () => undefined,
    focus: () => ta.current?.focus(),
    textAround: () => {
      const el = ta.current
      if (!el) return { before: '', after: '' }
      return { before: el.value.slice(0, el.selectionStart), after: el.value.slice(el.selectionEnd) }
    },
    insertAtCursor: (text) => {
      const el = ta.current
      if (!el) return
      const a = el.selectionStart
      el.value = el.value.slice(0, a) + text + el.value.slice(el.selectionEnd)
      el.selectionStart = el.selectionEnd = a + text.length
      sel.current = [a + text.length, a + text.length]
      onChange(el.value)
      grow()
    },
    root: () => null,
  }))
  return (
    <textarea
      ref={ta}
      defaultValue={value}
      readOnly={!editable}
      aria-label="段落正文"
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onSelect={track}
      onKeyUp={track}
      onMouseUp={track}
      onPaste={(e) => {
        // 小红书正文是纯文本：粘贴时只保留文字。
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        document.execCommand('insertText', false, text)
      }}
      rows={3}
      className="w-full resize-none overflow-hidden bg-transparent text-[15px] leading-[1.85] text-mist-800 outline-none placeholder:text-mist-400"
    />
  )
})
