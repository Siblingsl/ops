import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui'
import type { AgentPlan, AgentQuestion } from '@/lib/agent'

type Answer = { question_id: string; choice_id?: string; text?: string; skip?: boolean }

export function AgentPlanCard({ plan, canWrite, busy, blocked, onAccept }: {
  plan: AgentPlan; canWrite: boolean; busy: boolean; blocked: boolean; onAccept: (plan: AgentPlan) => void
}) {
  const states = useMemo(() => new Map(plan.step_states.map((state) => [state.step_id, state])), [plan.step_states])
  return <section aria-label={`计划第 ${plan.version} 版`} className="mt-3 rounded-xl border border-ink-200 bg-ink-50/70 p-3 text-left" data-testid={`agent-plan-${plan.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-[11px] font-semibold text-ink-700">计划 · 第 {plan.version} 版{plan.status === 'superseded' ? ' · 已修订' : plan.accepted_at ? ' · 已接受' : ''}</p>
        <p className="mt-1 text-sm text-ink-900">{plan.summary}</p></div>
      {plan.status === 'current' && !plan.accepted_at && canWrite && <Button size="sm" variant="secondary" disabled={busy || blocked} onClick={() => onAccept(plan)}>按此计划继续</Button>}
    </div>
    <ol className="mt-3 space-y-2">
      {plan.steps.map((step, index) => {
        const state = states.get(step.id)
        const status = state?.status ?? 'pending'
        return <li key={step.id} className="rounded-lg border border-mist-200 bg-white px-3 py-2">
          <div className="flex items-start gap-2"><span className="mt-0.5 text-xs font-semibold text-mist-400">{index + 1}.</span><div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-mist-800"><span>{step.title}</span><span className="rounded-full bg-mist-100 px-2 py-0.5 text-[10px] font-normal text-mist-600">{planStepStatus(status)}</span></div>
            <p className="mt-1 text-xs text-mist-500">验收：{step.acceptance}</p>
            {step.target_ref && <p className="mt-1 text-xs text-mist-500">目标：{step.target_ref}</p>}
            {!!state?.evidence_refs.length && <p className="mt-1 text-[11px] text-mist-500">已关联 {state.evidence_refs.length} 项证据</p>}
          </div></div>
        </li>
      })}
    </ol>
    {plan.status === 'current' && !plan.accepted_at && <div className="mt-2 space-y-1 text-[11px] text-mist-500">
      {blocked && <p>请先回答或替代待办问题。</p>}
      <p>接受计划只启动新的执行运行；任何业务写入仍须逐张审阅操作卡片。</p>
    </div>}
  </section>
}

function planStepStatus(status: string) {
  return ({ pending: '未开始', in_progress: '进行中', waiting_user: '等待你处理', completed: '已完成', failed: '未完成', skipped: '已跳过' } as Record<string, string>)[status] ?? status
}

export function AgentQuestionCard({ question, canWrite, busy, onAnswer }: {
  question: AgentQuestion; canWrite: boolean; busy: boolean
  onAnswer: (question: AgentQuestion, answers: Answer[]) => void
}) {
  const [values, setValues] = useState<Record<string, { choiceID: string; text: string; skip: boolean }>>({})
  const [, setClock] = useState(0)
  useEffect(() => {
    if (question.status !== 'pending') return
    const timer = window.setInterval(() => setClock((value) => value + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [question.status])
  const expired = question.status === 'pending' && Date.now() >= new Date(question.expires_at).getTime()
  const answers = question.items.map((item): Answer => {
    const value = values[item.id] ?? { choiceID: '', text: '', skip: false }
    return { question_id: item.id, ...(value.choiceID ? { choice_id: value.choiceID } : {}), ...(value.text.trim() ? { text: value.text.trim() } : {}), ...(value.skip ? { skip: true } : {}) }
  })
  const ready = answers.every((answer, index) => answer.skip ? !question.items[index].required : !!answer.choice_id || !!answer.text)
  const savedAnswers = new Map(question.answers.map((answer) => [answer.question_id, answer]))
  const statusLabel = question.status === 'pending' ? expired ? '已过期' : '等待回答' : ({ answered: '已回答', skipped: '已跳过', superseded: '已被新消息替代', expired: '已过期' } as Record<string, string>)[question.status] ?? question.status
  return <section aria-label="澄清问题" className="mt-3 rounded-xl border border-gamboge-200 bg-gamboge-50/70 p-3 text-left" data-testid={`agent-question-${question.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] font-semibold text-gamboge-800">需要你补充 · {statusLabel}</p>
      {question.status === 'pending' && !expired && <p className="text-[10px] text-gamboge-800">截止 {new Date(question.expires_at).toLocaleString('zh-CN')}</p>}</div>
    <form className="mt-2 space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready && canWrite && !busy && !expired) onAnswer(question, answers) }}>
      {question.items.map((item) => {
        const value = values[item.id] ?? { choiceID: '', text: '', skip: false }
        const saved = savedAnswers.get(item.id)
        const savedLabel = saved?.skip ? '已跳过' : saved?.text || item.options.find((option) => option.id === saved?.choice_id)?.label
        return <fieldset key={item.id} className="rounded-lg border border-gamboge-200 bg-white p-3" disabled={question.status !== 'pending' || expired || !canWrite || busy}>
          <legend className="px-1 text-[13px] font-medium text-mist-800">{item.title}{item.required ? '（必答）' : '（可跳过）'}</legend>
          {question.status === 'pending' && !expired ? <>
            <div className="mt-1 grid gap-1.5 sm:grid-cols-2">{item.options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-mist-200 px-2.5 py-2 text-xs text-mist-700 has-[:checked]:border-ink-400 has-[:checked]:bg-ink-50">
              <input type="radio" name={`question-${question.id}-${item.id}`} checked={value.choiceID === option.id} onChange={() => setValues((old) => ({ ...old, [item.id]: { choiceID: option.id, text: '', skip: false } }))} />{option.label}
            </label>)}</div>
            <label className="mt-2 block text-xs text-mist-500">或填写其他答案<textarea className="mt-1 min-h-16 w-full resize-y rounded-md border border-mist-200 bg-white px-2.5 py-2 text-xs text-mist-800 outline-none focus:border-ink-400" maxLength={2000} value={value.text} onChange={(event) => setValues((old) => ({ ...old, [item.id]: { choiceID: '', text: event.target.value, skip: false } }))} /></label>
            {!item.required && <label className="mt-2 flex items-center gap-2 text-xs text-mist-600"><input type="checkbox" checked={value.skip} onChange={(event) => setValues((old) => ({ ...old, [item.id]: { choiceID: '', text: '', skip: event.target.checked } }))} />跳过此问题</label>}
          </> : <p className="mt-1 text-xs text-mist-600">{savedLabel || '尚未回答'}</p>}
        </fieldset>
      })}
      {question.status === 'pending' && !expired && <div className="flex justify-end"><Button type="submit" size="sm" variant="primary" disabled={!ready || !canWrite || busy}>提交整组回答并继续</Button></div>}
      {expired && <p className="text-xs text-gamboge-800">问题已过期；不会自动继续运行。请重新发送消息说明目标。</p>}
    </form>
  </section>
}
