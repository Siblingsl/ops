import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { Card, CardHeader, cn, Empty, Input, PageHeader, PageLoading, Tabs } from '@/components/ui'
import { get } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import type { AILimit } from '@/lib/types'

interface Row { key: string; calls: number; prompt_tokens: number; completion_tokens: number; failed: number }
interface UsageResp { group_by: string; from: string; to: string; rows: Row[]; total: Row; today_tokens: number; limit: AILimit }

const day = (d: Date) => d.toISOString().slice(0, 10)

export default function Usage() {
  const [group, setGroup] = useState<'day' | 'task' | 'model' | 'account'>('day')
  const [from, setFrom] = useState(day(new Date(Date.now() - 29 * 86400_000)))
  const [to, setTo] = useState(day(new Date()))
  const { data, isLoading } = useQuery({ queryKey: ['usage', group, from, to], queryFn: () => get<UsageResp>(`/usage?group_by=${group}&from=${from}&to=${to}`) })
  if (isLoading || !data) return <PageLoading />
  const max = Math.max(1, ...data.rows.map((r) => r.prompt_tokens + r.completion_tokens))
  const pct = data.limit.enabled ? Math.min(100, (data.today_tokens / data.limit.daily_tokens) * 100) : 0
  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader title="AI 用量" desc="按 token 统计，不换算金额。" />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <div className="text-xs text-mist-500">今日用量</div>
          <div className="mt-1 font-display text-[28px] font-bold tabular-nums text-mist-900">{fmtNum(data.today_tokens)}</div>
          {data.limit.enabled ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-mist-100"><div className={cn('h-full rounded-full', pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-gamboge-400' : 'bg-ink-500')} style={{ width: `${pct}%` }} /></div>
              <div className="mt-1.5 text-xs text-mist-500">上限 {fmtNum(data.limit.daily_tokens)} token</div>
            </>
          ) : <div className="mt-2 text-xs text-mist-400">未设上限 · <Link to="/settings/models" className="text-ink-600 underline">设置</Link></div>}
        </Card>
        <Card className="p-5">
          <div className="text-xs text-mist-500">区间合计</div>
          <div className="mt-1 font-display text-[28px] font-bold tabular-nums text-mist-900">{fmtNum(data.total.prompt_tokens + data.total.completion_tokens)}</div>
          <div className="mt-2 text-xs text-mist-500">输入 {fmtNum(data.total.prompt_tokens)} · 输出 {fmtNum(data.total.completion_tokens)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs text-mist-500">调用次数</div>
          <div className="mt-1 font-display text-[28px] font-bold tabular-nums text-mist-900">{fmtNum(data.total.calls)}</div>
          <div className="mt-2 text-xs text-mist-500">失败 {data.total.failed} 次</div>
        </Card>
      </div>
      <Card>
        <CardHeader title={<Tabs value={group} onChange={setGroup} items={[{ value: 'day', label: '按天' }, { value: 'task', label: '按任务' }, { value: 'model', label: '按模型' }, { value: 'account', label: '按账号' }]} />}
          action={<div className="flex items-center gap-2 text-[13px] text-mist-500">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-[13px]" />至
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-[13px]" />
          </div>} />
        {data.rows.length === 0 ? <Empty title="这段时间没有 AI 调用" /> : (
          <table className="w-full text-[13.5px]">
            <thead><tr className="border-b border-mist-100 text-left text-xs text-mist-400">
              <th className="py-2.5 pl-5 font-medium">{{ day: '日期', task: '任务', model: '模型', account: '账号' }[group]}</th>
              <th className="w-2/5 py-2.5 font-medium" />
              <th className="py-2.5 text-right font-medium">调用</th>
              <th className="py-2.5 text-right font-medium">输入</th>
              <th className="py-2.5 text-right font-medium">输出</th>
              <th className="py-2.5 pr-5 text-right font-medium">失败</th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-b border-mist-50">
                  <td className="py-2.5 pl-5 text-mist-800">{r.key}</td>
                  <td className="py-2.5 pr-4"><div className="h-2 rounded-full bg-ink-400/80" style={{ width: `${((r.prompt_tokens + r.completion_tokens) / max) * 100}%` }} /></td>
                  <td className="py-2.5 text-right tabular-nums">{r.calls}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-600">{fmtNum(r.prompt_tokens)}</td>
                  <td className="py-2.5 text-right tabular-nums text-mist-600">{fmtNum(r.completion_tokens)}</td>
                  <td className={cn('py-2.5 pr-5 text-right tabular-nums', r.failed ? 'text-danger' : 'text-mist-400')}>{r.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
