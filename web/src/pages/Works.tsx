import { useQuery } from '@tanstack/react-query'
import { FileText, GitBranch, ImageIcon, PenLine, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { DeriveDialog } from '@/components/derive'
import { confirm } from '@/components/dialog'
import { Button, Card, Empty, IconButton, Input, PageHeader, PageLoading, StatusBadge, Tabs } from '@/components/ui'
import { del, get } from '@/lib/api'
import { relTime } from '@/lib/format'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import type { WorkListItem, WorkStatus } from '@/lib/types'
import { useCreateWork } from './Dashboard'

type Filter = 'all' | 'drafting' | 'checking' | 'ready' | 'out' | 'published'
const filterStatus: Record<Filter, WorkStatus[] | null> = {
  all: null, drafting: ['drafting'], checking: ['checking'], ready: ['ready'], out: ['pushed', 'packed'], published: ['published'],
}

export function workLink(w: { id: string; status: WorkStatus }) {
  switch (w.status) {
    case 'checking': return `/works/${w.id}/check`
    case 'pushed': return `/works/${w.id}/push`
    case 'packed': return `/works/${w.id}/pack`
    default: return `/works/${w.id}`
  }
}

export default function Works() {
  const acc = useCurrentAccount()
  const canWrite = useCanWrite()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [derive, setDerive] = useState<WorkListItem | null>(null)
  const inv = useInvalidate()
  const create = useCreateWork(acc?.id)
  const { data, isLoading } = useQuery({ queryKey: ['works', acc?.id, q], queryFn: () => get<WorkListItem[]>(`/accounts/${acc!.id}/works?q=${encodeURIComponent(q)}`), enabled: !!acc })
  if (!acc) return <PageLoading />
  const list = data ?? []
  const shown = list.filter((w) => !filterStatus[filter] || filterStatus[filter]!.includes(w.status))
  const count = (f: Filter) => list.filter((w) => !filterStatus[f] || filterStatus[f]!.includes(w.status)).length
  const remove = async (w: WorkListItem) => {
    const extra = [
      w.derived_count > 0 && `这篇作品有 ${w.derived_count} 篇衍生作品，它们不受影响，只会显示「源作品已删除」。`,
      (w.status === 'pushed' || w.status === 'published') && acc.platform === 'wechat_mp' && '公众号草稿箱里的草稿不会被删除。',
    ].filter(Boolean)
    if (!(await confirm({ title: `删除「${w.title || '未命名作品'}」？`, desc: <>{extra.map((x) => <p key={String(x)} className="mb-1">{x}</p>)}<p>删除后可以在回收站中恢复（保留 30 天）。</p></>, confirmText: '删除', danger: true }))) return
    await del(`/works/${w.id}`)
    inv(['works', acc.id])
    toast.success('已移到回收站')
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="作品" desc={`${acc.name} 的全部作品`} action={canWrite ? <Button variant="primary" icon={<PenLine className="size-4" />} onClick={() => create()}>新建作品</Button> : undefined} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={filter} onChange={setFilter} items={[
          { value: 'all', label: '全部', count: count('all') },
          { value: 'drafting', label: '创作中', count: count('drafting') },
          { value: 'checking', label: '检查中', count: count('checking') },
          { value: 'ready', label: '可发布', count: count('ready') },
          { value: 'out', label: acc.platform === 'wechat_mp' ? '已进草稿箱' : '发布包', count: count('out') },
          { value: 'published', label: '已发布', count: count('published') },
        ]} />
        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题" className="pl-9" />
        </div>
      </div>
      {isLoading ? <PageLoading /> : shown.length === 0 ? (
        <Card><Empty icon={<FileText className="size-5" />} title="这里还没有作品" desc={canWrite ? '从选题池开始，或者直接新建一篇。' : '当前为观察者，只能浏览已有作品。'} action={canWrite ? <Button variant="primary" onClick={() => create()}>新建作品</Button> : undefined} /></Card>
      ) : (
        <Card className="divide-y divide-mist-100">
          {shown.map((w) => {
            const thumb = w.cover_asset_id ?? w.first_asset_id
            return (
              <div key={w.id} className="group flex items-center gap-4 px-5 py-3.5 transition hover:bg-mist-50/70">
                <Link to={workLink(w)} className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-mist-100 text-mist-300">
                    {thumb ? <img src={`/api/v1/assets/${thumb}/file`} className="size-full object-cover" alt="" /> : <ImageIcon className="size-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-[15.5px] font-semibold text-mist-900 group-hover:text-ink-700">{w.title || '未命名作品'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist-500">
                      <StatusBadge status={w.status} />
                      <span>{w.section_count} 段 · {w.char_count.toLocaleString()} 字</span>
                      {w.source_title !== null && w.source_work_id && <span className="inline-flex items-center gap-1 text-ink-600"><GitBranch className="size-3" />派生自《{w.source_title || '未命名'}》</span>}
                      {w.derived_count > 0 && <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{w.derived_count} 篇衍生</span>}
                      <span>{relTime(w.updated_at)}更新</span>
                    </div>
                  </div>
                </Link>
                {canWrite && (
                  <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <IconButton label="派生到其他平台" onClick={() => setDerive(w)}><GitBranch className="size-4" /></IconButton>
                    <IconButton label="删除" onClick={() => remove(w)} className="hover:text-danger"><Trash2 className="size-4" /></IconButton>
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}
      {derive && canWrite && <DeriveDialog open onClose={() => setDerive(null)} workId={derive.id} platform={acc.platform} format={derive.content_format} />}
    </div>
  )
}
