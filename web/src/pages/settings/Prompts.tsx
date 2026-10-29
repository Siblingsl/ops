import { useQuery } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, Field, PageHeader, PageLoading, Tabs, Textarea } from '@/components/ui'
import { errorMessage, get, put } from '@/lib/api'
import { PromptEval } from './Quality'

interface PromptTemplate {
  task_type: string
  label: string
  version: number
  content: string
  active: boolean
  updated_at: string
}

export default function Prompts() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ['prompt-templates'], queryFn: () => get<PromptTemplate[]>('/prompt-templates') })
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'templates' | 'eval'>('templates')
  const [evalFor, setEvalFor] = useState<{ task: string; candidate?: string }>({ task: '' })
  if (isLoading) return <PageLoading />
  const list = data ?? []
  const open = (t: PromptTemplate) => {
    setEditing(t)
    setText(t.content)
  }
  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      await put(`/prompt-templates/${editing.task_type}`, { content: text })
      toast.success('已保存新版本（系统规则不可改）')
      setEditing(null)
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const compare = () => {
    if (!editing) return
    setEvalFor({ task: editing.task_type, candidate: text })
    setTab('eval')
  }
  return (
    <div className="animate-fade-in">
      <PageHeader title="提示词模板" desc="只可编辑各任务的指令部分；系统规则（不编造事实等）始终生效。改之前可以先在「测试集」里新旧对比。"
        action={<Tabs value={tab} onChange={setTab} items={[{ value: 'templates', label: '模板' }, { value: 'eval', label: '测试集' }]} />} />
      {tab === 'eval' ? <PromptEval key={evalFor.task + (evalFor.candidate ?? '')} initialTask={evalFor.task} candidate={evalFor.candidate} /> : (
        <>
          <Card>
            <ul className="divide-y divide-mist-100">
              {list.map((t) => (
                <li key={t.task_type} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-mist-800">{t.label}</div>
                    <div className="truncate text-xs text-mist-400">v{t.version} · {t.task_type} · {t.content.slice(0, 80)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => open(t)}>编辑</Button>
                </li>
              ))}
            </ul>
          </Card>
          {editing && (
            <Card className="mt-5 p-5">
              <CardHeader title={`编辑：${editing.label}`} desc="保存后生成新版本并立即用于后续任务。" />
              <Field label="任务指令">
                <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                <Button icon={<FlaskConical className="size-4" />} disabled={!text.trim() || text === editing.content} onClick={compare}>先和当前版本对比</Button>
                <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={save}>保存</Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
