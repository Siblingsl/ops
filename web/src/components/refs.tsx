import { BookOpenCheck, ChevronDown, ChevronRight, RotateCcw, ThumbsDown, ThumbsUp, Timer } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorMessage, patch, post } from '@/lib/api'
import { type AIRefs, describeRefs } from '@/lib/format'
import { cn } from './ui'

const reasonTags = ['太长', '太短', '跑题', '语气不对', '编造内容', '其他'] as const

/** sendFeedback records an explicit or implicit outcome for one AI call (3.3). Failures are silent. */
export function sendFeedback(callId: string | null | undefined, body: Record<string, unknown>) {
  if (!callId) return
  post(`/ai-calls/${callId}/feedback`, body).catch(() => undefined)
}

export function AIFeedback({ callId, className }: { callId?: string | null; className?: string }) {
  const [rating, setRating] = useState<0 | 1 | -1>(0)
  const [tags, setTags] = useState<string[]>([])
  if (!callId) return null
  const rate = (v: 1 | -1) => {
    const next = rating === v ? 0 : v
    setRating(next)
    if (next === 1) setTags([])
    sendFeedback(callId, { rating: next })
    if (next === 1) toast.success('收到，AI 会参考你的评价', { duration: 1500 })
  }
  const toggleTag = (t: string) => {
    const next = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]
    setTags(next)
    sendFeedback(callId, { rating: -1, reason_tags: next })
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      <button type="button" title="有帮助" onClick={() => rate(1)}
        className={cn('cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-ink-600', rating === 1 && 'bg-ink-50 text-ink-600')}>
        <ThumbsUp className="size-3.5" />
      </button>
      <button type="button" title="不满意" onClick={() => rate(-1)}
        className={cn('cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-orange-600', rating === -1 && 'bg-orange-50 text-orange-600')}>
        <ThumbsDown className="size-3.5" />
      </button>
      {rating === -1 && reasonTags.map((t) => (
        <button key={t} type="button" onClick={() => toggleTag(t)}
          className={cn('cursor-pointer rounded-full border px-2 py-0.5 text-[11px]', tags.includes(t) ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-mist-200 text-mist-500 hover:border-mist-300')}>
          {t}
        </button>
      ))}
    </div>
  )
}

/** disableMemory stops one AI memory straight from the refs panel (3.5), with a 10-second undo. */
async function disableMemory(id: string) {
  try {
    await patch(`/memories/${id}`, { status: 'disabled' })
    toast('已停用这条记忆，之后的生成不会再用它', {
      description: '可以在账号档案的「AI 写作记忆」里重新启用。',
      duration: 10_000,
      action: { label: '撤销', onClick: () => void patch(`/memories/${id}`, { status: 'active' }).catch((e) => toast.error(errorMessage(e))) },
    })
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

/** RefsNote is the expandable 「本次参考」 panel (DEV-V301): what went into the prompt, per slot; plus 👍👎, retry and cost on hover (9.2). */
export function RefsNote({ refs, className, callId, onRetry }: { refs?: AIRefs | null; className?: string; callId?: string | null; onRetry?: () => void }) {
  const [open, setOpen] = useState(false)
  const text = describeRefs(refs)
  if (!text && !callId) return null
  const slots = (refs?.slots ?? []).filter((s) => s.chars > 0 || (s.items?.length ?? 0) > 0)
  const cost = refs?.latency_ms != null ? `耗时 ${(refs.latency_ms / 1000).toFixed(1)} 秒${refs.tokens ? ` · ${refs.tokens} token` : ''}` : ''
  return (
    <div className={cn('text-xs leading-5 text-mist-400', className)}>
      <div className="flex flex-wrap items-start gap-1.5">
        <BookOpenCheck className="mt-0.5 size-3.5 shrink-0" />
        {slots.length > 0 ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex cursor-pointer items-start gap-0.5 text-left hover:text-mist-600">
            <span>{text || '本次参考'}</span>
            {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
          </button>
        ) : <span>{text}</span>}
        {refs?.fallback_used && <span className="rounded bg-gamboge-50 px-1.5 text-gamboge-700">主模型不可用，已改用备用模型 {refs.fallback_model}</span>}
        <span className="ml-auto flex items-center gap-1">
          {cost && <span title={cost} className="cursor-help rounded p-1 text-mist-300 hover:text-mist-500"><Timer className="size-3.5" /></span>}
          {onRetry && (
            <button type="button" title="重试" onClick={() => { sendFeedback(callId, { outcome: 'regenerated' }); onRetry() }}
              className="cursor-pointer rounded p-1 text-mist-400 hover:bg-mist-100 hover:text-ink-600">
              <RotateCcw className="size-3.5" />
            </button>
          )}
          <AIFeedback callId={callId} />
        </span>
      </div>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-mist-100 bg-white p-2 text-mist-500">
          {refs?.user_instruction && <div>临时指令：「{refs.user_instruction}」</div>}
          {slots.map((s) => (
            <div key={s.name}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-mist-600">{s.label || s.name}</span>
                <span className="tabular-nums">{s.chars} 字{s.budget ? ` / 预算 ${s.budget}` : ''}</span>
                {s.truncated && <span className="text-gamboge-600">超出预算，部分未带入</span>}
              </div>
              {s.items && s.items.length > 0 && (
                <ul className="ml-3 mt-0.5 space-y-0.5">
                  {s.items.map((it, i) => (
                    <li key={it.id ?? i} className={cn('group/item', !it.used && 'text-mist-300 line-through')}>
                      {it.label}
                      {!it.used && '（因长度限制未使用）'}
                      {s.name === 'memory' && it.used && it.id && (
                        <button type="button" onClick={() => disableMemory(it.id!)}
                          className="ml-1.5 cursor-pointer text-[11px] text-mist-400 underline-offset-2 hover:text-orange-600 hover:underline">
                          这条这次不该用
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
