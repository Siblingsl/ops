import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'

/** Skill editor guard for unsaved changes and in-flight work. */
export function useSkillDraftGuard(dirty: boolean, busy: boolean) {
  const state = useRef({ dirty, busy })
  state.current = { dirty, busy }
  const permit = useRef(false)
  const pending = useRef<Promise<boolean> | null>(null)
  const allow = useCallback(async () => {
    if (permit.current) return true
    if (state.current.busy) { toast.info('正在处理技能，请稍候再离开'); return false }
    if (!state.current.dirty) return true
    pending.current ??= confirm({ title: '放弃未保存的技能？', desc: '当前输入尚未保存，离开后将丢弃这些修改。', confirmText: '放弃修改', danger: true })
      .finally(() => { pending.current = null })
    return pending.current
  }, [])
  const clear = useCallback(() => { state.current = { dirty: false, busy: false }; permit.current = true }, [])

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!permit.current && (state.current.dirty || state.current.busy)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])
  return { allow, clear }
}
