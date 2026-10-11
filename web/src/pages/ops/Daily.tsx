import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Field, formatLabel, HumanGate, Input, Notice, Textarea } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { useInvalidate, useMe } from '@/lib/session'
import type { DailyResult, DailyItem, StrategyResult } from '@/lib/types'

export function DailyPanel({ accountId, compact=false }: { accountId:string;compact?:boolean }){
 const {data:me}=useMe();const edit=me?.role!=='viewer';const inv=useInvalidate();const nav=useNavigate()
 const q=useQuery({queryKey:['daily',accountId],queryFn:()=>get<DailyResult>(`/accounts/${accountId}/daily`),refetchInterval:q=>q.state.data?.preparing?2000:false})
 const strategy=useQuery({queryKey:['strategy',accountId],queryFn:()=>get<StrategyResult>(`/accounts/${accountId}/strategy`)})
 const [busy,setBusy]=useState(false);const [chosen,setChosen]=useState<{idx:number;item:DailyItem;start:boolean}|null>(null);const [planned,setPlanned]=useState(false)
 const refresh=async()=>{setBusy(true);try{await post(`/accounts/${accountId}/daily/regenerate`);await inv(['daily',accountId],['daily-stats',accountId],['next-actions',accountId],['dashboard',accountId]);toast.success('今日推荐已生成')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}
 const action=async(idx:number,action:string,body?:unknown)=>{if(!q.data?.recommendation)return;setBusy(true);try{const r=await post<{work_id:string|null}>(`/daily/${q.data.recommendation.id}/items/${idx}/${action}`,body);await inv(['daily',accountId],['topics',accountId],['calendar'],['works',accountId],['daily-stats',accountId],['next-actions',accountId],['dashboard',accountId]);setChosen(null);if(r.work_id)nav(`/works/${r.work_id}`);else toast.success('已处理这条推荐')}catch(e){toast.error(errorMessage(e))}finally{setBusy(false)}}
 return <Card><CardHeader title="今日推荐" desc={q.data?.recommendation?`生成于 ${new Date(q.data.recommendation.generated_at).toLocaleString('zh-CN')}`:'结合方案、计划、热点与真实素材，逐条选择今天写什么。'} action={edit&&<Button size="sm" loading={busy} disabled={q.data?.preparing||!strategy.data?.active} onClick={refresh}>{q.data?.recommendation?'重新生成（每日最多 3 次）':'生成今日推荐'}</Button>}/><div className="space-y-4 p-5">
 {q.isError?<Notice tone="red">{errorMessage(q.error)}</Notice>:q.data?.preparing?<Notice>正在准备今日推荐，可稍后查看。</Notice>:!q.data?.recommendation?<Empty title="还没有今日推荐" desc="启用运营方案后可生成创作建议，无需先补齐样本或素材。" action={edit&&<Link to={`/a/${accountId}/ops#strategy`}><Button size="sm">去启用运营方案</Button></Link>}/>:<>
 {q.data.new_hot&&<Notice>有新的热点，可重新生成；当前推荐仍保留。</Notice>}
 {q.data.recommendation.items.slice(0,compact?2:10).map((x,idx)=><div key={idx} className="space-y-2 rounded-lg border border-mist-200 p-4"><div className="flex gap-2"><Badge tone={x.primary?'green':'gray'}>{x.primary?'主推':'备选'}</Badge>{x.action&&<Badge>{({adopted:'已采用',started:'已开始写',dismissed:'不感兴趣'})[x.action]}</Badge>}</div><h3 className="font-semibold">{x.title}</h3><p className="text-sm">{x.angle}</p><p className="text-sm text-mist-500">推荐理由：{x.reason}</p><p className="text-sm">读者：{x.audience} · 钩子：{x.hook}</p><p className="text-sm">需要的素材：{x.needed_materials.join('、')||'请补充自己的真实经历'} · 类型：{formatLabel[x.format] ?? x.format}</p><div className="flex flex-wrap gap-2">{x.basis.map((b,i)=>b.url?.startsWith('/')?<Link key={i} className="text-xs text-ink-600 underline" to={b.url}>{({slot:'大纲',pillar:'支柱',hot:'热点',material:'素材',review:'复盘',topic:'选题'})[b.type]}：{b.name||'查看依据'}</Link>:<a key={i} className="text-xs text-ink-600 underline" href={b.url} target="_blank" rel="noreferrer">热点原文</a>)}</div>
 {edit&&!x.action&&<div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={()=>{setChosen({idx,item:{...x},start:false});setPlanned(false)}}>采用为选题</Button><Button size="sm" disabled={busy} onClick={()=>{setChosen({idx,item:{...x},start:true});setPlanned(false)}}>直接开始写</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action(idx,'replace')}>换一个</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action(idx,'dismiss')}>不感兴趣</Button></div>}
 {x.action==='adopted'&&edit&&<Button size="sm" disabled={busy} onClick={()=>action(idx,'start')}>开始写</Button>}{x.work_id&&<Link className="text-sm text-ink-600" to={`/works/${x.work_id}`}>打开作品</Link>}
 {chosen?.idx===idx&&<div className="space-y-3 pt-2"><HumanGate code="H-01">确认这一条选题后再入库；创作观点由你填写。</HumanGate><Field label="标题"><Input value={chosen.item.title} onChange={e=>setChosen({...chosen,item:{...chosen.item,title:e.target.value}})}/></Field><Field label="切入角度（不会填入观点框）"><Textarea value={chosen.item.angle} onChange={e=>setChosen({...chosen,item:{...chosen.item,angle:e.target.value}})}/></Field><label className="flex gap-2 text-sm"><input type="checkbox" checked={planned} onChange={e=>setPlanned(e.target.checked)}/>计划日设为今天</label><Button loading={busy} onClick={()=>action(idx,chosen.start?'start':'adopt',{title:chosen.item.title,angle:chosen.item.angle,planned_today:planned})}>确认这一条{chosen.start?'并开始写':''}</Button><Button onClick={()=>setChosen(null)}>取消</Button></div>}
 </div>)}
 </>}{compact&&<Link className="text-sm text-ink-600" to={`/a/${accountId}/ops`}>查看全部今日推荐</Link>}
 </div></Card>
}
