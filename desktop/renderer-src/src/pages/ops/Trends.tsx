import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Empty, Notice } from '@/components/ui'
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
    const sources = [...new Set(trend.points.map((point) => point.source))]
    const times = trend.points.map((point) => new Date(point.at).getTime())
    const first = Math.min(...times)
    const last = Math.max(...times)
    const rank = Math.max(1, ...trend.points.map((point) => point.rank))
    const colors = ['#41695b', '#d99024', '#577fa2', '#956bb1']
    const topicID = created[trend.id]
    return <div key={trend.id} className="space-y-2 rounded-lg border border-mist-200 p-4">
      <h4 className="font-semibold">{trend.title}</h4>
      <p className="text-xs text-mist-500">首次 {new Date(trend.first_seen_at).toLocaleString('zh-CN')} · 最近 {new Date(trend.last_seen_at).toLocaleString('zh-CN')} · 在榜 {Math.max(0, Math.round((new Date(trend.last_seen_at).getTime() - new Date(trend.first_seen_at).getTime()) / 3_600_000))} 小时</p>
      <div className="flex flex-wrap gap-3">{trend.sources.map((source, index) => <a key={`${source.name}-${index}`} href={source.url} target="_blank" rel="noreferrer" className="text-xs text-ink-600">{source.name} · 第 {source.rank} 名</a>)}</div>
      {trend.points.length > 0 && <>
        <svg viewBox="0 0 320 100" role="img" aria-label="排名曲线，越接近顶部排名越高" className="h-32 w-full max-w-lg">
          <line x1="10" y1="90" x2="310" y2="90" stroke="#ddd" />
          {sources.map((source, index) => <polyline key={source} fill="none" stroke={colors[index % colors.length]} strokeWidth="2"
            points={trend.points.filter((point) => point.source === source).map((point) => `${10 + 300 * (new Date(point.at).getTime() - first) / Math.max(1, last - first)},${10 + 80 * point.rank / rank}`).join(' ')} />)}
        </svg>
        <p className="text-xs text-mist-500">{sources.join(' · ')}；纵轴为排名，越靠上排名越高。</p>
      </>}
      {trend.writing.length ? trend.writing.map((work) => <Link key={work.work_id} className="block text-sm text-gamboge-700" to={`/works/${work.work_id}`}>{work.account} 已在写：《{work.title}》</Link>) : <p className="text-xs text-mist-500">本工作区其他账号尚未在写这个话题。</p>}
      {topicID ? <Link className="text-sm font-medium text-ink-700 underline" to={`/a/${accountId}/topics?focus=${topicID}`}>查看刚创建的选题</Link>
        : canWrite && <Button size="sm" variant="secondary" loading={busyID === trend.id} disabled={!!busyID} onClick={() => void convert(trend)}>转为选题</Button>}
    </div>
  })}</div>
}
