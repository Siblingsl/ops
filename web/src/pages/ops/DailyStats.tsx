import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader, Notice } from '@/components/ui'
import { errorMessage, get } from '@/lib/api'
import type { DailyStatsResult } from '@/lib/types'

const labels:Record<string,string>={slot:'大纲',pillar:'支柱',hot:'热点',material:'素材',review:'复盘',topic:'选题池'}
export function DailyStatsCard({accountId,warningsOnly=false}:{accountId:string;warningsOnly?:boolean}){
 const q=useQuery({queryKey:['daily-stats',accountId],queryFn:()=>get<DailyStatsResult>(`/accounts/${accountId}/daily/stats`)})
 if(warningsOnly){const reduced=q.data?.sources.filter(x=>x.reduced)??[];return reduced.length?<Notice tone="gamboge">{reduced.map(x=>labels[x.type]??x.type).join('、')}类推荐连续两周采用率低于 10%，候选权重已减半。可调整方案、关键词或补充真实素材。</Notice>:null}
 return <Card><CardHeader title="近 30 天推荐采用情况" desc="采用率按逐条操作计算；阅读与点赞仅比较已回填为发布的作品，不作因果判断。"/><div className="space-y-4 p-5">{q.isError?<Notice tone="red">{errorMessage(q.error)}</Notice>:q.data&&<><p className="text-sm">推荐 {q.data.total} 条 · 采用 {q.data.adopted} 条 · 采用率 {(q.data.rate*100).toFixed(1)}%</p><div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['来源','推荐','采用','采用率','已发布','平均阅读','平均点赞','权重'].map(x=><th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{q.data.sources.map(x=><tr key={x.type} className="border-t border-mist-100"><td className="p-2">{labels[x.type]??x.type}</td><td>{x.total}</td><td>{x.adopted}</td><td>{(x.rate*100).toFixed(1)}%</td><td>{x.published}</td><td>{x.avg_reads?.toFixed(0)??'暂无数据'}</td><td>{x.avg_likes?.toFixed(0)??'暂无数据'}</td><td>{x.reduced?'连续两周低采用，减半':'常规'}</td></tr>)}</tbody></table></div>{q.data.performance.map(x=><p key={String(x.recommended)} className="text-sm">{x.recommended?'推荐采用后发布':'非推荐作品'}：{x.works} 篇 · 平均阅读 {x.avg_reads?.toFixed(0)??'暂无数据'} · 平均点赞 {x.avg_likes?.toFixed(0)??'暂无数据'}</p>)}{!q.data.total&&<Notice>还没有推荐记录；采用和实际发布后回填数据会显示在这里。</Notice>}</>}</div></Card>
}
