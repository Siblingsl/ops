import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { BubbleMenu, EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Heading3, ImagePlus, Link2, List, ListOrdered, Quote } from 'lucide-react'
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { Markdown } from 'tiptap-markdown'
import { cn } from './ui'

export interface EditorHandle {
  selectedText: () => string
  replaceSelection: (text: string) => void
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
export const RichEditor = React.memo(forwardRef<EditorHandle, Props>(function RichEditor({ value, resetKey, onChange, editable, placeholder, onSelection, bubble, onPickImage }, ref) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSelRef = useRef(onSelection)
  onSelRef.current = onSelection
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [3] }, codeBlock: false, code: false, horizontalRule: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: false }),
    ],
    content: value,
    editable,
    editorProps: { attributes: { class: 'prose-editor min-h-[3.5em]' } },
    onUpdate: ({ editor }) => {
      if (editor.isEditable) onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection
      onSelRef.current?.(from === to ? '' : editor.state.doc.textBetween(from, to, '\n'))
    },
  })
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(value, false)
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
    replaceSelection: (text) => {
      if (!editor) return
      const { from, to } = editor.state.selection
      if (from === to) editor.commands.setContent(text)
      else editor.chain().focus().insertContentAt({ from, to }, text).run()
      onChangeRef.current((editor.storage as any).markdown.getMarkdown())
    },
    setMarkdown: (md) => {
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
    const url = window.prompt('链接地址（公众号正文中只有已关联的公众号文章链接可以点击）', prev ?? 'https://')
    if (url === null) return
    if (url === '') editor.chain().focus().unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }
  return (
    <div>
      <div className={cn('mb-2 flex items-center gap-0.5 opacity-60 transition group-focus-within/sec:opacity-100', !editable && 'hidden')}>
          <ToolBtn label="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="size-3.5" /></ToolBtn>
          <ToolBtn label="小标题" active={editor.isActive('heading')} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 className="size-3.5" /></ToolBtn>
          <ToolBtn label="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="size-3.5" /></ToolBtn>
          <ToolBtn label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="size-3.5" /></ToolBtn>
          <ToolBtn label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="size-3.5" /></ToolBtn>
          <ToolBtn label="链接" active={editor.isActive('link')} onClick={setLink}><Link2 className="size-3.5" /></ToolBtn>
          {onPickImage && <ToolBtn label="插入图片" onClick={onPickImage}><ImagePlus className="size-3.5" /></ToolBtn>}
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
    replaceSelection: (text) => {
      const el = ta.current
      if (!el) return
      const [a, b] = sel.current
      el.value = a === b ? text : el.value.slice(0, a) + text + el.value.slice(b)
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
