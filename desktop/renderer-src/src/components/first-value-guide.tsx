import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Notice, Spinner } from './ui'
import { errorMessage, get, post } from '@/lib/api'
import { useInvalidate } from '@/lib/session'
import type { DailyResult, StrategyResult } from '@/lib/types'

export function FirstValueGuide({ accountId, modelReady, profileReady, hasWork }: { accountId: string; modelReady: boolean; profileReady: boolean; hasWork: boolean }) {
  const inv = useInvalidate()
  const [skipped, setSkipped] = useState(false)
  const [busy, setBusy] = useState(false)
  const strategy = useQuery({ queryKey: ['strategy', accountId], queryFn: () => get<StrategyResult>(`/accounts/${accountId}/strategy`) })
  const daily = useQuery({ queryKey: ['daily', accountId, 'preview'], queryFn: () => get<DailyResult>(`/accounts/${accountId}/daily?prepare=false`), refetchInterval: q => q.state.data?.preparing ? 2000 : false })
  if (daily.data?.recommendation) return null
  // NW-B5：引导的终点是"写出第一篇作品"，不是生成推荐。推荐只是之后的一步。
  const steps = [
    { title: '配置模型', time: '约 1 分钟', done: modelReady, to: '/settings/models', action: '去配置模型' },
    { title: '粘贴 1 篇旧作品建档', time: '约 2 分钟 · 可跳过', done: profileReady || skipped, to: `/a/${accountId}/profile?wizard=1`, action: '去粘贴建档' },
    { title: '写下第一篇作品', time: '约 3 分钟', done: hasWork, to: `/a/${accountId}/works`, action: '新建作品' },
    { title: '起号向导启用方案', time: '约 4 分钟', done: !!strategy.data?.active, to: `/a/${accountId}/ops#strategy`, action: '去启用方案' },
    { title: '生成今日推荐', time: '约 1 分钟', done: false, to: '', action: '生成第一条推荐' },
  ]
  const active = steps.findIndex(s => !s.done)
  const generate = async () => {
    setBusy(true)
    try {
      await post(`/accounts/${accountId}/daily/regenerate`)
      await inv(['daily', accountId], ['next-actions', accountId], ['dashboard', accountId])
      toast.success('今日推荐已生成，请逐条选择')
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <section aria-label="首次推荐路径" className="mb-6"><Card>
    <CardHeader title="从第一篇作品开始" desc="按依赖走五步，预计约 11 分钟。风格样本和素材可以之后补充。" />
    <div className="space-y-3 p-5">
      {strategy.isError && <Notice tone="red">{errorMessage(strategy.error)}<Button size="sm" onClick={() => strategy.refetch()}>重试</Button></Notice>}
      {strategy.isPending ? <Spinner /> : <ol className="space-y-3">{steps.map((s, i) => <li key={s.title} className="flex flex-wrap items-center gap-3 rounded-lg border border-mist-100 p-3">
        <Badge tone={s.done ? 'green' : i === active ? 'ink' : 'gray'}>{s.done ? '已完成' : `第 ${i + 1} 步`}</Badge>
        <div className="flex-1"><p className="text-sm font-medium">{s.title}</p><p className="text-xs text-mist-500">{s.time}</p></div>
        {i === active && (s.to ? <Link to={s.to}><Button size="sm">{s.action}</Button></Link> : <Button size="sm" variant="primary" loading={busy} disabled={daily.data?.preparing} onClick={generate}>{daily.data?.preparing ? '正在准备推荐' : s.action}</Button>)}
        {i === 1 && i === active && <Button size="sm" variant="ghost" onClick={() => setSkipped(true)}>跳过建档</Button>}
      </li>)}</ol>}
    </div>
  </Card></section>
}
