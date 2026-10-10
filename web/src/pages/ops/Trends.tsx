import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Empty, Notice } from '@/components/ui'
import { errorMessage, get } from '@/lib/api'
import type { HotTrend } from '@/lib/types'

export function Trends({accountId}:{accountId:string}){
 const q=useQuery({queryKey:['hot-trends',accountId],queryFn:()=>get<HotTrend[]>(`/accounts/${accountId}/hot/trends`)})
 if(q.isError)return <Notice tone="red">{errorMessage(q.error)}</Notice>
 if(!q.data?.length)return <Empty title="暂无近 7 天趋势" desc="持续采集和账号匹配后会积累排名历史。"/>
 return <div className="space-y-4">{q.data.map(x=>{const sources=[...new Set(x.points.map(p=>p.source))];const times=x.points.map(p=>new Date(p.at).getTime());const first=Math.min(...times),last=Math.max(...times),rank=Math.max(1,...x.points.map(p=>p.rank));const colors=['#41695b','#d99024','#577fa2','#956bb1'];return <div key={x.id} className="rounded-lg border border-mist-200 p-4 space-y-2"><h4 className="font-semibold">{x.title}</h4><p className="text-xs text-mist-500">首次 {new Date(x.first_seen_at).toLocaleString('zh-CN')} · 最近 {new Date(x.last_seen_at).toLocaleString('zh-CN')} · 在榜 {Math.max(0,Math.round((new Date(x.last_seen_at).getTime()-new Date(x.first_seen_at).getTime())/3600000))} 小时</p><div className="flex gap-3 flex-wrap">{x.sources.map((s,i)=><a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-xs text-ink-600">{s.name} · 第 {s.rank} 名</a>)}</div>{x.points.length>0&&<><svg viewBox="0 0 320 100" role="img" aria-label="排名曲线，越接近顶部排名越高" className="w-full max-w-lg h-32"><line x1="10" y1="90" x2="310" y2="90" stroke="#ddd"/>{sources.map((s,i)=><polyline key={s} fill="none" stroke={colors[i%colors.length]} strokeWidth="2" points={x.points.filter(p=>p.source===s).map(p=>`${10+300*(new Date(p.at).getTime()-first)/Math.max(1,last-first)},${10+80*p.rank/rank}`).join(' ')}/>)}</svg><p className="text-xs text-mist-500">{sources.join(' · ')}；纵轴为排名，越靠上排名越高。</p></>}{x.writing.length?x.writing.map(w=><Link key={w.work_id} className="block text-sm text-gamboge-700" to={`/works/${w.work_id}`}>{w.account} 已在写：《{w.title}》</Link>):<p className="text-xs text-mist-500">本工作区其他账号尚未在写这个话题。</p>}</div>})}</div>
}
