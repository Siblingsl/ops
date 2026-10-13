import { Trends } from './Trends'
import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Notice, Spinner, Textarea } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { useCanWrite, useInvalidate } from '@/lib/session'
import type { Account, AccountHot, HotMatch } from '@/lib/types'

const riskLabel: Record<string, string> = { disaster: '灾难事故', tragedy: '伤亡悲剧', politics: '时政敏感', unverified: '尚未证实', commercial: '商业推广' }
const risky = (item: HotMatch) => item.risk.some((r) => ['disaster', 'tragedy', 'politics'].includes(r))

export default function HotPanel({ account, compact=false }: { account: Account; compact?: boolean }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const query = useQuery({ queryKey: ['account-hot', account.id], queryFn: () => get<AccountHot>(`/accounts/${account.id}/hot`), refetchInterval: (q) => q.state.data?.preparing ? 2000 : false })
  const [busy, setBusy] = useState(false)
 const [trends,setTrends]=useState(false)
  const [editing, setEditing] = useState<HotMatch | null>(null)
  const [title, setTitle] = useState('')
  const [angle, setAngle] = useState('')
  const run = async (path: string, body?: unknown) => {
    setBusy(true)
    try {
      await post(path, body)
      setEditing(null)
      if (path.startsWith('/hot-matches/') && path.endsWith('/convert')) await inv(['account-hot', account.id], ['topics', account.id])
      else await inv(['account-hot', account.id], ['hot-trends', account.id], ['references', account.id], ['plan', account.id], ['daily', account.id], ['next-actions', account.id], ['topics', account.id], ['dashboard', account.id])
      toast.success('已更新')
    }
    catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const paste = canWrite ? <Link to={`/a/${account.id}/topics?hot=1`}><Button>去选题池粘贴资讯</Button></Link> : undefined
  return <Card><CardHeader title="今日热点" desc="按账号方案筛选公开热点；逐条选择，事件细节请查看原文核实。" action={canWrite && query.data?.enabled ? <Button loading={busy} disabled={!!query.data.preparing} onClick={() => run(`/accounts/${account.id}/hot/refresh`)}>匹配今日热点</Button> : undefined} />
    {query.isError ? <Notice tone="red">{errorMessage(query.error)}<Button size="sm" onClick={() => query.refetch()}>重试</Button></Notice> : query.isPending ? <div className="p-5"><Spinner /></div> : !query.data.enabled ? <Empty icon={<Activity className="size-5" />} title="热点采集未开启" desc="可配置工作区来源，或手动粘贴资讯。" action={<div className="flex flex-wrap gap-2"><Link to="/settings/hot-sources"><Button size="sm">去配置热点来源</Button></Link>{paste}</div>} /> : <div className="space-y-4 p-5">
      {!compact&&<div className="flex gap-2"><Button size="sm" onClick={()=>setTrends(false)}>今日</Button><Button size="sm" onClick={()=>setTrends(true)}>近 7 天趋势与赛道雷达</Button></div>}{trends?<Trends accountId={account.id}/>:<>
 <p className="text-xs text-mist-500">最近匹配：{query.data.updated_at ? new Date(query.data.updated_at).toLocaleString('zh-CN') : '尚未匹配'}</p>
      {query.data.paused_sources.length > 0 && <Notice tone="gamboge">部分来源暂停：{query.data.paused_sources.join('、')}。其余来源仍可使用。</Notice>}
      {query.data.preparing && <Notice>正在准备今日热点…</Notice>}
      {editing && <div className="space-y-3 rounded-lg border border-gamboge-200 p-4"><Field label="选题标题"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Field label="切入角度"><Textarea rows={3} value={angle} onChange={(e) => setAngle(e.target.value)} /></Field><Button variant="human" loading={busy} disabled={!title.trim()} onClick={() => run(`/hot-matches/${editing.id}/convert`, { title, angle })}>确认转为选题</Button><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>取消</Button></div>}
      {!query.data.items.length ? <Empty title="暂无相关热点" desc="先启用工作区来源并完成采集，再匹配今日热点。" action={<div className="flex flex-wrap gap-2"><Link to="/settings/hot-sources"><Button size="sm">去配置热点来源</Button></Link>{paste}</div>} /> : <div className="grid gap-3 lg:grid-cols-2">{query.data.items.slice(0,compact?3:15).map((m) => <div key={m.id} className={`space-y-2 rounded-lg border p-4 ${risky(m) ? 'border-mist-200 bg-mist-50 text-mist-500' : 'border-mist-200'}`}>
        <div className="flex flex-wrap items-center gap-2"><Badge>{m.hot_item.sources?.length?m.hot_item.sources.map(s=>`${s.name}第 ${s.rank}`).join("、"):`${m.hot_item.source_name} · 第 ${m.hot_item.rank} 名`}</Badge><Badge tone="ink">相关度 {m.relevance}</Badge>{m.risk.map((r) => <Badge key={r} tone="gamboge">{riskLabel[r] ?? r}</Badge>)}</div>
        <h4 className="font-semibold">{m.hot_item.title}</h4><p className="text-xs text-mist-500">首次出现 {new Date(m.hot_item.first_seen_at).toLocaleString('zh-CN')} · 最近在榜 {new Date(m.hot_item.last_seen_at).toLocaleString('zh-CN')}</p>
        {m.hot_item.summary&&<p className="text-sm text-mist-600">原文摘要：{m.hot_item.summary}</p>}
 <p className="text-sm">为什么有关：{m.reason}</p><p className="text-sm">切入角度：{m.angle}</p>
        {risky(m) && <Notice tone="gamboge">不建议借此营销，不能转为选题。</Notice>}
        <div className="flex flex-wrap gap-2"><a href={m.hot_item.url} target="_blank" rel="noreferrer" className="text-sm text-ink-600">打开原文</a>{m.status === 'converted' && m.topic_id ? <Link className="text-sm text-ink-600" to={`/a/${account.id}/topics?focus=${m.topic_id}`}>查看选题</Link> : canWrite && <><Button size="sm" variant="human" disabled={busy || risky(m)} onClick={() => { setEditing(m); setTitle(m.hot_item.title); setAngle(m.angle) }}>转为选题</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => run(`/hot-matches/${m.id}/dismiss`)}>不感兴趣</Button></>}</div>
      </div>)}</div>}
      {compact?<Link className="text-sm text-ink-600" to={`/a/${account.id}/ops`}>查看今日热点</Link>:<Link className="text-sm text-ink-600" to="/settings/hot-sources">设置工作区热点来源</Link>}
    </>} </div>}
  </Card>
}
