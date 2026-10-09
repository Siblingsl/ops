import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Lightbulb, MoreHorizontal, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog, Drawer, confirm } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { Badge, Button, Card, cn, Empty, Field, HumanGate, IconButton, Input, Notice, PageHeader, PageLoading, Tabs, Textarea } from '@/components/ui'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import { type AIRefs, relTime } from '@/lib/format'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { Topic, Work } from '@/lib/types'

interface Suggestion { title: string; angle: string; reason: string }

const sourceLabel: Record<Topic['source'], { label: string; tone: 'gray' | 'ink' | 'gamboge' }> = {
  manual: { label: '手动', tone: 'gray' },
  ai: { label: 'AI 建议', tone: 'ink' },
  review: { label: '复盘', tone: 'gamboge' },
}

function SuggestDrawer({ open, onClose, accountId }: { open: boolean; onClose: () => void; accountId: string }) {
  const [direction, setDirection] = useState('')
  const [list, setList] = useState<Suggestion[]>([])
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [added, setAdded] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<number | null>(null)
  const inv = useInvalidate()
  const run = async () => {
    setBusy(true)
    try {
      const r = await post<{ suggestions: Suggestion[]; refs: AIRefs }>(`/accounts/${accountId}/topics/suggest`, { direction })
      setList(r.suggestions)
      setRefs(r.refs)
      setAdded({})
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  // H-01：每条建议单独入库，没有"全部入库"。
  const add = async (i: number) => {
    setAdding(i)
    try {
      const r = await post<{ topic: Topic; similar: string[] }>(`/accounts/${accountId}/topics`, { title: list[i].title, angle: list[i].angle, source: 'ai' })
      setAdded((a) => ({ ...a, [i]: true }))
      inv(['topics', accountId])
      if (r.similar.length) toast.warning(`已入库。注意与「${r.similar[0]}」相似`)
      else toast.success('已加入选题池')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAdding(null)
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title="AI 选题建议" desc="建议不会自动进入选题池，需要你逐条挑选。" width="w-[520px]">
      <div className="flex gap-2">
        <Input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="方向关键词（可选），例如：时间管理" onKeyDown={(e) => e.key === 'Enter' && run()} />
        <Button variant="primary" onClick={run} loading={busy} icon={<Sparkles className="size-4" />}>生成</Button>
      </div>
      <HumanGate code="H-01" className="mt-4">每条建议都需要你单独点「入库」。这里刻意没有「全部入库」。</HumanGate>
      {!busy && <RefsNote refs={refs} className="mt-3" />}
      <div className="mt-4 space-y-3">
        {busy && list.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-mist-100" />)}
        {list.map((s, i) => (
          <div key={i} className={cn('rounded-xl border p-4 transition', added[i] ? 'border-ink-200 bg-ink-50/40' : 'border-mist-200 bg-white')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-[15.5px] font-semibold leading-snug text-mist-900">{s.title}</div>
                <div className="mt-1.5 text-[13px] text-mist-600"><span className="text-mist-400">角度 · </span>{s.angle}</div>
                <div className="mt-0.5 text-[13px] text-mist-500"><span className="text-mist-400">理由 · </span>{s.reason}</div>
              </div>
              {added[i] ? (
                <Badge tone="ink"><Check className="size-3" />已入库</Badge>
              ) : (
                <Button size="sm" variant="outline" loading={adding === i} onClick={() => add(i)} icon={<Plus className="size-3.5" />}>入库</Button>
              )}
            </div>
          </div>
        ))}
        {!busy && list.length === 0 && <Empty icon={<Sparkles className="size-5" />} title="输入一个方向，或直接生成" desc="AI 会参考账号定位档案和最近的选题，避免重复。" />}
      </div>
    </Drawer>
  )
}

function TopicCard({ t, accountId }: { t: Topic; accountId: string }) {
  const inv = useInvalidate()
  const nav = useNavigate()
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const setStatus = async (status: Topic['status']) => {
    await patch(`/topics/${t.id}`, { status }).catch((e) => toast.error(errorMessage(e)))
    inv(['topics', accountId])
  }
  const start = async () => {
    setBusy(true)
    try {
      const w = await post<Work>(`/topics/${t.id}/works`)
      inv(['topics', accountId])
      nav(`/works/${w.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const remove = async () => {
    setMenu(false)
    if (!(await confirm({ title: '删除这个选题？', desc: '删除后可以在回收站中恢复（保留 30 天）。', confirmText: '删除', danger: true }))) return
    await del(`/topics/${t.id}`)
    inv(['topics', accountId])
    toast.success('已移到回收站')
  }
  return (
    <Card className="group relative p-4 transition hover:border-mist-300">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-display text-[15px] font-semibold leading-snug text-mist-900">{t.title}</div>
          {t.angle && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-mist-500">{t.angle}</p>}
        </div>
        <div className="relative">
          <IconButton label="更多" onClick={() => setMenu(!menu)} className="opacity-0 group-hover:opacity-100"><MoreHorizontal className="size-4" /></IconButton>
          {menu && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 animate-fade-in rounded-lg border border-mist-200 bg-white p-1 shadow-pop" onMouseLeave={() => setMenu(false)}>
              {t.status !== 'pending' && <button onClick={() => { setMenu(false); setStatus('pending') }} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><RotateCcw className="size-3.5" />放回待定</button>}
              {t.status !== 'dropped' && <button onClick={() => { setMenu(false); setStatus('dropped') }} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-mist-50"><X className="size-3.5" />放弃</button>}
              <button onClick={remove} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger hover:bg-orange-50"><Trash2 className="size-3.5" />删除</button>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Badge tone={sourceLabel[t.source].tone}>{sourceLabel[t.source].label}</Badge>
        <span className="text-xs text-mist-400">{relTime(t.created_at)}</span>
        <div className="ml-auto">
          {t.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => setStatus('adopted')} icon={<Check className="size-3.5" />}>采用</Button>}
          {t.status === 'adopted' && (t.work_id
            ? <Link to={`/works/${t.work_id}`}><Button size="sm" variant="ghost">打开作品<ArrowRight className="size-3.5" /></Button></Link>
            : <Button size="sm" variant="primary" loading={busy} onClick={start}>开始创作</Button>)}
        </div>
      </div>
    </Card>
  )
}

export default function Topics() {
  const acc = useCurrentAccount()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Topic['status']>('pending')
  const [suggest, setSuggest] = useState(params.get('suggest') === '1')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [angle, setAngle] = useState('')
  const [similar, setSimilar] = useState<string[]>([])
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({ queryKey: ['topics', acc?.id], queryFn: () => get<Topic[]>(`/accounts/${acc!.id}/topics`), enabled: !!acc })
  useEffect(() => {
    if (params.get('suggest')) setParams({}, { replace: true })
  }, [params, setParams])
  if (!acc || isLoading) return <PageLoading />
  const list = data ?? []
  const shown = list.filter((t) => t.status === tab)
  const save = async () => {
    try {
      const r = await post<{ topic: Topic; similar: string[] }>(`/accounts/${acc.id}/topics`, { title, angle })
      inv(['topics', acc.id])
      setSimilar(r.similar)
      setTitle('')
      setAngle('')
      if (r.similar.length === 0) setAdding(false)
      toast.success('已加入选题池')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="选题池" desc="先把想法存下来，采用后再开始创作。"
        action={<>
          <Button icon={<Plus className="size-4" />} onClick={() => { setSimilar([]); setAdding(true) }}>手动添加</Button>
          <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button>
        </>} />
      <Tabs value={tab} onChange={setTab} className="mb-5" items={[
        { value: 'pending', label: '待定', count: list.filter((t) => t.status === 'pending').length },
        { value: 'adopted', label: '已采用', count: list.filter((t) => t.status === 'adopted').length },
        { value: 'dropped', label: '已放弃', count: list.filter((t) => t.status === 'dropped').length },
      ]} />
      {shown.length === 0 ? (
        <Card><Empty icon={<Lightbulb className="size-5" />} title={tab === 'pending' ? '还没有待定的选题' : tab === 'adopted' ? '还没有采用的选题' : '没有放弃的选题'}
          desc={tab === 'pending' ? '手动记下一个想法，或者让 AI 根据账号定位给些建议。' : undefined}
          action={tab === 'pending' && <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setSuggest(true)}>AI 选题建议</Button>} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((t) => <TopicCard key={t.id} t={t} accountId={acc.id} />)}</div>
      )}
      <SuggestDrawer open={suggest} onClose={() => setSuggest(false)} accountId={acc.id} />
      <Dialog open={adding} onClose={() => setAdding(false)} title="添加选题"
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>{similar.length ? '完成' : '取消'}</Button><Button variant="primary" onClick={save} disabled={!title.trim()}>加入选题池</Button></>}>
        <div className="space-y-4">
          <Field label="标题"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="切入角度（可选）"><Textarea rows={3} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field>
          {similar.length > 0 && <Notice tone="gamboge">刚才入库的选题与「{similar.join('」「')}」相似，可以继续保留，也可以去删掉。</Notice>}
        </div>
      </Dialog>
    </div>
  )
}
