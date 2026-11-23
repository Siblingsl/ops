import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, cn } from '@/components/ui'
import { get } from '@/lib/api'
import { fmtNum, fmtTime } from '@/lib/format'
import type { PeerCompareCard, PeerCompareMetricRow } from '@/lib/types'

// REF41 I5：作品复盘顶部的同龄对比卡。只读展示，不写作品状态。
const nodes = [1, 3, 7, 30] as const
type PeerNode = (typeof nodes)[number]

function formatMetric(row: PeerCompareMetricRow, value: number | null) {
  if (value == null) return '未采集'
  return row.unit === 'percent' ? `${value.toFixed(1)}%` : fmtNum(value)
}

function PeerMetricTable({ card }: { card: PeerCompareCard }) {
  return (
    <div className="overflow-hidden rounded-lg border border-mist-200">
      <div className="grid grid-cols-[72px_1fr_1fr_1fr_44px] gap-2 border-b border-mist-100 bg-mist-50 px-3 py-2 text-[11.5px] font-medium text-mist-500">
        <span>指标</span><span>本篇</span><span>同批中位数</span><span>对比</span><span className="text-right">样本</span>
      </div>
      {card.metrics.map((row) => (
        <div key={row.key} data-testid={`review-peer-metric-${row.key}`} className="grid grid-cols-[72px_1fr_1fr_1fr_44px] items-start gap-2 border-b border-mist-100 px-3 py-2 text-[12px] last:border-b-0">
          <span className="text-mist-500">{row.label}</span>
          <span data-testid={`review-peer-current-${row.key}`} className={cn('font-semibold tabular-nums', row.current == null ? 'text-mist-400' : 'text-mist-800')}>{formatMetric(row, row.current)}</span>
          <span data-testid={`review-peer-median-${row.key}`} className={cn('tabular-nums', row.median == null ? 'text-mist-400' : 'text-mist-700')}>{formatMetric(row, row.median)}</span>
          <span className={cn('text-[11.5px]', row.compare_label.includes('样本不足') ? 'text-amber-700' : row.compare_label === '与中位数持平' ? 'text-mist-500' : 'text-ink-700')}>{row.compare_label}</span>
          <span className="text-right text-[11.5px] tabular-nums text-mist-400">{row.sample_size}</span>
        </div>
      ))}
    </div>
  )
}

export function ReviewPeerCompare({ workId }: { workId: string }) {
  const [node, setNode] = useState<PeerNode>(7)
  const [showPeers, setShowPeers] = useState(false)
  const { data, isError, refetch } = useQuery({
    queryKey: ['peer-compare', workId, node],
    queryFn: () => get<PeerCompareCard>(`/works/${workId}/peer-compare?node=${node}`),
  })

  return (
    <section data-testid="review-peer-card" className="rounded-xl border border-mist-200 bg-white p-3.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-mist-900">同龄对比</h3>
            <span className="text-[11.5px] text-mist-400">同账号 · 同平台 · 同内容形态</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-mist-400">本篇与更早发布、同一节点有数据的作品比，不预测、不改作品状态。</p>
        </div>
        <div className="flex rounded-lg border border-mist-200 p-0.5" role="tablist" aria-label="同龄对比节点">
          {nodes.map((item) => (
            <button
              key={item}
              type="button"
              data-testid={`review-peer-node-${item}`}
              role="tab"
              aria-selected={node === item}
              onClick={() => { setNode(item); setShowPeers(false) }}
              className={cn('rounded-md px-2 py-1 text-[11.5px] transition', node === item ? 'bg-ink-600 text-white' : 'text-mist-500 hover:text-mist-800')}
            >
              {item} 天
            </button>
          ))}
        </div>
      </div>

      {isError ? (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <span>同龄对比加载失败。</span>
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>重试</Button>
        </div>
      ) : !data ? (
        <div className="mt-3 h-20 animate-pulse rounded-lg bg-mist-50" aria-label="同龄对比加载中" />
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="ink">第 {data.node} 天</Badge>
            {!data.node_exact && <Badge tone="gamboge">非精确节点</Badge>}
            {data.sample_sufficient
              ? <Badge tone="green">样本 {data.sample_size} 篇</Badge>
              : <span data-testid="review-peer-insufficient"><Badge tone="gamboge">样本不足，仅供参考</Badge></span>}
            {data.published_at && <span className="text-[11px] text-mist-400">发布于 {fmtTime(data.published_at)}</span>}
            {data.account_name && <span className="text-[11px] text-mist-400">{data.account_name}</span>}
          </div>
          {data.notice && <p data-testid="review-peer-notice" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800">{data.notice}</p>}
          <div className="mt-2"><PeerMetricTable card={data} /></div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              data-testid="review-peer-peers-toggle"
              className="inline-flex items-center gap-1 text-[11.5px] text-ink-700 hover:underline"
              onClick={() => setShowPeers((old) => !old)}
            >
              {showPeers ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              查看同批作品（{(data.peers ?? []).length}）
            </button>
            <span className="text-[11px] text-mist-400">中位数去掉缺失值；缺失不按 0 算</span>
          </div>
          {showPeers && (
            <div data-testid="review-peer-peers" className="mt-2 divide-y divide-mist-100 rounded-lg border border-mist-100">
              {(data.peers ?? []).length === 0
                ? <p className="px-3 py-2 text-[11.5px] text-mist-400">暂无同节点的更早作品。</p>
                : (data.peers ?? []).map((peer) => (
                  <div key={peer.work_id} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[12px] font-medium text-mist-800">{peer.title || '未命名'}</span>
                      <span className="text-[11px] text-mist-400">{fmtTime(peer.published_at)}</span>
                      {!peer.node_exact && peer.actual_day != null && <span className="text-[10.5px] text-amber-700">取第 {peer.actual_day} 天记录</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-mist-500">
                      {data.metrics.map((row) => (
                        <span key={row.key}>{row.label} {formatMetric(row, peer.values[row.key] ?? null)}</span>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
          <p className="mt-2 truncate text-[10.5px] text-mist-400" title={data.limitations.join(' ')}>{data.limitations[0]}</p>
        </>
      )}
    </section>
  )
}
