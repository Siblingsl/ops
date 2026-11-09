import { useEffect, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { errorMessage, get } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { platformErrorCopy } from '@/lib/platform-errors'
import type { PlatformSyncOperation, PlatformSyncOperationItem } from '@/lib/types'
import { Dialog } from './dialog'
import { Badge, Button } from './ui'

const contentStates: Record<string, string> = {
  complete: '正文完整', partial: '正文部分可用', not_requested: '尚未请求正文',
  failed: '正文读取失败', unsupported: '不支持读取正文', denied: '无权读取正文', unknown: '正文状态未知',
}
const metricsStates: Record<string, string> = {
  complete: '已保存指标观测', partial: '指标部分可用', not_started: '尚未读取指标',
  failed: '指标读取失败', unsupported: '不支持读取指标', denied: '无权读取指标',
}

export function PlatformSyncDetails({ accountId, operation, onClose }: {
  accountId: string
  operation: PlatformSyncOperation
  onClose: () => void
}) {
  const [stage, setStage] = useState<'content' | 'metrics'>('content')
  const [state, setState] = useState('')
  const client = useQueryClient()
  const key = ['platform-sync-items', accountId, operation.id]
  const items = useInfiniteQuery({
    queryKey: [...key, stage, state],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: '20', stage })
      if (state) query.set('state', state)
      if (pageParam) query.set('cursor', pageParam)
      return get<{ items: PlatformSyncOperationItem[]; next_cursor: string | null }>(
        `/accounts/${accountId}/platform-sync-operations/${operation.id}/items?${query}`, { signal })
    },
    getNextPageParam: (page) => page.next_cursor || undefined,
    retry: false,
    refetchInterval: ['queued', 'running'].includes(operation.status)
      ? () => document.visibilityState === 'visible' ? 5_000 : 30_000 : false,
  })
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ['platform-sync-items', accountId, operation.id] })
  }, [client, accountId, operation.id, operation.revision, operation.status])
  const rows = [...new Map((items.data?.pages.flatMap((page) => page.items) ?? [])
    .map((item) => [item.platform_work_id, item])).values()]
  const states = stage === 'content' ? contentStates : metricsStates

  return <Dialog open onClose={onClose} title="作品同步明细" width="max-w-3xl"
    desc="展示本次同步关联作品的当前状态；后续同步重新处理的作品可能不再列在这里。指标观测已保存不代表已采用为正式指标。">
    <div className="space-y-4" data-testid="platform-sync-details">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label>查看阶段 <select aria-label="查看同步阶段" value={stage} onChange={(event) => {
          setStage(event.target.value as 'content' | 'metrics')
          setState('')
        }} className="rounded border border-mist-200 bg-white px-2 py-1.5">
          <option value="content">作品正文</option><option value="metrics">初始指标</option>
        </select></label>
        <label>状态 <select aria-label="筛选同步状态" value={state} onChange={(event) => setState(event.target.value)}
          className="rounded border border-mist-200 bg-white px-2 py-1.5">
          <option value="">全部状态</option>
          {Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <Button size="sm" variant="ghost" disabled={items.isFetching} onClick={() => void items.refetch()}>刷新明细</Button>
      </div>
      {items.isError && <div role="alert" className="text-[13px] text-danger">
        <p>同步明细读取失败：{errorMessage(items.error)}</p>
        <Button size="sm" variant="secondary" onClick={() => void (items.isFetchNextPageError ? items.fetchNextPage() : items.refetch())}>重试明细</Button>
      </div>}
      {items.isPending ? <p className="text-[13px] text-mist-500">正在读取同步明细…</p>
        : rows.length === 0 && !items.isError ? <p className="text-[13px] text-mist-500">
          {state ? '当前筛选下没有作品。' : '尚无可展示的作品明细。任务可能仍在身份核对或目录读取阶段；这不代表平台账号没有作品。'}
        </p> : <ul className="max-h-96 space-y-2 overflow-y-auto">
          {rows.map((item) => <li key={item.platform_work_id} className="rounded-lg border border-mist-200 p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="break-words text-mist-900">{item.title || '平台未提供标题'}</strong>
              <Badge tone={item.content_state === 'failed' ? 'red' : 'gray'}>{contentStates[item.content_state] ?? '正文状态未知'}</Badge>
              <Badge tone="gray">{metricsStates[item.initial_metrics_state ?? ''] ?? '指标状态未知'}</Badge>
            </div>
            <p className="mt-1 break-all text-xs text-mist-500">平台编号：{item.external_id}</p>
            <p className="mt-1 text-xs text-mist-500">目录核对于 {fmtTime(item.last_seen_at)}
              {item.content_observed_at ? ` · 正文核对于 ${fmtTime(item.content_observed_at)}` : ''}</p>
            {item.error_code && <p className="mt-1 text-gamboge-700">正文说明：{platformErrorCopy(item.error_code)?.title}
              <span className="ml-1 text-mist-500">错误码：{item.error_code}</span></p>}
          </li>)}
        </ul>}
      {rows.length > 0 && <p className="text-xs text-mist-500">当前筛选已加载 {rows.length} 篇{items.hasNextPage ? '，还有后续明细' : ''}</p>}
      {items.hasNextPage && <Button size="sm" variant="secondary" loading={items.isFetchingNextPage}
        disabled={items.isFetching} onClick={() => void items.fetchNextPage()}>加载更多明细</Button>}
      <Link to={`/a/${accountId}/works?source=platform`} onClick={onClose} className="inline-block text-[13px] text-ink-700 underline">打开平台作品列表</Link>
    </div>
  </Dialog>
}
