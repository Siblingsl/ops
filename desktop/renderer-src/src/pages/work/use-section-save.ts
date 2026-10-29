import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage, patch } from '@/lib/api'
import { clearDraft, enqueueSync, readDraft, writeDraft } from '@/lib/local-draft'
import { DESKTOP_LEAVE_GUARD_REQUEST } from '@/lib/desktop-settings'
import type { Section, Work } from '@/lib/types'
import { createSectionSaveQueue, type SectionSnapshot } from './section-save-queue'

interface SaveOptions {
  section: Section
  index: number
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  onSave: (d: number, offline?: boolean) => void
  onLoaded: (text: string) => void
}

export function useSectionSave(options: SaveOptions) {
  const { section } = options
  const latest = useRef(options)
  latest.current = options
  const content = useRef(section.content_md)
  const revision = useRef(section.revision)
  const [heading, setHeadingState] = useState(section.heading)
  const headingRef = useRef(heading)
  const [origin, setOrigin] = useState(section.origin)
  const [resetKey, setResetKey] = useState(0)
  const dirty = useRef(false)
  const applied = useRef<SectionSnapshot['applied'] | null>(null)
  const [conflict, setConflictState] = useState<Section | null>(null)
  const conflictRef = useRef<Section | null>(null)
  const offline = useRef(false)
  const timer = useRef<number>()
  const setConflict = (value: Section | null) => { conflictRef.current = value; setConflictState(value) }
  const setHeading = (value: string) => { headingRef.current = value; setHeadingState(value); dirty.current = true }
  const send = useRef<(snapshot: SectionSnapshot) => Promise<boolean>>(async () => false)
  const queue = useRef<ReturnType<typeof createSectionSaveQueue>>()
  if (!queue.current) queue.current = createSectionSaveQueue(snapshot => send.current(snapshot))

  const persist = useCallback((body: Partial<SectionSnapshot> = {}) => {
    dirty.current = true
    if (conflictRef.current) return Promise.resolve(false)
    const snapshot: SectionSnapshot = {
      heading: body.heading ?? headingRef.current,
      content_md: body.content_md ?? content.current,
      ...(body.applied || applied.current ? { applied: body.applied ?? applied.current! } : {}),
    }
    applied.current = null
    return queue.current!.enqueue(snapshot)
  }, [])

  send.current = async snapshot => {
    if (conflictRef.current) return false
    latest.current.onSave(1)
    let disconnected = false
    try {
      const result = await patch<{ section: Section; work_revision: number; work_status: Work['status'] }>(`/sections/${section.id}`, { ...snapshot, base_revision: revision.current })
      revision.current = result.section.revision
      setOrigin(result.section.origin)
      dirty.current = content.current !== snapshot.content_md || headingRef.current !== snapshot.heading
      offline.current = false
      if (!dirty.current) void clearDraft(section.id)
      latest.current.patchWork(work => ({ status: result.work_status, revision: result.work_revision, sections: work.sections.map(value => value.id === result.section.id ? result.section : value) }))
      return true
    } catch (e) {
      dirty.current = true
      if (snapshot.applied) applied.current = snapshot.applied
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict((e.detail as { server: Section }).server)
      } else if (e instanceof ApiError && e.code === 'network') {
        void writeDraft(section.id, { content: content.current, heading: headingRef.current, revision: revision.current, at: Date.now() })
        disconnected = offline.current = true
        window.setTimeout(() => { if (offline.current) void enqueueSync(() => persist().then(() => undefined)) }, 5000)
      } else toast.error(errorMessage(e))
      return false
    } finally { latest.current.onSave(-1, disconnected) }
  }

  const schedule = () => {
    dirty.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void persist() }, 1200)
  }
  const flush = async () => {
    do {
      window.clearTimeout(timer.current)
      if (dirty.current && !(await persist())) return false
      if (!(await queue.current!.flush())) return false
    } while (dirty.current)
    return true
  }
  useEffect(() => {
    const request = (event: Event) => {
      if ((event as CustomEvent<{ draftOnly?: boolean }>).detail?.draftOnly) return
      const register = (event as CustomEvent<{ register?: (check: () => Promise<boolean> | boolean) => void }>).detail?.register
      register?.(async () => {
        const saved = await flush()
        if (!saved) toast.info('作品草稿尚未保存成功，请处理保存冲突或网络问题后再离开。')
        return saved
      })
    }
    window.addEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
    return () => window.removeEventListener(DESKTOP_LEAVE_GUARD_REQUEST, request)
  }, [])
  const load = (value: Section) => {
    revision.current = value.revision
    content.current = value.content_md
    headingRef.current = value.heading
    setHeadingState(value.heading)
    setOrigin(value.origin)
    latest.current.onLoaded(value.content_md)
    setResetKey(k => k + 1)
  }
  const resolveConflict = async (keepMine: boolean) => {
    if (!conflictRef.current) return
    const server = conflictRef.current
    revision.current = server.revision
    setConflict(null)
    if (keepMine) await persist()
    else {
      load(server)
      dirty.current = false
      applied.current = null
      void clearDraft(section.id)
    }
  }

  useEffect(() => {
    let alive = true
    void readDraft(section.id).then(value => {
      if (!alive || !value) return
      if (value.content === section.content_md && (value.heading === undefined || value.heading === section.heading)) {
        void clearDraft(section.id)
        return
      }
      content.current = value.content
      if (value.heading !== undefined) setHeading(value.heading)
      setResetKey(k => k + 1)
      dirty.current = true
      latest.current.onLoaded(value.content)
      if (value.revision === section.revision) {
        schedule()
        toast.info(`第 ${latest.current.index + 1} 段恢复了未同步的修改`)
      } else setConflict(section)
    })
    const online = () => { if (offline.current) void enqueueSync(() => persist().then(() => undefined)) }
    window.addEventListener('online', online)
    return () => { alive = false; window.clearTimeout(timer.current); window.removeEventListener('online', online) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (section.revision === revision.current || dirty.current || queue.current!.busy) return
    load(section)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.revision, section.content_md, section.heading, section.origin])

  // 离开页面时把还没落库的输入强制保存：切路由（卸载）、关窗口（pagehide）、切标签页（visibilitychange）。
  // 防抖是 1.2 秒，没有这层保护时，打完最后一句立刻切走就会丢。
  useEffect(() => {
    const flushNow = () => { if (dirty.current) void persist() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow() }
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVisibility)
      flushNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { content, revision, heading, headingRef, setHeading, origin, setOrigin, resetKey, setResetKey, dirty, applied, conflict, setConflict, persist, schedule, flush, resolveConflict, load }
}
