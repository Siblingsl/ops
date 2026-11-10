import { useEffect, useState } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'

import { errorMessage, get } from '@/lib/api'

// A9（27 §11.1.2）：本会话"实际使用了哪些记忆"。
// 数据来自 GET /agent/conversations/{id}/memory-usage：按 run 汇总注入/省略记录（上限 50）。
// 红线：只展示服务端记录；没有记录就是空态，不推断"大概用了什么"。

interface MemoryUsageItem {
  memory_id: string
  summary: string
  run_id: string
  used: boolean
  omitted_reason?: string
  still_active: boolean
  created_at: string
}

const OMIT_REASONS: Record<string, string> = {
  disabled: '会话已关闭记忆使用',
  not_selected: '未进入本轮候选',
  budget: '超出注入预算',
  duplicate: '与已注入项重复',
  inactive: '记忆已失效',
}

function reasonLabel(reason?: string): string {
  if (!reason) return '未注入'
  return OMIT_REASONS[reason] ?? reason
}

function shortRun(runID: string): string {
  return runID ? runID.slice(0, 8) : '—'
}

export function MemoryUsagePanel({ conversationId, enabled }: { conversationId: string; enabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MemoryUsageItem[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled || !open) return
    let cancelled = false
    setState('loading')
    setError('')
    void get<{ usage: MemoryUsageItem[] }>(`/agent/conversations/${conversationId}/memory-usage`)
      .then((data) => {
        if (cancelled) return
        setItems(Array.isArray(data?.usage) ? data.usage : [])
        setState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(errorMessage(err))
        setState('error')
      })
    return () => { cancelled = true }
  }, [conversationId, enabled, open])

  // 切换会话时收起，避免把上一个会话的记录当成当前会话的。
  useEffect(() => { setOpen(false); setItems([]); setState('idle'); setError('') }, [conversationId])

  if (!enabled) return null

  const used = items.filter((item) => item.used).length
  return <section className="mx-auto mt-2 max-w-3xl px-3" data-testid="memory-usage-panel">
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-lg border border-mist-200 bg-white px-3 py-2 text-left text-[12px] text-mist-600 hover:bg-mist-50"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      <Brain className="size-3.5" />
      <span className="font-medium text-ink-700">记忆使用</span>
      {state === 'ready' && <span className="text-mist-500">本会话注入 {used} 条 · 记录 {items.length} 条</span>}
      {state === 'loading' && <span className="text-mist-500">读取中…</span>}
      {state === 'error' && <span className="text-danger">读取失败</span>}
    </button>
    {open && <div className="mt-1 rounded-lg border border-mist-200 bg-white px-3 py-2">
      {state === 'error' && <p className="text-[12px] text-danger" role="alert">读取记忆使用记录失败：{error}</p>}
      {state === 'ready' && items.length === 0 && <p className="text-[12px] text-mist-500">本会话还没有记忆使用记录；记忆注入后这里会显示每一项的去留原因。</p>}
      {state === 'ready' && items.length > 0 && <ul className="space-y-1.5">
        {items.map((item) => <li key={`${item.run_id}:${item.memory_id}`} className="text-[12px] leading-5">
          <span className={item.used ? 'text-ink-700' : 'text-mist-500'}>{item.summary || '（空记忆）'}</span>
          <span className={`ml-1 rounded px-1 py-0.5 text-[11px] ${item.used ? 'bg-mist-100 text-ink-600' : 'bg-mist-50 text-mist-500'}`}>
            {item.used ? '已注入' : reasonLabel(item.omitted_reason)}
          </span>
          {!item.still_active && <span className="ml-1 text-[11px] text-gamboge-700">记忆已失效</span>}
          <span className="ml-1 text-[11px] text-mist-400">run {shortRun(item.run_id)} · {item.created_at.replace('T', ' ').replace('Z', '')}</span>
        </li>)}
      </ul>}
      {state === 'ready' && <p className="mt-2 text-[11px] text-mist-400">按轮次记录，最多显示最近 50 条；同一轮同一记忆取最新版本。</p>}
    </div>}
  </section>
}
