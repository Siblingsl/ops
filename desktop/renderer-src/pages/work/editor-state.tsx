import { Check, CloudOff, Loader2 } from 'lucide-react'
import { type ComponentProps, type MutableRefObject, useState, useSyncExternalStore } from 'react'
import { fmtTime } from '@/lib/format'
import { EditorSidebar } from './editor-sidebar'
import { useEditorEvents } from './editor-tools'

export function createSaveStatus() {
  let state = { pending: 0, offline: false, last: null as string | null }
  const listeners = new Set<() => void>()
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    report: (d: number, offline = false) => {
      state = { pending: Math.max(0, state.pending + d), offline, last: d < 0 && !offline ? new Date().toISOString() : state.last }
      listeners.forEach(listener => listener())
    },
  }
}

/**
 * compact 用于编辑器底部状态条：只输出一行状态，不带分隔线和外边距，
 * 让「保存状态」始终固定在可见位置，而不是随左栏一起被滚走。
 */
export function SaveStatus({ store, compact = false }: { store: ReturnType<typeof createSaveStatus>; compact?: boolean }) {
  const save = useSyncExternalStore(store.subscribe, store.snapshot)
  const body = save.offline ? <span className="flex items-center gap-1.5 text-danger"><CloudOff className="size-3.5" />离线，未保存（恢复后自动同步）</span>
    : save.pending > 0 ? <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />保存中…</span>
    : save.last ? <span className="flex items-center gap-1.5"><Check className="size-3.5 text-ink-500" />已保存 {fmtTime(save.last)}</span>
    : <span>自动保存已开启</span>
  return compact
    ? <span className="desktop-save-status" data-testid="desktop-save-status">{body}</span>
    : <div className="mt-6 border-t border-mist-200 pt-4 text-xs text-mist-500">{body}</div>
}

export function SelectedSidebar({ selectionRef, ...props }: Omit<ComponentProps<typeof EditorSidebar>, 'selection'> & { selectionRef: MutableRefObject<string> }) {
  const [selection, setSelection] = useState(selectionRef.current)
  useEditorEvents(e => { if (e.type === 'selection') setSelection(e.text) })
  return <EditorSidebar {...props} selection={selection} />
}
