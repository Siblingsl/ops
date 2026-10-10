import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, GitBranch, History, Lock, RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DeriveDialog } from '@/components/derive'
import { confirm, Drawer } from '@/components/dialog'
import { Badge, Button, cn, Notice, PageLoading, PlatformMark, StatusBadge } from '@/components/ui'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { rememberAccount } from '@/lib/session'
import type { Work } from '@/lib/types'

export interface WorkCtx {
  work: Work
  setWork: (w: Work) => void
  patchWork: (p: Partial<Work> | ((w: Work) => Partial<Work>)) => void
  refresh: () => Promise<unknown>
}
export const useWork = () => useOutletContext<WorkCtx>()

const reasonLabel: Record<string, string> = { auto: '自动保存', ai: 'AI 生成', manual: '手动保存', check: '提交检查', restore: '恢复版本' }

function Versions({ work, open, onClose, onRestored }: { work: Work; open: boolean; onClose: () => void; onRestored: (w: Work) => void }) {
  const { data, refetch } = useQuery({
    queryKey: ['versions', work.id],
    queryFn: () => get<{ version_no: number; reason: string; title: string | null; created_at: string }[]>(`/works/${work.id}/versions`),
    enabled: open,
  })
  const [preview, setPreview] = useState<{ no: number; snap: { title: string; viewpoint: string; sections: { heading: string; content_md: string }[] } } | null>(null)
  const show = async (no: number) => {
    const r = await get<{ snapshot: any }>(`/works/${work.id}/versions/${no}`)
    setPreview({ no, snap: r.snapshot })
  }
  const restore = async (no: number) => {
    if (!(await confirm({ title: `恢复到版本 ${no}？`, desc: '当前内容会先保存为一个版本，然后用所选版本覆盖标题、观点、大纲和全部段落。恢复后需要重新检查。', confirmText: '恢复' }))) return
    try {
      const w = await post<Work>(`/works/${work.id}/versions/${no}/restore`)
      onRestored(w)
      toast.success(`已恢复到版本 ${no}`)
      setPreview(null)
      refetch()
    } catch (e) {
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
            <Button size="sm" variant="primary" disabled={work.locked} onClick={() => restore(preview.no)} icon={<RotateCcw className="size-3.5" />}>恢复这个版本</Button>
          </div>
          <h3 className="font-display text-xl font-bold">{preview.snap.title || '未命名'}</h3>
          {preview.snap.viewpoint && <p className="mt-2 rounded-lg bg-mist-50 p-3 text-[13px] text-mist-600">观点：{preview.snap.viewpoint}</p>}
          <div className="mt-4 space-y-4">
            {preview.snap.sections?.map((s, i) => (
              <div key={i}>
                {s.heading && <div className="mb-1 font-semibold text-mist-800">{s.heading}</div>}
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-mist-600">{s.content_md || '（空）'}</p>
              </div>
            ))}
          </div>
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
  const { workId } = useParams()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['work', workId], queryFn: () => get<Work>(`/works/${workId}`) })
  const [versions, setVersions] = useState(false)
  const [derive, setDerive] = useState(false)
  useEffect(() => {
    if (q.data) rememberAccount(q.data.account_id)
  }, [q.data])
  if (q.isLoading) return <PageLoading />
  if (q.isError || !q.data) {
    return <div className="p-10"><Notice tone="red">{q.error instanceof ApiError ? q.error.message : '作品不存在或已删除'}</Notice></div>
  }
  const work = q.data
  const setWork = (w: Work) => qc.setQueryData(['work', workId], w)
  const patchWork = (p: Partial<Work> | ((w: Work) => Partial<Work>)) =>
    qc.setQueryData<Work>(['work', workId], (w) => (w ? { ...w, ...(typeof p === 'function' ? p(w) : p) } : w))
  const ctx: WorkCtx = { work, setWork, patchWork, refresh: () => q.refetch() }
  const wx = work.platform === 'wechat_mp'
  const order = ['drafting', 'checking', 'ready', 'pushed', 'packed', 'published']
  const reached = (s: string) => order.indexOf(work.status) >= order.indexOf(s)
  const comic = work.content_format === 'comic'
  const steps = [
    { to: '', label: comic ? '漫画' : '创作', end: true, done: comic ? work.panels.some((p) => p.asset_id) : work.sections.some((s) => s.content_md) },
    ...(work.source ? [{ to: 'compare', label: '对照改写', end: false, done: false }] : []),
    ...(!comic && wx ? [{ to: 'preview', label: '排版预览', end: false, done: false }] : []),
    { to: 'check', label: '发布前检查', end: false, done: reached('ready') },
    wx ? { to: 'push', label: comic ? '图片草稿' : '写入草稿', end: false, done: reached('pushed') } : { to: 'pack', label: '发布包', end: false, done: reached('packed') },
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
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-mist-200/80 bg-white/90 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-5">
          <Link to={`/a/${work.account_id}/works`} className="rounded-md p-1.5 text-mist-400 hover:bg-mist-100 hover:text-mist-700" title="返回作品列表">
            <ArrowLeft className="size-4" />
          </Link>
          <PlatformMark platform={work.platform} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-semibold text-mist-900">{work.title || '未命名作品'}</div>
            <div className="text-[11.5px] text-mist-500">{work.account_name}</div>
          </div>
          <span className="shrink-0"><StatusBadge status={work.status} /></span>
          {work.source && (
            <Link to={`/works/${work.source.id}`} className="hidden min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-ink-600 hover:underline 2xl:inline-flex">
              <GitBranch className="size-3" />{work.source.deleted ? '源作品已删除' : `源：${work.source.title || '未命名'}`}
            </Link>
          )}
          <nav className="mx-auto hidden shrink-0 items-center gap-1 lg:flex">
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
          <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
            <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setVersions(true)}>版本</Button>
            <Button size="sm" variant="ghost" icon={<GitBranch className="size-4" />} onClick={() => setDerive(true)}>派生</Button>
          </div>
        </div>
        {work.locked && (
          <div className="flex items-center gap-3 border-t border-emerald-100 bg-emerald-50 px-5 py-2 text-[13px] text-emerald-800">
            <Lock className="size-4" />已发布的作品默认只读。修改不会同步到平台。
            <Button size="sm" variant="secondary" className="ml-auto" onClick={unlock}>解锁编辑</Button>
          </div>
        )}
        {work.source_updated && (
          <div className="border-t border-gamboge-100 bg-gamboge-50 px-5 py-2 text-[13px] text-gamboge-700">源稿已更新。衍生作品不会自动重新改写，可以在「对照改写」中对需要的段落重新改写。</div>
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
      <div className="flex-1">
        <Outlet context={ctx} />
      </div>
      <Versions work={work} open={versions} onClose={() => setVersions(false)} onRestored={setWork} />
      {derive && <DeriveDialog open onClose={() => setDerive(false)} workId={work.id} platform={work.platform} format={work.content_format} />}
    </div>
  )
}
