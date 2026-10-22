import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, patch } from '@/lib/api'
import type { Work } from '@/lib/types'

// NW-C1/C5/F2：观点输入的唯一实现。文章编辑器与漫画编辑器都用它，
// 避免第三份"保存返回回写正在输入的字"的实现。
export function useViewpointField(work: Work, setWork: (w: Work) => void) {
  const [text, setText] = useState(work.viewpoint)
  const textRef = useRef(work.viewpoint)
  const serverText = useRef(work.viewpoint)
  const dirty = useRef(false)
  const timer = useRef<number>()
  const flight = useRef<Promise<void> | null>(null)
  const [conflict, setConflict] = useState<{ server: Work; mine: string } | null>(null)

  useEffect(() => {
    const previous = serverText.current
    serverText.current = work.viewpoint
    if (dirty.current) return
    if (textRef.current === previous) {
      textRef.current = work.viewpoint
      setText(work.viewpoint)
    }
  }, [work.viewpoint])

  const persist = useCallback(async () => {
    const sent = textRef.current
    if (sent.trim() === serverText.current.trim()) { dirty.current = false; return }
    try {
      const next = await patch<Work>(`/works/${work.id}`, { viewpoint: sent, base_revision: work.revision })
      serverText.current = next.viewpoint
      setWork(next)
      if (textRef.current === sent) {
        dirty.current = false
        if (next.viewpoint !== textRef.current) { textRef.current = next.viewpoint; setText(next.viewpoint) }
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict({ server: (e.detail as { server: Work }).server, mine: sent })
        return
      }
      throw e
    }
  }, [setWork, work.id, work.revision])

  const save = useCallback(async () => {
    if (flight.current) await flight.current
    if (!dirty.current || textRef.current.trim() === serverText.current.trim()) { dirty.current = false; return }
    const p = persist().finally(() => { flight.current = null })
    flight.current = p
    await p
  }, [persist])

  const saveRef = useRef(save)
  saveRef.current = save
  const saveWithToast = useCallback(() => { void saveRef.current().catch((e) => { throw e }) }, [])
  useEffect(() => {
    if (!dirty.current) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void saveRef.current().catch(() => {}) }, 800)
    return () => window.clearTimeout(timer.current)
  }, [text])
  useEffect(() => () => { if (dirty.current) void saveRef.current().catch(() => {}) }, [])

  const flush = useCallback(async () => {
    for (let i = 0; i < 3; i++) {
      await saveRef.current()
      if (!dirty.current || textRef.current.trim() === serverText.current.trim()) return
    }
  }, [])

  const change = (value: string) => {
    setText(value)
    textRef.current = value
    dirty.current = true
  }

  const resolve = async (keepMine: boolean) => {
    const c = conflict
    setConflict(null)
    if (!c) return
    if (!keepMine) {
      serverText.current = c.server.viewpoint
      textRef.current = c.server.viewpoint
      setText(c.server.viewpoint)
      dirty.current = false
      setWork(c.server)
      return
    }
    try {
      const next = await patch<Work>(`/works/${work.id}`, { viewpoint: c.mine, base_revision: c.server.revision })
      serverText.current = next.viewpoint
      textRef.current = next.viewpoint
      setText(next.viewpoint)
      dirty.current = false
      setWork(next)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict({ server: (e.detail as { server: Work }).server, mine: c.mine })
      else throw e
    }
  }

  return { text, change, save: saveWithToast, flush, conflict, resolve, errorMessage }
}
