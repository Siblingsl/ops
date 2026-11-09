import { type MutableRefObject, type RefObject, useRef, useState } from 'react'
import { toast } from 'sonner'
import { sendFeedback } from '@/components/refs'
import type { EditorHandle } from '@/components/section-editor'
import type { SectionSnapshot } from './section-save-queue'

interface UndoOptions {
  index: number
  editor: RefObject<EditorHandle>
  content: MutableRefObject<string>
  applied: MutableRefObject<SectionSnapshot['applied'] | null>
  setLintText: (text: string) => void
  disabled: boolean
}

export function useSectionUndo(options: UndoOptions) {
  const latest = useRef(options)
  latest.current = options
  const snapshot = useRef<{ before: string; after: string; aiCall?: string | null } | null>(null)
  const [available, setAvailable] = useState(false)
  const clearUndo = () => { snapshot.current = null; setAvailable(false) }
  const restore = (expected = snapshot.current) => {
    const current = latest.current
    if (!expected || expected !== snapshot.current || current.disabled || !current.editor.current) return
    if (current.content.current !== expected.after) {
      clearUndo()
      toast.info('当前内容已变化，请从段落历史恢复')
      return
    }
    current.applied.current = null
    current.editor.current.setMarkdown(expected.before)
    current.setLintText(expected.before)
    clearUndo()
    sendFeedback(expected.aiCall, { outcome: 'rejected' })
  }
  const undoToast = (label: string, before: string, aiCall?: string | null) => {
    const value = { before, after: latest.current.content.current, aiCall }
    snapshot.current = value
    setAvailable(true)
    toast(`${label} · 第 ${latest.current.index + 1} 段`, {
      duration: 10_000,
      action: { label: '撤销', onClick: () => restore(value) },
    })
  }
  return { available, clearUndo, restoreBefore: () => restore(), undoToast }
}
