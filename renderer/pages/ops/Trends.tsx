import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Empty, Notice } from '@/components/ui'
import { TrendRankChart } from '@/components/trend-rank-chart'
import { errorMessage, get, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import type { ContentFormat, HotTrend, Platform, Topic } from '@/lib/types'

export function Trends({ accountId, platform, contentFormat }: {
  accountId: string
  platform: Platform
  contentFormat: ContentFormat
}) {
  const client = useQueryClient()
  const canWrite = useCanWrite()
  const [busyID, setBusyID] = useState('')
  const [created, setCreated] = useState<Record<string, string>>({})
  const q = useQuery({
    queryKey: ['hot-trends', accountId],
    queryFn: () => get<HotTrend[]>(`/accounts/${accountId}/hot/trends`),
  })
  const convert = async (trend: HotTrend) => {
    setBusyID(trend.id)
    try {
      // OP-07：趋势条目本身没有 hot_match id，因此逐条创建带来源标记的选题并给出直达链接。
      const result = await post<{ topic: Topic }>(`/accounts/${accountId}/topics`, {
        title: trend.title,
        angle: '',
        source: 'hot',
        ...(platform === 'toutiao' ? { format: contentFormat } : {}),
      })
      setCreated((items) => ({ ...items, [trend.id]: result.topic.id }))
      await client.invalidateQueries({ queryKey: ['topics', accountId] })
      toast.success('已加入选题池')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusyID('')
    }
  }
  if (q.isError) return <Notice tone="red">{errorMessage(q.error)}</Notice>
  if (!q.data?.length) return <Empty title="暂无近 7 天趋势" desc="持续采集和账号匹配后会积累排名历史。" />
  return <div className="space-y-4">{q.data.map((trend) => {
    const topicID = created[trend.id]
    return <div key={trend.id} className="space-y-2 rounded-lg border border-mist-200 p-4">
      <h4 className="font-semibold">{trend.title}</h4>
      <p className="text-xs text-mist-500">首次 {new Date(trend.first_seen_at).toLocaleString('zh-CN')} · 最近 {new Date(trend.last_seen_at).toLocaleString('zh-CN')} · 在榜 {Math.max(0, Math.round((new Date(trend.last_seen_at).getTime() - new Date(trend.first_seen_at).getTime()) / 3_600_000))} 小时</p>
      <div className="flex flex-wrap gap-3">{trend.sources.map((source, index) => <a key={`${source.name}-${index}`} href={source.url} target="_blank" rel="noreferrer" className="text-xs text-ink-600">{source.name} · 第 {source.rank} 名</a>)}</div>
      {trend.points.length > 0 && <TrendRankChart title={trend.title} points={trend.points} />}
      {trend.writing.length ? trend.writing.map((work) => <Link key={work.work_id} className="block text-sm text-gamboge-700" to={`/works/${work.work_id}`}>{work.account} 已在写：《{work.title}》</Link>) : <p className="text-xs text-mist-500">本工作区其他账号尚未在写这个话题。</p>}
      {topicID ? <Link className="text-sm font-medium text-ink-700 underline" to={`/a/${accountId}/topics?focus=${topicID}`}>查看刚创建的选题</Link>
        : canWrite && <Button size="sm" variant="secondary" loading={busyID === trend.id} disabled={!!busyID} onClick={() => void convert(trend)}>转为选题</Button>}
    </div>
  })}</div>
}
