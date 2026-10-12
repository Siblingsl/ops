import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, Field, Notice, Select, Textarea } from '@/components/ui'
import { errorMessage, post } from '@/lib/api'
import { type AIRefs, fmtTime } from '@/lib/format'
import type { MaterialKind, Section, Work } from '@/lib/types'

const kindLabel: Record<MaterialKind, string> = { experience: '经历', opinion: '观点', case: '案例', data: '数据' }

export interface AIConflict {
  server: Section
  candidate: string
  ai_call_id?: string | null
  source_revisions?: Record<string, number> | null
  refs?: AIRefs
  self_check?: { fixes: { from: string; to: string; count: number }[]; original: string }
}

export function WorkConflictDialog({ server, mine, onClose, onResolve }: {
  server: Work | null; mine: Work; onClose: () => void; onResolve: (keepMine: boolean) => void
}) {
  const text = (work: Work) => [work.title, work.summary, work.outline.map(item => item.heading).join(' → '), ...work.sections.map(s => `${s.heading}\n${s.content_md}`)].filter(Boolean).join('\n\n')
  return <Dialog open={!!server} onClose={onClose} title="这篇作品已在其他地方修改过" desc="请对比后选择保留哪个版本。" width="max-w-2xl"
    footer={<><Button onClick={() => onResolve(false)}>使用另一处的版本</Button><Button variant="primary" onClick={() => onResolve(true)}>保留我现在的版本</Button></>}>
    <div className="grid gap-4 md:grid-cols-2">
      <div><div className="mb-2 text-sm font-medium">另一处保存的</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm">{server && text(server)}</div></div>
      <div><div className="mb-2 text-sm font-medium">我现在的</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm">{text(mine)}</div></div>
    </div>
  </Dialog>
}

export function SectionConflictDialog({ server, heading, content, onClose, onResolve }: {
  server: Section | null; heading: string; content: string; onClose: () => void; onResolve: (keepMine: boolean) => void
}) {
  return <Dialog open={!!server} onClose={onClose} title="这一段已在其他地方修改过" desc="可能是另一个标签页、设备或同事。请选择保留哪个版本。" width="max-w-2xl"
    footer={<><Button onClick={() => onResolve(false)}>使用另一处的版本</Button><Button variant="primary" onClick={() => onResolve(true)}>保留我现在的版本</Button></>}>
    <div className="grid gap-4 md:grid-cols-2">
      <div><div className="mb-1.5 text-xs font-medium text-mist-500">另一处保存的（{server && fmtTime(server.updated_at)}）</div>
        {server && server.heading !== heading && <div className="mb-1 text-[13px] font-semibold text-mist-800">小标题：{server.heading || '（无）'}</div>}
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-mist-50 p-3 text-[13px]">{server?.content_md}</div></div>
      <div><div className="mb-1.5 text-xs font-medium text-ink-600">我现在的（含断网期间暂存在本机的修改）</div>
        {server && server.heading !== heading && <div className="mb-1 text-[13px] font-semibold text-ink-800">小标题：{heading || '（无）'}</div>}
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-ink-50/60 p-3 text-[13px]">{content}</div></div>
    </div>
  </Dialog>
}

export function AIConflictPanel({ conflict, onKeep, onReplace }: { conflict: AIConflict; onKeep: () => void; onReplace: () => Promise<void> }) {
  const [compare, setCompare] = useState(false)
  const [busy, setBusy] = useState(false)
  const replace = async () => { setBusy(true); try { await onReplace() } finally { setBusy(false) } }
  const choices = <><Button size="sm" variant="primary" loading={busy} onClick={replace}>替换</Button><Button size="sm" disabled={busy} onClick={onKeep}>保留当前</Button><Button size="sm" onClick={() => setCompare(true)}>对比</Button></>
  return <>
    <Notice tone="gamboge"><div>这段在生成期间被修改过</div><div className="mt-2 flex gap-2">{choices}</div></Notice>
    <Dialog open={compare} onClose={() => setCompare(false)} title="对比生成结果与当前内容" width="max-w-2xl" footer={choices}>
      <div className="grid gap-4 md:grid-cols-2">
        <div><div className="mb-2 text-sm font-medium">当前内容</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm">{conflict.server.content_md}</div></div>
        <div><div className="mb-2 text-sm font-medium">生成结果{conflict.self_check && `（自检修正 ${conflict.self_check.fixes.length} 处）`}</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm">{conflict.candidate}</div></div>
      </div>
    </Dialog>
  </>
}

export function SaveToMaterial({ text, work, onClose }: { text: string; work: Work; onClose: () => void }) {
  const [kind, setKind] = useState<MaterialKind>('opinion')
  const [content, setContent] = useState(text)
  const [shared, setShared] = useState(false)
  const save = async () => {
    try {
      await post('/materials', { account_id: shared ? null : work.account_id, kind, content, source: `作品《${work.title || '未命名'}》` })
      toast.success('已存入素材库')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Dialog open onClose={onClose} title="存入素材库" footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <Field label="类型">
          <Select value={kind} onChange={(e) => setKind(e.target.value as MaterialKind)}>
            {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="内容"><Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-[13px] text-mist-600"><input type="checkbox" className="accent-ink-600" checked={shared} onChange={(e) => setShared(e.target.checked)} />设为共享素材（所有账号都能引用）</label>
      </div>
    </Dialog>
  )
}
