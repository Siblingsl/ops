import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, CircleAlert, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, errorMessage, get } from '@/lib/api'
import { DESKTOP_ACCOUNT_SWITCHER_REQUEST } from '@/lib/desktop-settings'
import { visibleTodayOpsItems } from '@/lib/today-ops.js'
import { Button, IconButton } from '@/components/ui'
import { StateBlock } from '@/pages/agent/StateBlock'

export type TodayOpsItem = {
  id: string
  kind: string
  title: string
  detail: string
  meta: string
  tone: string
  to: string
}

export type TodayOpsBlock = {
  key: string
  label: string
  count: number
  count_label: string
  items: TodayOpsItem[]
  more?: { label: string; to: string }
  error?: string
}

export type TodayOpsView = {
  account: { id: string; name: string; platform: string }
  generated_at: string
  summary: { pending: number; publishing: number; today_data: number; comments: number; routines: number; risks: number }
  blocks: TodayOpsBlock[]
}

const EMPTY_COPY: Record<string, { title: string; desc: string }> = {
  pending: { title: '今天没有待处理卡片', desc: '有新任务时，智能体会把写入拆成单张卡片放在这里。' },
  publishing: { title: '没有待发布的批次', desc: '作品完成检查后，可逐条创建发布任务。' },
  today: { title: '今天还没有可信数据', desc: '回填平台数据后，这里只显示已确认口径的今日数据。' },
  comments: { title: '没有待回复评论', desc: '导入评论后，未回复的条目会出现在这里。' },
  routines: { title: '今天没有到点的例行任务', desc: '例行任务到点后才会进入今日摘要，不会在这里自动执行。' },
  risks: { title: '没有失败或掉线任务', desc: '发布任务失败或平台连接掉线时会在这里提醒。' },
}

function toneClass(tone: string) {
  if (tone === 'danger') return 'is-danger'
  if (tone === 'attention') return 'is-attention'
  if (tone === 'success') return 'is-success'
  return 'is-neutral'
}

export function TodayOpsPanel({ accountID, onClose }: { accountID: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['agent-today-ops', accountID],
    queryFn: () => get<TodayOpsView>(`/agent/today-ops?account_id=${encodeURIComponent(accountID)}`),
    enabled: !!accountID,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })

  const retryBlock = async (key: string) => {
    const single = await get<TodayOpsView>(
      `/agent/today-ops?account_id=${encodeURIComponent(accountID)}&block=${encodeURIComponent(key)}`,
    )
    const block = single.blocks.find((item) => item.key === key)
    if (!block) throw new Error('该区块没有返回内容')
    const summaryKey = (key === 'today' ? 'today_data' : key) as keyof TodayOpsView['summary']
    queryClient.setQueryData<TodayOpsView>(['agent-today-ops', accountID], (old) => {
      if (!old) return single
      return {
        ...old,
        generated_at: single.generated_at,
        blocks: old.blocks.map((item) => (item.key === key ? block : item)),
        summary: { ...old.summary, [summaryKey]: single.summary[summaryKey] ?? block.count },
      }
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const data = query.data
  const forbidden = query.error instanceof ApiError && query.error.status === 403
  const missingAccount = query.error instanceof ApiError && query.error.status === 422

  return <section className="desktop-agent-today-ops" role="dialog" aria-modal="true" aria-label="今日运营" data-testid="today-ops-panel">
    <header className="desktop-agent-today-ops-header">
      <div>
        <div className="desktop-agent-today-ops-kicker">TODAY / READ ONLY</div>
        <h2>今日运营</h2>
        <p>{data ? `${data.account.name} · 只读汇总，不会改动任何数据` : '六块只读运营摘要，处理仍需回到原页面逐条完成'}</p>
      </div>
      <IconButton label="关闭今日运营" onClick={onClose}><X className="size-5" /></IconButton>
    </header>

    {!accountID ? <div className="desktop-agent-today-ops-state">
      <StateBlock tone="empty" title="当前没有可用账号" desc="今日运营按账号隔离。请先在账号选择器中选择一个有效账号。"
        action={<Button size="sm" onClick={() => window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST))}>打开账号选择器</Button>} />
    </div> : query.isLoading ? <div className="desktop-agent-today-ops-state"><StateBlock tone="loading" title="正在汇总今日运营…" /></div>
      : query.isError ? <div className="desktop-agent-today-ops-state">
        <StateBlock tone="error"
          title={forbidden ? '今日运营需要编辑权限' : missingAccount ? '该账号不属于当前工作区' : '今日运营加载失败'}
          desc={forbidden ? '观察者可以继续浏览原有页面，但不能打开运营驾驶舱。请联系工作区所有者调整权限。' : errorMessage(query.error)}
          action={<div className="flex gap-2">
            {!forbidden && <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => void query.refetch()}>重试</Button>}
            <Button size="sm" variant="ghost" onClick={onClose}>返回对话</Button>
          </div>} />
      </div>
        : !data ? <div className="desktop-agent-today-ops-state"><StateBlock tone="empty" title="今日运营没有返回内容" desc="请稍后重试；已完成的对话与原有页面不受影响。" action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>重新加载</Button>} /></div>
          : <>
            <div className="desktop-agent-today-ops-summary" data-testid="today-ops-summary">
              <span>待处理 <strong>{data.summary.pending}</strong></span>
              <span>待发布 <strong>{data.summary.publishing}</strong></span>
              <span>今日数据 <strong>{data.summary.today_data}</strong></span>
              <span>评论 <strong>{data.summary.comments}</strong></span>
              <span>例行 <strong>{data.summary.routines}</strong></span>
              <span className={data.summary.risks > 0 ? 'is-danger' : ''}>风险 <strong>{data.summary.risks}</strong></span>
            </div>
            <div className="desktop-agent-today-ops-grid">
              {data.blocks.map((block) => <TodayOpsBlockCard key={block.key} block={block} onRetry={() => retryBlock(block.key)} onNavigate={onClose} />)}
            </div>
            <footer className="desktop-agent-today-ops-foot">只读聚合 · 逐条处理 · 数据更新时间 {new Date(data.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</footer>
          </>}
  </section>
}

function TodayOpsBlockCard({ block, onRetry, onNavigate }: { block: TodayOpsBlock; onRetry: () => Promise<void>; onNavigate: () => void }) {
  const items = visibleTodayOpsItems(block)
  const empty = EMPTY_COPY[block.key] ?? { title: '今天没有新内容', desc: '有新内容时会出现在这里。' }
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const handleRetry = async () => {
    setRetrying(true)
    setRetryError('')
    try {
      await onRetry()
    } catch (error) {
      setRetryError(errorMessage(error))
    } finally {
      setRetrying(false)
    }
  }
  return <section className="desktop-agent-today-ops-card" data-testid={`today-ops-block-${block.key}`} aria-labelledby={`today-ops-title-${block.key}`}>
    <div className="desktop-agent-today-ops-card-head">
      <h3 id={`today-ops-title-${block.key}`}>{block.label}</h3>
      {block.error ? <span className="is-error">未加载</span> : <span><strong>{block.count}</strong> {block.count_label}</span>}
    </div>
    {block.error ? <div className="desktop-agent-today-ops-block-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><p>“{block.label}”暂时没有加载成功</p><small>{block.error}</small>
        {retryError && <small>{retryError}</small>}
        <button type="button" onClick={() => void handleRetry()} disabled={retrying}>{retrying ? '重试中…' : '重试本块'}</button>
      </div>
    </div> : items.length === 0 ? <div className="desktop-agent-today-ops-empty">
      <p>{empty.title}</p><small>{empty.desc}</small>
    </div> : <ul className="desktop-agent-today-ops-list">
      {items.map((item) => <li key={item.id}>
        <Link to={item.to} onClick={onNavigate} className={`desktop-agent-today-ops-item ${toneClass(item.tone)}`} data-testid="today-ops-item">
          <span className="desktop-agent-today-ops-item-main">
            <span className="desktop-agent-today-ops-item-title">{item.title}</span>
            <span className="desktop-agent-today-ops-item-detail">{item.detail}</span>
            {item.meta && <span className="desktop-agent-today-ops-item-meta">{item.meta}</span>}
          </span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </li>)}
    </ul>}
    {block.more && <Link className="desktop-agent-today-ops-more" to={block.more.to} onClick={onNavigate}>
      {block.more.label}<ArrowUpRight className="size-3.5" aria-hidden="true" />
    </Link>}
  </section>
}
