import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Badge, Notice, cn } from '@/components/ui'
import { Dialog } from '@/components/dialog'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import type { WorkflowStep, WorkflowTemplate } from '@/lib/agent'

// REF41 A7：模板卡 → 必需输入（缺失标红）→ 计划预览 → 确认生成计划。
// 启动只创建 conversation+run+plan，不执行工具；确认仍走现有计划确认接口。
type AccountOption = { id: string; name: string }
type WorkflowStartResult = { conversation_id: string; run_id: string; plan?: unknown }

const fieldLabels: Record<string, string> = {
  account_id: '操作账号',
  work_id: '作品',
  topic_id: '选题',
  benchmark_target_id: '竞对目标',
  date_range: '日期范围',
}

const fieldPlaceholders: Record<string, string> = {
  date_range: '如 2026-11-01~2026-11-07',
}

function requiredKeys(step: WorkflowStep) {
  return step.requires ?? []
}

export function WorkflowTemplateDialog({ open, onClose, templates, accountID, accounts, onStarted }: {
  open: boolean
  onClose: () => void
  templates: WorkflowTemplate[]
  accountID: string
  accounts: AccountOption[]
  onStarted: (result: WorkflowStartResult, template: WorkflowTemplate) => void
}) {
  const [selectedID, setSelectedID] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const selected = templates.find((template) => template.id === selectedID) ?? null
  const required = useMemo(() => {
    if (!selected) return []
    return [...new Set(selected.steps.flatMap(requiredKeys))]
  }, [selected])
  const needsWorks = required.includes('work_id')
  const needsTopics = required.includes('topic_id')
  const needsBenchmarks = required.includes('benchmark_target_id')
  const works = useQuery({
    queryKey: ['workflow-works', accountID],
    queryFn: () => get<{ items: Array<{ id: string; title: string }> }>(`/accounts/${accountID}/works?limit=50`),
    enabled: open && needsWorks && !!accountID,
  })
  const topics = useQuery({
    queryKey: ['workflow-topics', accountID],
    queryFn: () => get<{ items: Array<{ id: string; title: string }> }>(`/accounts/${accountID}/topics?limit=50`),
    enabled: open && needsTopics && !!accountID,
  })
  const benchmarks = useQuery({
    queryKey: ['workflow-benchmarks', accountID],
    queryFn: () => get<{ items: Array<{ id: string; name: string }> }>(`/accounts/${accountID}/benchmarks`),
    enabled: open && needsBenchmarks && !!accountID,
  })

  const choose = (template: WorkflowTemplate) => {
    setSelectedID(template.id)
    setValues({ account_id: accountID })
    setMissing([])
    setError('')
  }

  const fieldOptions = (key: string) => {
    if (key === 'account_id') return accounts.map((item) => ({ id: item.id, label: item.name }))
    if (key === 'work_id') return (works.data?.items ?? []).map((item) => ({ id: item.id, label: item.title || '未命名作品' }))
    if (key === 'topic_id') return (topics.data?.items ?? []).map((item) => ({ id: item.id, label: item.title || '未命名选题' }))
    if (key === 'benchmark_target_id') return (benchmarks.data?.items ?? []).map((item) => ({ id: item.id, label: item.name || '未命名目标' }))
    return []
  }

  const submit = async () => {
    if (!selected || starting) return
    const lacking = required.filter((key) => !values[key]?.trim())
    setMissing(lacking)
    setError('')
    if (lacking.length > 0) return
    setStarting(true)
    try {
      const payload: Record<string, string> = {}
      for (const key of required) if (values[key]?.trim()) payload[key] = values[key].trim()
      const result = await post<WorkflowStartResult>(`/workflows/${selected.id}/start`, payload)
      onStarted(result, selected)
      setSelectedID('')
      setValues({})
      onClose()
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'workflow_missing_input') {
        const detail = reason.detail as { missing?: unknown } | null
        if (Array.isArray(detail?.missing)) setMissing(detail.missing.filter((item): item is string => typeof item === 'string'))
      }
      setError(errorMessage(reason) || '工作流启动失败')
    } finally {
      setStarting(false)
    }
  }

  const title = selected ? `工作流「${selected.name}」` : '工作流模板'
  return (
    <Dialog open={open} onClose={onClose} title={title}
      desc="先选模板并补齐必需输入，确认下方计划预览后只生成计划；不会自动执行工具，也没有“全部执行”。"
      width="max-w-2xl"
      footer={selected ? <>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={starting} onClick={() => void submit()} data-testid="workflow-create-plan">确认并生成计划</Button>
      </> : <Button variant="ghost" onClick={onClose}>关闭</Button>}>
      <div className="space-y-2" data-testid="workflow-template-list">
        {templates.map((template) => (
          <button key={template.id} type="button" onClick={() => choose(template)}
            data-testid={`workflow-template-${template.builtin_key || template.id}`}
            className={cn('block w-full rounded-lg border p-3 text-left transition', selectedID === template.id ? 'border-ink-400 bg-ink-50' : 'border-mist-200 hover:border-ink-300')}>
            <span className="flex items-center justify-between gap-2">
              <strong className="text-[13px] text-mist-800">{template.name}{template.builtin_key ? ' · 内置' : ''}</strong>
              <span className="text-[11px] text-mist-400">{template.steps.length} 步</span>
            </span>
            {template.description && <span className="mt-1 block text-xs text-mist-500">{template.description}</span>}
          </button>
        ))}
        {templates.length === 0 && <p className="text-xs text-mist-500">暂无可用模板。</p>}
      </div>

      {selected && <>
        <section className="mt-4 rounded-xl border border-mist-200 p-3" data-testid="workflow-inputs">
          <p className="text-[12px] font-semibold text-mist-800">必需输入</p>
          <p className="mt-1 text-[11px] text-mist-500">缺项会在提交前标红，并显示服务端返回的 missing 列表；不会用空值猜测。</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {required.map((key) => {
              const bad = missing.includes(key)
              const options = fieldOptions(key)
              return <label key={key} className="block text-[12px] font-medium text-mist-700" data-testid={`workflow-field-${key}`}>
                {fieldLabels[key] ?? key}{bad && <span className="ml-1 text-danger">必填</span>}
                {key === 'date_range' ? (
                  <input value={values[key] ?? ''} placeholder={fieldPlaceholders[key]}
                    onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                    className={cn('mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal outline-none', bad ? 'border-danger bg-red-50' : 'border-mist-200 focus:border-ink-400')} />
                ) : (
                  <select value={values[key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                    className={cn('mt-1 w-full rounded-lg border bg-white px-3 py-2 text-[13px] font-normal outline-none', bad ? 'border-danger bg-red-50' : 'border-mist-200 focus:border-ink-400')}>
                    <option value="">请选择</option>
                    {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                )}
              </label>
            })}
          </div>
          {required.length === 0 && <p className="mt-2 text-[12px] text-mist-500">该模板无需额外输入。</p>}
          {(needsWorks && works.isError) || (needsTopics && topics.isError) || (needsBenchmarks && benchmarks.isError)
            ? <Notice tone="red">输入选项加载失败，请关闭后重试。</Notice> : null}
        </section>

        <section className="mt-4 rounded-xl border border-mist-200 p-3" data-testid="workflow-plan-preview">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12px] font-semibold text-mist-800">计划预览</p>
            <span className="text-[11px] text-mist-400">{selected.steps.length} 步 · 确认后仍逐步执行</span>
          </div>
          <ol className="mt-3 space-y-2">
            {selected.steps.map((step, index) => (
              <li key={step.key} className="rounded-lg bg-mist-50/70 px-3 py-2" data-testid={`workflow-step-${step.key}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] tabular-nums text-mist-400">{index + 1}</span>
                  <span className="text-[12.5px] font-medium text-mist-800">{step.title}</span>
                  {step.confirm && <Badge tone="gamboge">需人工确认</Badge>}
                  <span className="text-[11px] text-mist-500">工具 {(step.tools ?? []).length}</span>
                </div>
                {(step.requires?.length || step.outputs?.length) ? <p className="mt-1 text-[11px] text-mist-500">
                  {step.requires?.length ? `输入：${step.requires.map((key) => fieldLabels[key] ?? key).join('、')}` : ''}
                  {step.requires?.length && step.outputs?.length ? ' · ' : ''}
                  {step.outputs?.length ? `产出：${step.outputs.join('、')}` : ''}
                </p> : null}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[10px] text-mist-400">确认步骤会生成动作卡片等待你逐张处理；本页没有“全部执行”入口。</p>
        </section>
        {missing.length > 0 && <Notice tone="red">还缺少：{missing.map((key) => fieldLabels[key] ?? key).join('、')}</Notice>}
        {error && <Notice tone="red">{error}</Notice>}
      </>}
    </Dialog>
  )
}
