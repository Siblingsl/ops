import { Button } from '@/components/ui'

// DEV-AI27-13 第二批（W13b）：消息流中的记忆候选卡（27 §11.1.1）。
// 候选出现在 run 结束后的消息下方；确认/修改/忽略逐项操作，无"全部确认"。
// 红线：候选不参与注入；模型不能自行确认。

interface MemoryCandidate {
  id: string
  text: string
  state: string
  revision: number
}

interface MemoryCandidateCardProps {
  candidates: MemoryCandidate[]
  busy: boolean
  onConfirm: (id: string, revision: number) => void
  onEdit: (id: string, text: string, revision: number) => void
  onIgnore: (id: string, revision: number) => void
}

export function MemoryCandidateCard({
  candidates, busy, onConfirm, onEdit, onIgnore,
}: MemoryCandidateCardProps) {
  if (candidates.length === 0) return null
  return <div className="mx-auto mt-2 max-w-3xl space-y-2" data-testid="memory-candidate-cards">
    <p className="text-xs font-medium text-mist-600">AI 提炼了 {candidates.length} 条候选记忆，确认后才会在后续对话中使用：</p>
    {candidates.map((c) => (
      <div key={c.id} className="rounded-lg border border-mist-200 bg-white p-3" data-testid={`memory-candidate-${c.id}`}>
        <p className="text-[13px] text-ink-700">{c.text}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm(c.id, c.revision)}>确认保存</Button>
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => { const text = window.prompt('修改记忆内容', c.text); if (text?.trim()) onEdit(c.id, text, c.revision) }}>
            修改后保存
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onIgnore(c.id, c.revision)}>忽略</Button>
        </div>
      </div>
    ))}
  </div>
}
