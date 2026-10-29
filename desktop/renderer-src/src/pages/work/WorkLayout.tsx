import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronUp, Copy, Download, GitBranch, History, Layers, Lock, Maximize2, Minimize2, RotateCcw, Save, Star, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DeriveDialog } from '@/components/derive'
import { confirm, Dialog, Drawer } from '@/components/dialog'
import { Badge, Button, cn, Field, Input, MoreMenu, Notice, PageLoading, platformFormatLabel, platformLabel, PlatformMark, Select, StatusBadge, Switch } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post } from '@/lib/api'
import { apiBase } from '@/lib/api-base'
import { fmtTime } from '@/lib/format'
import { currentWorkQueryKey, rememberAccount, useCanWrite, useMe } from '@/lib/session'
import { DESKTOP_LEAVE_GUARD_REQUEST } from '@/lib/desktop-settings'
import type { Platform, PlatformWorkMirror, StarItem, Work, WorkspaceMember, WorkStatus } from '@/lib/types'
import { rememberRecent, useCustomTheme, usePrefs, useWorkCmd } from '@/lib/v3'
import { usePageVisible } from '@/lib/visibility'
import { emitEditor } from './editor-tools'
import { flushWork } from './work-save'
import { contentReady, creationSteps } from './work-progress'

export interface WorkCtx {
  work: Work
  setWork: (w: Work) => void
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  refresh: () => Promise<unknown>
  focus: boolean
  setFocus: (v: boolean) => void
  presence: Presence[]
  reportSection: (id: string | null) => void
  reportEditing: (id: string) => void
}
export const useWork = () => useOutletContext<WorkCtx>()

// ED-04/ED-03：作品当前状态对应的下一步。三个编辑器与预览页共用同一套判断。
export function nextStepFor(status: Work['status'], wechat: boolean): { to: string; label: string } | null {
  switch (status) {
    case 'drafting': return { to: 'check', label: '去检查' }
    case 'checking': return { to: 'check', label: '继续检查' }
    case 'ready': return { to: wechat ? 'push' : 'pack', label: wechat ? '去写入草稿箱' : '生成发布包' }
    case 'pushed': return { to: 'push', label: '去回填' }
    case 'packed': return { to: 'pack', label: '去回填' }
    case 'reviewing': return { to: 'check', label: '去审阅' }
    default: return null
  }
}

function markdownForWork(work: Work, origin: string) {
  const blocks = [`# ${work.title.trim() || '未命名作品'}`]
  if (work.platform === 'toutiao') {
    blocks.push(`> ${platformLabel[work.platform]} · ${platformFormatLabel(work.platform, work.content_format)}${work.content_format === 'micro_post' ? '；系统存档，内部名称与段落标题不作为发布正文' : ''}`)
  }
  for (const section of work.sections) {
    if (section.heading.trim()) blocks.push(`## ${section.heading.trim()}`)
    const body = section.content_md.replace(/(!\[[^\]]*\]\()\/api\/v1\/assets\/([^\s)]+)(\))/g,
      (_match, imageStart: string, path: string, close: string) => `${imageStart}${origin}/api/v1/assets/${path}${close}`)
    if (body.trim()) blocks.push(body)
  }
  return `${blocks.join('\n\n')}\n`
}

function changedMiddle(before: string, after: string) {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--
    rightEnd--
  }
  return { source: left.slice(start, leftEnd).join('\n'), local: right.slice(start, rightEnd).join('\n') }
}

export function WorkHeaderAction({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => { setTarget(document.getElementById('work-header-action-target')) }, [])
  return target ? createPortal(children, target) : null
}

interface Presence { user_id: string; username: string; section_id: string | null; editing: boolean; at: string }

/** PlanPopover holds fields that never count as content edits: 计划发布日, 目标字数, 负责人, 审阅 (H-09). */
function PlanPopover({ work, onSaved }: { work: Work; onSaved: (w: Work) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const canWrite = useCanWrite()
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<WorkspaceMember[]>('/workspaces/current/members'), enabled: open })
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const save = async (p: Record<string, unknown>) => {
    try {
      onSaved(await patch<Work>(`/works/${work.id}`, p))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const assignee = members.data?.find((m) => m.user_id === work.assignee_id)
  return (
    <div ref={ref} className="desktop-work-plan relative">
      <Button size="sm" variant="ghost" icon={<CalendarDays className="size-4" />} onClick={() => setOpen((v) => !v)}>
        <span className="hidden xl:inline">{work.planned_date ? `计划 ${work.planned_date.slice(5)}` : '计划'}</span>
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 animate-fade-in space-y-3 rounded-xl border border-mist-200 bg-white p-4 shadow-pop">
          <Field label="计划发布日" hint="只用于提醒和日历，不会自动发布">
            <Input type="date" disabled={!canWrite} value={work.planned_date ?? ''} onChange={(e) => save({ planned_date: e.target.value })} />
          </Field>
          <Field label="目标字数" hint="编辑器里会显示进度">
            <Input type="number" min={0} step={100} disabled={!canWrite} defaultValue={work.target_chars ?? ''} placeholder="不设"
              onBlur={(e) => { const v = Number(e.target.value || 0); if (v !== (work.target_chars ?? 0)) void save({ target_chars: v }) }} />
          </Field>
          <Field label="负责人">
            <Select disabled={!canWrite} value={work.assignee_id ?? ''} onChange={(e) => save({ assignee_id: e.target.value })}>
              <option value="">未指定</option>
              {(members.data ?? []).filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{m.username}</option>)}
              {work.assignee_id && !assignee && <option value={work.assignee_id}>当前负责人</option>}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-[13px] text-mist-700">
            <Switch checked={!!work.review_required} disabled={!canWrite} onChange={(v) => save({ review_required: v })} />
            <span>发布前需要审阅<span className="block text-[11.5px] text-mist-400">检查确认后进入「待审阅」，由所有者或指定的审阅人审阅通过后才能写入草稿或生成发布包（H-09）。</span></span>
          </label>
          {work.review_required && (
            <Field label="审阅人" hint="负责人不能审阅自己负责的作品；不指定时由所有者审阅">
              <Select disabled={!canWrite} value={work.reviewer_id ?? ''} onChange={(e) => save({ reviewer_id: e.target.value })}>
                <option value="">所有者</option>
                {(members.data ?? []).filter((m) => m.status === 'active' && m.role !== 'viewer' && m.user_id !== work.assignee_id)
                  .map((m) => <option key={m.user_id} value={m.user_id}>{m.username}</option>)}
                {work.reviewer_id && !members.data?.some((m) => m.user_id === work.reviewer_id) && <option value={work.reviewer_id}>当前审阅人</option>}
              </Select>
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

interface FamilyMember { id: string; source_id: string | null; title: string; status: WorkStatus; platform: Platform; account: string; depth: number; needs_sync: boolean }
const FAMILY_KEY = 'ops.family.collapsed'

/** FamilyStrip shows the root work and every derived version (any depth) side by side at the top of the work (EX-F-04). */
function FamilyStrip({ work }: { work: Work }) {
  const related = !!work.source || work.derived.length > 0
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(FAMILY_KEY) === '1')
  const fam = useQuery({
    queryKey: ['work', work.id, 'family', work.revision],
    queryFn: () => get<FamilyMember[]>(`/works/${work.id}/family`),
    enabled: related,
    staleTime: 30_000,
  })
  const list = fam.data ?? []
  if (!related || list.length < 2) return null
  const toggle = () => {
    localStorage.setItem(FAMILY_KEY, collapsed ? '0' : '1')
    setCollapsed(!collapsed)
  }
  return (
    <div className="border-t border-mist-100 bg-mist-50/60 px-5 py-2">
      <button type="button" aria-expanded={!collapsed} aria-controls="work-family-content" onClick={toggle} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-mist-500 hover:text-mist-800">
        <Layers className="size-3.5" />版本族 · {list.length} 个版本
        {list.some((m) => m.needs_sync) && <Badge tone="gamboge">有版本需要同步</Badge>}
        {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
      </button>
      <div id="work-family-content" aria-hidden={collapsed} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
        <div className="min-h-0 overflow-hidden">
          <ul className="scrollbar-thin mt-2 flex gap-2 overflow-x-auto pb-1">
          {list.map((m) => (
            <li key={m.id} className="w-52 shrink-0">
              <Link to={`/works/${m.id}`} tabIndex={collapsed ? -1 : undefined}
                className={cn('block rounded-lg border bg-white p-2.5 text-[12.5px] transition hover:border-ink-300', m.id === work.id ? 'border-ink-400 ring-1 ring-ink-200' : 'border-mist-200')}>
                <div className="flex items-center gap-1.5">
                  <PlatformMark platform={m.platform} />
                  <span className="truncate text-mist-500">{m.account}</span>
                  {m.depth === 0 ? <Badge tone="gray" className="ml-auto">源</Badge> : m.depth > 1 && <span className="ml-auto text-[10.5px] text-mist-400">第 {m.depth} 层</span>}
                </div>
                <div className="mt-1 truncate font-medium text-mist-800">{m.title || '未命名'}</div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <StatusBadge status={m.status} />
                  {m.needs_sync && <Badge tone="gamboge">需要同步</Badge>}
                  {m.id === work.id && <span className="ml-auto text-[11px] text-ink-600">当前</span>}
                </div>
              </Link>
            </li>
          ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

const reasonLabel: Record<string, string> = { auto: '自动保存', ai: 'AI 生成', manual: '手动保存', check: '提交检查', restore: '恢复版本' }

interface VersionRestorePreview {
  supported: boolean
  legacy_text_only: boolean
  reason?: string
  current_revision: number
  changed_fields: string[]
  missing_dependencies: string[]
  requires_h03: boolean
  preserved_additional_assets: number
}

function Versions({ work, open, onClose, onRestored }: { work: Work; open: boolean; onClose: () => void; onRestored: (w: Work) => void }) {
  const { data, refetch } = useQuery({
    queryKey: ['versions', work.id],
    queryFn: () => get<{ version_no: number; reason: string; title: string | null; created_at: string }[]>(`/works/${work.id}/versions`),
    enabled: open,
  })
  const [preview, setPreview] = useState<{ no: number; snap: any; restore: VersionRestorePreview } | null>(null)
  const show = async (no: number) => {
    try {
      const wait: Promise<unknown>[] = []
      emitEditor({ type: 'flush', wait })
      await Promise.all(wait)
      const r = await get<{ snapshot: any; restore_preview: VersionRestorePreview }>(`/works/${work.id}/versions/${no}`)
      setPreview({ no, snap: r.snapshot, restore: r.restore_preview })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const restore = async (no: number) => {
    if (!preview?.restore.supported) return
    const scope = preview.restore.legacy_text_only ? '当时保存的长文标题、摘要、观点、大纲和段落' : preview.restore.changed_fields.join('、') || '已保存的作品结构'
    const desc = `当前未提交的段落已先保存。系统会先保存当前版本，再恢复：${scope}。发布事实和账号配置不会回放；正文变化后需要重新检查和审阅。${preview.restore.requires_h03 ? '大纲语义已变化，恢复后需要重新确认 H-03。' : '大纲语义未变化，现有 H-03 确认保留。'}`
    if (!(await confirm({ title: `恢复到版本 ${no}？`, desc, confirmText: '恢复' }))) return
    try {
      const w = await post<Work>(`/works/${work.id}/versions/${no}/restore`, { base_revision: preview.restore.current_revision })
      onRestored(w)
      toast.success(`已恢复到版本 ${no}`)
      setPreview(null)
      refetch()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        await show(no)
        toast.error('作品已被修改，已更新预览；请重新核对差异后再恢复')
        return
      }
      toast.error(errorMessage(e))
    }
  }
  const saveNow = async () => {
    await post(`/works/${work.id}/versions`)
    refetch()
    toast.success('已保存一个版本')
  }
  return (
    <Drawer open={open} onClose={onClose} title="版本历史" desc="每次 AI 生成、手动保存和提交检查都会形成版本；编辑时每 10 分钟最多自动保存一个。" width="w-[560px]"
      footer={<Button onClick={saveNow} icon={<Save className="size-4" />}>保存当前版本</Button>}>
      {preview ? (
        <div className="animate-fade-in">
          <div className="mb-4 flex items-center justify-between">
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)} icon={<ArrowLeft className="size-4" />}>返回列表</Button>
            <Button size="sm" variant="primary" disabled={work.locked || !preview.restore.supported} onClick={() => restore(preview.no)} icon={<RotateCcw className="size-3.5" />}>恢复这个版本</Button>
          </div>
          {preview.restore.legacy_text_only && <Notice tone="gamboge" className="mb-3">这是旧版文字快照，只恢复当时保存的文字字段；图片、主题和其他未保存字段保持当前值。</Notice>}
          {!preview.restore.supported && <Notice tone="red" className="mb-3">
            <div>{preview.restore.reason || '此版本当前不能安全恢复。'}</div>
            {preview.restore.missing_dependencies.length > 0 && <ul className="mt-1 list-disc pl-5">{preview.restore.missing_dependencies.map((item) => <li key={item}>{item}</li>)}</ul>}
          </Notice>}
          {preview.restore.supported && <div className="mb-3 space-y-2">
            <Notice tone="ink">与当前稿不同：{preview.restore.changed_fields.length ? preview.restore.changed_fields.join('、') : '没有可见字段差异'}。</Notice>
            <Notice tone={preview.restore.requires_h03 ? 'gamboge' : 'gray'}>{preview.restore.requires_h03 ? '大纲语义变化，恢复后需重新确认 H-03。' : '大纲语义未变化，保留当前 H-03 确认。'}</Notice>
            {preview.restore.preserved_additional_assets > 0 && <Notice tone="gray">快照后新增的 {preview.restore.preserved_additional_assets} 张作品图片会保留在历史图片之后。</Notice>}
          </div>}
          <h3 className="font-display text-xl font-bold">{preview.snap.title || '未命名'}</h3>
          {preview.snap.viewpoint && <p className="mt-2 rounded-lg bg-mist-50 p-3 text-[13px] text-mist-600">观点：{preview.snap.viewpoint}</p>}
          {!preview.restore.legacy_text_only && <div className="mt-3 flex flex-wrap gap-2 text-xs text-mist-500">
            <Badge tone="gray">{preview.snap.content_format}</Badge>
            <Badge tone="gray">{preview.snap.cards?.length ?? 0} 张卡片</Badge>
            <Badge tone="gray">{preview.snap.panels?.length ?? 0} 个分格</Badge>
            <Badge tone="gray">{preview.snap.assets?.length ?? 0} 张作品图片</Badge>
          </div>}
          <div className="mt-4 space-y-4">
            {preview.snap.sections?.map((s: { heading: string; content_md: string }, i: number) => (
              <div key={i}>
                {s.heading && <div className="mb-1 font-semibold text-mist-800">{s.heading}</div>}
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-mist-600">{s.content_md || '（空）'}</p>
              </div>
            ))}
          </div>
          {preview.snap.panels?.length > 0 && <div className="mt-4 space-y-2 border-t border-mist-100 pt-4">
            <h4 className="text-sm font-semibold text-mist-800">漫画分格与气泡</h4>
            {preview.snap.panels.map((panel: { id: string; scene: string; dialogue: string; bubbles?: { text: string }[] }, i: number) => <div key={panel.id} className="rounded-lg bg-mist-50 p-3 text-[13px]">
              <div className="font-medium">第 {i + 1} 格{panel.scene ? ` · ${panel.scene}` : ''}</div>
              {panel.dialogue && <div className="mt-1">{panel.dialogue}</div>}
              {!!panel.bubbles?.length && <div className="mt-1 text-mist-500">气泡：{panel.bubbles.map((bubble) => bubble.text).join(' / ')}</div>}
            </div>)}
          </div>}
        </div>
      ) : (
        <ul className="space-y-1">
          {data?.map((v) => (
            <li key={v.version_no}>
              <button onClick={() => show(v.version_no)} className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-mist-50">
                <span className="w-10 font-mono text-xs text-mist-400">v{v.version_no}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-mist-800">{v.title || '未命名'}</span>
                <Badge tone={v.reason === 'ai' ? 'ink' : v.reason === 'check' ? 'gamboge' : 'gray'}>{reasonLabel[v.reason]}</Badge>
                <span className="w-28 text-right text-xs text-mist-400">{fmtTime(v.created_at)}</span>
              </button>
            </li>
          ))}
          {data?.length === 0 && <p className="py-10 text-center text-sm text-mist-400">还没有版本</p>}
        </ul>
      )}
    </Drawer>
  )
}

export default function WorkLayout() {
  const location = useLocation()
  const nav = useNavigate()
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const [copying, setCopying] = useState(false)
  const [exporting, setExporting] = useState(false)
  // NW-B6：页头重命名（空标题也可直接命名）。
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const visible = usePageVisible()
  const { workId } = useParams()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const canWrite = useCanWrite()
  const workKey = useMemo(() => currentWorkQueryKey(workId ?? '', me?.user_id ?? me?.username ?? '', me?.workspace.id ?? ''),
    [workId, me?.user_id, me?.username, me?.workspace.id])
  const q = useQuery({
    queryKey: workKey,
    queryFn: () => get<Work>(`/works/${workId}`),
    enabled: !!workId && !!me?.workspace.id,
    staleTime: 30_000,
  })
  const platformSource = useQuery({
    queryKey: ['platform-work-mirror', q.data?.account_id, q.data?.platform_source_mirror_id],
    queryFn: async () => (await get<{ work: PlatformWorkMirror }>(`/accounts/${q.data!.account_id}/platform-works/${q.data!.platform_source_mirror_id}`)).work,
    enabled: !!q.data?.platform_source_mirror_id,
    staleTime: 30_000,
  })
  const setWork = useCallback((w: Work) => {
    qc.setQueryData(workKey, w)
    qc.setQueryData(['work', workId], w)
  }, [qc, workId, workKey])
  const patchWork = useCallback((p: Partial<Work> | ((w: Work) => Partial<Work>)) =>
    {
      const update = (w: Work | undefined) => w ? { ...w, ...(typeof p === 'function' ? p(w) : p) } : w
      qc.setQueryData<Work>(workKey, update)
      qc.setQueryData<Work>(['work', workId], update)
    }, [qc, workId, workKey])
  const refresh = useCallback(() => q.refetch(), [q.refetch])
  const [versions, setVersions] = useState(false)
  const [derive, setDerive] = useState(false)
  const [platformSourceDiffOpen, setPlatformSourceDiffOpen] = useState(false)
  const prefs = usePrefs()
  const [focus, setFocusState] = useState(prefs.focus_default)
  const [presence, setPresence] = useState<Presence[]>([])
  const sectionRef = useRef<string | null>(null)
  useCustomTheme(q.data?.account_id)
  const stars = useQuery({ queryKey: ['stars'], queryFn: () => get<StarItem[]>('/stars'), staleTime: 60_000 })
  const starred = (stars.data ?? []).some((s) => s.object_type === 'work' && s.object_id === workId)
  useEffect(() => {
    if (q.data) {
      rememberAccount(q.data.account_id, me?.user_id ?? me?.username, me?.workspace.id)
      rememberRecent({ type: 'work', title: q.data.title || '未命名作品', link: `/works/${q.data.id}` })
    }
  }, [q.data?.id, q.data?.title, me?.user_id, me?.workspace.id])
  const setFocus = useCallback((v: boolean) => {
    setFocusState(v)
    window.dispatchEvent(new CustomEvent('ops:focus', { detail: v }))
  }, [])
  // GL-08：桌面退出与页面离开共用作品保存协调器，任一保存失败都阻止离开。
  useEffect(() => {
    const onLeaveGuard = (event: Event) => {
      if ((event as CustomEvent<{ draftOnly?: boolean }>).detail?.draftOnly) return
      if (!workId) return
      const detail = (event as CustomEvent<{ register?: (check: () => Promise<boolean> | boolean) => void }>).detail
      if (typeof detail?.register !== 'function') return
      detail.register(async () => {
        const pending: Promise<unknown>[] = []
        emitEditor({ type: 'flush', wait: pending })
        try {
          await Promise.all([...pending, flushWork(workId)])
          return true
        } catch (error) {
          toast.error(`保存未完成，已取消离开：${errorMessage(error)}`)
          return false
        }
      })
    }
    window.addEventListener(DESKTOP_LEAVE_GUARD_REQUEST, onLeaveGuard)
    return () => window.removeEventListener(DESKTOP_LEAVE_GUARD_REQUEST, onLeaveGuard)
  }, [workId])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ops:focus', { detail: focus }))
    return () => { window.dispatchEvent(new CustomEvent('ops:focus', { detail: false })) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F11' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f')) {
        e.preventDefault()
        setFocus(!focus)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [focus, setFocus])
  useWorkCmd((c) => {
    if (c.cmd === 'versions') setVersions(true)
    if (c.cmd === 'derive') setDerive(true)
    if (c.cmd === 'focus') setFocus(!focus)
  })
  // Presence (S3 协同提示): heartbeat every 20s; the server forgets entries after 30s.
  useEffect(() => {
    if (!workId || !visible) return
    let alive = true
    const beat = () => {
      if (document.hidden) return
      void post<Presence[]>(`/works/${workId}/presence`, { section_id: sectionRef.current }).then((l) => alive && setPresence(l)).catch(() => undefined)
      // ED-16：别人改了这段时，本地缓存 30 秒内不会更新，建议卡会拿旧正文判断"原文在哪"，
      // 然后被静默覆盖。心跳时顺带拉一次正文，别处改动就能及时反映到编辑器。
      void qc.invalidateQueries({ queryKey: workKey })
      void qc.invalidateQueries({ queryKey: ['work', workId] })
    }
    void beat()
    const t = window.setInterval(beat, 20_000)
    return () => {
      alive = false
      window.clearInterval(t)
      if (!document.hidden) void post(`/works/${workId}/presence`, { leave: true }).catch(() => undefined)
    }
  }, [workId, visible, qc, workKey])
  const reportSection = useCallback((id: string | null) => {
    if (sectionRef.current === id) return
    sectionRef.current = id
    if (document.hidden) return
    void post<Presence[]>(`/works/${workId}/presence`, { section_id: id }).then(setPresence).catch(() => undefined)
  }, [workId])
  const editedAt = useRef(0)
  const reportEditing = useCallback((id: string) => {
    if (document.hidden) return
    if (sectionRef.current === id && Date.now() - editedAt.current < 10_000) return
    sectionRef.current = id
    editedAt.current = Date.now()
    void post<Presence[]>(`/works/${workId}/presence`, { section_id: id, editing: true }).then(setPresence).catch(() => undefined)
  }, [workId])
  if (q.isLoading) return <PageLoading variant="editor" />
  if (q.isError || !q.data) {
    // NW-A3：只有 404 才是"不存在或已删除"；网络/5xx 给重试，不误导用户重建。
    const notFound = q.error instanceof ApiError && q.error.status === 404
    return <div className="p-10"><Notice tone="red">
      {q.error ? errorMessage(q.error) : '作品加载失败，请检查网络后重试'}
      {!notFound && <Button size="sm" className="ml-3" onClick={() => void q.refetch()}>重试</Button>}
    </Notice></div>
  }
  const work = q.data
  const duplicate = async () => {
    if (copying) return
    setCopying(true)
    try {
      const wait: Promise<unknown>[] = []
      emitEditor({ type: 'flush', wait })
      // NW-C4：段落由事件 flush，观点/标题由编辑器注册的协调器 flush。
      await Promise.all([Promise.all(wait), flushWork(work.id)])
      const copied = await post<Work>(`/works/${work.id}/duplicate`)
      void qc.invalidateQueries({ queryKey: ['works', work.account_id] })
      nav(`/works/${copied.id}`)
    } catch (e) { toast.error(errorMessage(e)) } finally { setCopying(false) }
  }
  const exportMarkdown = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const wait: Promise<unknown>[] = []
      emitEditor({ type: 'flush', wait })
      await Promise.all([Promise.all(wait), flushWork(work.id)])
      const current = await get<Work>(`/works/${work.id}`)
      // D-153：跨源部署时图片要指向 API 域名，而不是前端页面域名。
      const assetOrigin = apiBase() || window.location.origin
      const url = URL.createObjectURL(new Blob([markdownForWork(current, assetOrigin)], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a')
      const filename = (current.title.trim() || '未命名作品').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '') || '未命名作品'
      link.href = url
      link.download = `${filename}.md`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      toast.success('已开始下载')
    } catch (e) { toast.error(errorMessage(e)) } finally { setExporting(false) }
  }
  const ctx: WorkCtx = { work, setWork, patchWork, refresh, focus, setFocus, presence, reportSection, reportEditing }
  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (next === work.title) { setRenaming(false); return }
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { title: next, base_revision: work.revision }))
      void qc.invalidateQueries({ queryKey: ['works', work.account_id] })
      toast.success(next ? '标题已更新' : '已清空标题')
      setRenaming(false)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const wx = work.platform === 'wechat_mp'
  const todos = work.post_push_todos ?? []
  const todosDone = todos.filter((t) => t.done).length
  const order = ['drafting', 'checking', 'reviewing', 'ready', 'pushed', 'packed', 'published']
  const toggleStar = async () => {
    try {
      if (starred) await del(`/stars/work/${work.id}`)
      else await post('/stars', { object_type: 'work', object_id: work.id })
      void stars.refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const reached = (s: string) => order.indexOf(work.status) >= order.indexOf(s)
  const comic = work.content_format === 'comic'
  const platformSourceChanged = !!platformSource.data && work.platform_source_content_revision != null
    && platformSource.data.content_revision > work.platform_source_content_revision
  const platformSourceLocalBody = work.sections.map((section) => section.content_md).filter(Boolean).join('\n\n')
  const platformSourceDiff = platformSourceChanged && work.revision > 1 && platformSource.data
    ? changedMiddle(platformSource.data.body_text, platformSourceLocalBody)
    : null
  // D-048：图文卡片与漫画同为图片消息流程，不提供对照改写与排版预览。
  const imageMsg = comic || work.content_format === 'card_post'
  // ED-05：流程条第一项的完成条件与编辑器左栏「创作步骤」同一判定，两套进度不矛盾。
  const creationReady = contentReady(creationSteps(work, work.platform === 'toutiao' && work.content_format === 'micro_post'))
  const steps = [
    { to: '', label: comic ? '漫画' : imageMsg ? '卡片' : '创作', end: true, done: creationReady },
    ...(work.source && !imageMsg ? [{ to: 'compare', label: '对照改写', end: false, done: false }] : []),
    ...(!imageMsg && wx ? [{ to: 'preview', label: '排版预览', end: false, done: false }] : []),
    { to: 'check', label: '发布前检查', end: false, done: reached('ready') },
    wx ? { to: 'push', label: imageMsg ? '图片草稿' : '写入草稿', end: false, done: reached('pushed') } : { to: 'pack', label: '发布包', end: false, done: reached('packed') },
  ]
  const unlock = async () => {
    try {
      await post(`/works/${work.id}/unlock`, {})
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') {
        if (await confirm({ title: '解锁编辑已发布的作品？', desc: e.message, confirmText: '解锁' })) {
          setWork(await post<Work>(`/works/${work.id}/unlock`, { confirm: true }))
        }
      } else toast.error(errorMessage(e))
    }
  }
  return (
    <div className={cn('flex min-h-full flex-col', desktopPresentation && 'desktop-work-layout')} data-testid={desktopPresentation ? 'desktop-work-layout' : undefined}>
      <header className={cn('work-header sticky top-0 z-20 border-b border-mist-200/80 bg-white/90 backdrop-blur', desktopPresentation && 'desktop-workbar')}>
        <div className="flex h-14 items-center gap-3 px-5">
          <Link to={`/a/${work.account_id}/works`} className="rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-mist-700" title="返回作品列表">
            <ArrowLeft className="size-4" />
          </Link>
          <PlatformMark platform={work.platform} size="sm" />
          <div className="desktop-work-title min-w-0">
            {/* NW-B6：页头标题可直接改名；空标题给"点击命名"。 */}
            {renaming ? (
              <input autoFocus value={titleDraft} maxLength={64} aria-label="作品标题"
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void saveTitle() }
                  if (e.key === 'Escape') { setRenaming(false); setTitleDraft(work.title) }
                }}
                className="w-full rounded border border-ink-300 px-1.5 py-0.5 text-[14.5px] font-semibold text-mist-900 outline-none" />
            ) : (
              <button type="button" disabled={!canWrite || work.locked} onClick={() => { setTitleDraft(work.title); setRenaming(true) }}
                title={canWrite && !work.locked ? '点击修改标题' : undefined}
                className={cn('block w-full truncate text-left text-[14.5px] font-semibold text-mist-900', canWrite && !work.locked && 'cursor-pointer rounded px-1 -mx-1 hover:bg-mist-100')}>
                {work.title || <span className="text-mist-400">未命名作品 · 点击命名</span>}
              </button>
            )}
            <div className="truncate text-[11.5px] text-mist-500" title={`${work.account_name} · ${platformLabel[work.platform]} · ${platformFormatLabel(work.platform, work.content_format)}`}>{work.account_name} · {platformLabel[work.platform]} · {platformFormatLabel(work.platform, work.content_format)}</div>
          </div>
          <span className="shrink-0"><StatusBadge status={work.status} /></span>
          {todos.length > 0 && todosDone < todos.length && (
            <Link to={`/works/${work.id}/${wx ? 'push' : 'pack'}`} title="在平台后台还要完成的事项"
              className="hidden shrink-0 rounded-full bg-gamboge-50 px-2 py-0.5 text-[11.5px] text-gamboge-700 hover:bg-gamboge-100 sm:inline">
              后台待办 {todosDone}/{todos.length}
            </Link>
          )}
          {work.source && (
            <Link to={`/works/${work.source.id}`} className="hidden min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-ink-600 hover:underline 2xl:inline-flex">
              <GitBranch className="size-3" />{work.source.deleted ? '源作品已删除' : `源：${work.source.title || '未命名'}`}
            </Link>
          )}
          <button type="button" onClick={toggleStar} title={starred ? '取消收藏' : '收藏'} className={cn('shrink-0 cursor-pointer rounded p-1', starred ? 'text-gamboge-500' : 'text-mist-300 hover:text-gamboge-500')}>
            <Star className="size-4" fill={starred ? 'currentColor' : 'none'} />
          </button>
          {presence.length > 0 && (
            <div className="hidden shrink-0 items-center gap-1 md:flex" title={presence.map((p) => `${p.username} 正在查看`).join('\n')}>
              <div className="flex -space-x-1.5">
                {presence.slice(0, 3).map((p) => (
                  <span key={p.user_id} className="flex size-6 items-center justify-center rounded-full border-2 border-white bg-gamboge-400 text-[10px] font-bold text-mist-900">{p.username[0]?.toUpperCase()}</span>
                ))}
              </div>
              <span className="text-[11.5px] text-mist-500">{presence.length === 1 ? `${presence[0].username} 也在这里` : `${presence.length} 人也在这里`}</span>
            </div>
          )}
          <div className={cn('work-header-actions ml-auto flex shrink-0 items-center gap-1', !focus && 'lg:ml-0')}>
            <div id="work-header-action-target" data-testid="work-next-action" className="desktop-work-next mr-1 flex shrink-0 items-center" />
            <PlanPopover work={work} onSaved={setWork} />
            <Button className="desktop-work-history" size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setVersions(true)}><span className="hidden xl:inline">版本</span></Button>
            {canWrite && <Button className="desktop-work-derive" size="sm" variant="ghost" icon={<GitBranch className="size-4" />} onClick={() => setDerive(true)}><span className="hidden xl:inline">派生</span></Button>}
            {canWrite && <MoreMenu className="desktop-work-more" items={[
              ...(location.pathname === `/works/${work.id}` ? [{ label: '口述 / 要点扩写', icon: <Wand2 />, onClick: () => window.dispatchEvent(new Event('ops:organize-notes')) }] : []),
              ...(location.pathname === `/works/${work.id}` ? [
                { label: '生成标题候选', icon: <Wand2 />, onClick: () => window.dispatchEvent(new Event('ops:generate-titles')) },
              ] : []),
              { label: '复制为新草稿', icon: <Copy />, loading: copying, onClick: () => void duplicate() },
              ...(location.pathname === `/works/${work.id}` ? [{ label: '导出 Markdown', icon: <Download />, loading: exporting, onClick: () => void exportMarkdown() }] : []),
            ]} />}
            <Button className="desktop-work-focus" size="sm" variant="ghost" title="专注模式（F11）" icon={focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />} onClick={() => setFocus(!focus)} />
          </div>
        </div>
        {!focus && <div className="desktop-workbar-flow">
          {/* ED-05：这是「发布进度」，只随状态机推进；内容进度看左栏「创作步骤」。
              第一项（创作）的完成条件与左栏同一判定（contentReady），两套进度不会互相矛盾。 */}
          <div className="desktop-workbar-flow-label">发布进度：内容写完后按状态推进</div>
          <nav aria-label="发布进度">
            {steps.map((s, i) => (
              <NavLink key={s.to} to={s.to} end={s.end}
                className={({ isActive }) => cn('flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] transition',
                  isActive ? 'bg-ink-600 font-medium text-white' : 'text-mist-500 hover:bg-mist-100 hover:text-mist-800')}>
                {({ isActive }) => <>
                  <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px] font-bold',
                    isActive ? 'bg-white/25' : s.done ? 'bg-ink-100 text-ink-700' : 'bg-mist-200 text-mist-500')}>
                    {s.done && !isActive ? <Check className="size-2.5" /> : i + 1}
                  </span>
                  {s.label}
                </>}
              </NavLink>
            ))}
          </nav>
        </div>}
        {!focus && <FamilyStrip work={work} />}
        {!canWrite && (
          <div className="border-t border-mist-100 bg-mist-50 px-5 py-2 text-[13px] text-mist-600">观察者只读：可浏览作品，不能编辑、检查确认、派生或推送。</div>
        )}
        {work.locked && (
          <div className="flex items-center gap-3 border-t border-emerald-100 bg-emerald-50 px-5 py-2 text-[13px] text-emerald-800">
            <Lock className="size-4" />已发布的作品默认只读。修改不会同步到平台。
            {canWrite && <Button size="sm" variant="secondary" className="ml-auto" onClick={unlock}>解锁编辑</Button>}
          </div>
        )}
        {work.source_updated && (
          <div className="border-t border-gamboge-100 bg-gamboge-50 px-5 py-2 text-[13px] text-gamboge-700">
            {comic
              ? '源稿已更新。衍生漫画不会自动同步，请在漫画编辑器中核对并改写旁白、对白。'
              : '源稿已更新。衍生作品不会自动重新改写，可以在「对照改写」中对需要的段落重新改写。'}
          </div>
        )}
        {platformSourceChanged && work.revision > 1 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-gamboge-100 bg-gamboge-50 px-5 py-2 text-[13px] text-gamboge-800">
            平台来源内容和本地草稿都已修改；系统不会自动合并。
            <Button size="sm" variant="secondary" className="ml-auto" disabled={platformSource.isLoading || !platformSourceDiff}
              onClick={() => setPlatformSourceDiffOpen(true)}>查看差异</Button>
          </div>
        )}
        {work.draft_maybe_published && (
          <div className="flex items-center gap-3 border-t border-gamboge-100 bg-gamboge-50 px-5 py-2 text-[13px] text-gamboge-800">
            草稿可能已从公众号草稿箱消失（或许已发表）。系统不会自动改状态。
            <Button size="sm" variant="secondary" className="ml-auto" onClick={async () => {
              try {
                const r = await post<{ maybe_published: boolean; message: string }>(`/works/${work.id}/wechat/sync-draft`)
                toast.message(r.message)
                await q.refetch()
              } catch (e) { toast.error(errorMessage(e)) }
            }}>重新同步</Button>
            <Link to={`/works/${work.id}/push`} className="text-[13px] font-medium underline">去回填</Link>
          </div>
        )}
        {work.human_edit_ratio != null && (
          <div className="border-t border-mist-100 bg-mist-50/80 px-5 py-1.5 text-[12px] text-mist-500">
            人工修改比例约 {Math.round(work.human_edit_ratio * 100)}%（相对 AI 初稿，仅自查参考）
          </div>
        )}
      </header>
      <div key={location.pathname} className={cn('min-h-0 flex-1 animate-fade-in', desktopPresentation && location.pathname.endsWith('/pack') && 'desktop-work-pack-outlet')}>
        <Outlet context={ctx} />
      </div>
      <Versions work={work} open={versions} onClose={() => setVersions(false)} onRestored={setWork} />
      {derive && <DeriveDialog open onClose={() => setDerive(false)} workId={work.id} platform={work.platform} format={work.content_format} />}
      {platformSourceDiffOpen && platformSource.data && platformSourceDiff && <Dialog open onClose={() => setPlatformSourceDiffOpen(false)}
        title="平台来源与本地草稿差异" desc={`来源正文修订 ${work.platform_source_content_revision} → ${platformSource.data.content_revision}。以下只展示差异片段，不会自动写入本地作品。`} width="max-w-5xl">
        <div className="grid gap-4 md:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-mist-800">平台当前内容：移除或变更部分</h3>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-mist-200 bg-mist-50 p-4 font-sans text-[13px] leading-6">{platformSourceDiff.source || '（此处没有待移除的文字）'}</pre>
          </section>
          <section className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-mist-800">本地草稿：新增或变更部分</h3>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-mist-200 bg-white p-4 font-sans text-[13px] leading-6">{platformSourceDiff.local || '（此处没有新增的文字）'}</pre>
          </section>
        </div>
      </Dialog>}
    </div>
  )
}
