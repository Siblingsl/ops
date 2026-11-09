import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { DESKTOP_LEAVE_GUARD_RELEASE, DESKTOP_LEAVE_GUARD_REQUEST, useSettingsDraft } from '@/lib/desktop-settings'

/** 技能正文只留在当前页面内存；沿用现有确认框和切账号/工作区的离开协议。 */
export function useSkillDraftGuard(dirty: boolean, busy: boolean) {
  useSettingsDraft(dirty, busy)
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
    const request = (event: Event) => {
      const detail = (event as CustomEvent<{ register: (check: () => Promise<boolean>) => void; grant: (fn: () => void) => void; reserveNavigation?: boolean }>).detail
      detail?.register(allow)
      if (detail?.reserveNavigation) detail.grant(() => { permit.current = true })
    }
    const release = () => { permit.current = false }
    const unload = (event: BeforeUnloadEvent) => {
      if (!permit.current && (state.current.dirty || state.current.busy)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
    window.addEventListener(DESKTOP_LEAVE_GUARD_RELEASE, release)
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
      window.removeEventListener(DESKTOP_LEAVE_GUARD_RELEASE, release)
      window.removeEventListener('beforeunload', unload)
    }
  }, [allow])
  return { allow, clear }
}
