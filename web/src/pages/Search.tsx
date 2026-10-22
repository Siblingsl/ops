import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, FileText, Lightbulb, PenTool, Search as SearchIcon, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, cn, Empty, Input, PageHeader, Select, Spinner, StatusBadge, statusMeta, Tabs, platformLabel, platformFormatLabel } from '@/components/ui'
import { del, errorMessage, get, post } from '@/lib/api'
import { relTime } from '@/lib/format'
import { useAccounts } from '@/lib/session'
import type { SearchHit, StarItem, WorkStatus } from '@/lib/types'
import { rememberRecent } from '@/lib/v3'

const typeMeta: Record<string, { label: string; icon: typeof FileText }> = {
  work: { label: '作品', icon: FileText },
  topic: { label: '选题', icon: Lightbulb },
  material: { label: '素材', icon: BookOpen },
  style_sample: { label: '风格样本', icon: PenTool },
}

const statusOptions: Record<string, [string, string][]> = {
  work: Object.entries(statusMeta).map(([v, m]) => [v, m.label]),
  topic: [['pending', '待定'], ['adopted', '已采用'], ['dropped', '已放弃']],
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const ts = terms.filter((t) => t.length > 0).sort((a, b) => b.length - a.length)
  if (ts.length === 0) return <>{text}</>
  const re = new RegExp(`(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-gamboge-100 px-0.5 text-mist-900">{p}</mark> : p))}</>
}

/** Search (第 4.2 节): workspace-wide full-text search over works, topics, materials and style samples. */
export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [type, setType] = useState<string>(params.get('type') ?? 'all')
  const [account, setAccount] = useState('')
  const [status, setStatus] = useState('')
  const [days, setDays] = useState('')
  const { data: accounts } = useAccounts()
  const qc = useQueryClient()
  const query = params.get('q') ?? ''
  const statuses = statusOptions[type] ?? []
  useEffect(() => setStatus(''), [type])
  const filters = [type !== 'all' && `types=${type}`, account && `account_id=${account}`, status && `status=${status}`, days && `days=${days}`].filter(Boolean).join('&')
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (q !== query) setParams((p) => { const n = new URLSearchParams(p); if (q) n.set('q', q); else n.delete('q'); return n }, { replace: true })
    }, 300)
    return () => window.clearTimeout(t)
  }, [q, query, setParams])
  const res = useQuery({
    queryKey: ['search-page', query, filters],
    queryFn: () => get<{ items: SearchHit[] }>(`/search?q=${encodeURIComponent(query)}&limit=60${filters ? `&${filters}` : ''}`),
    enabled: query.trim().length > 0,
  })
  const stars = useQuery({ queryKey: ['stars'], queryFn: () => get<StarItem[]>('/stars') })
  const toggleStar = async (h: SearchHit) => {
    try {
      if (h.starred) await del(`/stars/${h.type}/${h.id}`)
      else await post('/stars', { object_type: h.type, object_id: h.id })
      void res.refetch()
      void qc.invalidateQueries({ queryKey: ['stars'] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const items = res.data?.items ?? []
  return (
    <div className="animate-fade-in">
      <PageHeader title="搜索" desc="在当前工作区的作品、选题、素材和风格样本里查找。按 Ctrl+K 可随时打开快速搜索。" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入关键词，例如：周报 模板" className="h-10 pl-9" />
        </div>
        <Tabs value={type} onChange={setType} items={[
          { value: 'all', label: '全部' }, { value: 'work', label: '作品' }, { value: 'topic', label: '选题' },
          { value: 'material', label: '素材' }, { value: 'style_sample', label: '风格样本' },
        ]} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={account} onChange={(e) => setAccount(e.target.value)} className="!w-auto min-w-36" aria-label="账号">
          <option value="">全部账号</option>
          {(accounts ?? []).filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        {statuses.length > 0 && (
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto min-w-32" aria-label="状态">
            <option value="">全部状态</option>
            {statuses.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        )}
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="!w-auto min-w-32" aria-label="时间">
          <option value="">不限时间</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </Select>
        {type === 'all' && <span className="text-[12px] text-mist-400">选择「作品」或「选题」后可按状态筛选</span>}
      </div>
      {!query ? (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-mist-900"><Star className="size-4 text-gamboge-500" />我的收藏</div>
          {(stars.data ?? []).length === 0 ? <p className="text-[13px] text-mist-400">在搜索结果或作品列表里点星标即可收藏，方便下次快速找到。</p> : (
            <ul className="divide-y divide-mist-100">
              {stars.data!.map((s) => (
                <li key={s.object_type + s.object_id}>
                  <Link to={s.link} className="flex items-center gap-2 py-2 text-[13.5px] text-mist-700 hover:text-ink-700">
                    <span className="w-14 shrink-0 text-[11.5px] text-mist-400">{typeMeta[s.object_type]?.label}</span>
                    <span className="truncate">{s.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : res.isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : items.length === 0 ? (
        <Empty icon={<SearchIcon className="size-5" />} title="没有找到相关内容" desc={filters ? '换个说法试试，或放宽筛选条件。' : '换个说法试试，或减少关键词。'}
          action={filters ? <Button onClick={() => { setType('all'); setAccount(''); setStatus(''); setDays('') }}>清除筛选</Button> : <Button onClick={() => setQ('')}>清空关键词</Button>} />
      ) : (
        <Card className="divide-y divide-mist-100">
          {items.map((h) => {
            const M = typeMeta[h.type] ?? typeMeta.work
            return (
              <div key={h.type + h.id} className="flex items-start gap-3 px-5 py-3.5">
                <M.icon className="mt-0.5 size-4 shrink-0 text-mist-400" />
                <div className="min-w-0 flex-1">
                  <Link to={h.link} onClick={() => rememberRecent({ type: h.type, title: h.title, link: h.link })}
                    className="block truncate text-[14px] font-medium text-mist-900 hover:text-ink-700">
                    <Highlight text={h.title} terms={[query, ...h.matched]} />
                  </Link>
                  <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-mist-500"><Highlight text={h.snippet} terms={[query, ...h.matched]} /></p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-mist-400">
                    <span>{M.label}</span>·<span>{h.account_name}</span>
                    {h.platform && <span>{platformLabel[h.platform]}{h.content_format ? ` · ${platformFormatLabel(h.platform, h.content_format)}` : ''}</span>}
                    {h.type === 'work' && h.status && <StatusBadge status={h.status as WorkStatus} />}
                    <span>{relTime(h.updated_at)}</span>
                  </div>
                </div>
                {h.type !== 'style_sample' && (
                  <button type="button" onClick={() => toggleStar(h)} title={h.starred ? '取消收藏' : '收藏'}
                    className={cn('cursor-pointer rounded p-1 transition', h.starred ? 'text-gamboge-500' : 'text-mist-300 hover:text-gamboge-500')}>
                    <Star className="size-4" fill={h.starred ? 'currentColor' : 'none'} />
                  </button>
                )}
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
