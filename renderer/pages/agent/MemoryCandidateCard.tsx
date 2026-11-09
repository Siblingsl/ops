import { useEffect, useState } from 'react'
import { Button } from '@/components/ui'

// DEV-AI27-13 第二批（W13b）：消息流中的记忆候选卡（27 §11.1.1）。
// 候选出现在 run 结束后的消息下方；确认/修改/忽略逐项操作，无"全部确认"。
// 红线：候选不参与注入；模型不能自行确认。
// A9 相似提示：确认前查询 similar_to（match_mode=literal 字面匹配，非语义相似），
// 命中时并排展示"新候选 vs 已有记忆"，提供 保持原项/替换/合并 三选一：
//   保持原项 = 忽略候选（原记忆不动）；替换 = 确认候选（原项由同 hash/人工停用兜底）；
//   合并 = 把候选编辑为合并文本后激活（edit CAS，冲突 409 由服务端保护）。

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

interface SimilarMemory {
  id: string
  text: string
  revision: number
}

function mergeTexts(candidate: string, existing: string): string {
  // 保守合并：候选在前、原项在后，去重句边界换行拼接；由用户再改。
  return `${candidate}\n（原记忆：${existing}）`.slice(0, 2000)
}

export function MemoryCandidateCard({
  candidates, busy, onConfirm, onEdit, onIgnore,
}: MemoryCandidateCardProps) {
  // 相似查询结果按候选 ID 缓存；null = 未查/无命中。
  const [similarBy, setSimilarBy] = useState<Record<string, SimilarMemory[]>>({})
  useEffect(() => {
    let cancelled = false
    const missing = candidates.filter((c) => similarBy[c.id] === undefined)
    if (missing.length === 0) return
    void (async () => {
      const next: Record<string, SimilarMemory[]> = {}
      for (const c of missing) {
        try {
          const res = await fetch(`/api/v1/agent/personal-memories?similar_to=${encodeURIComponent(c.text)}`, { credentials: 'same-origin' })
          if (!res.ok) { next[c.id] = []; continue }
          const data = await res.json() as { memories?: SimilarMemory[] }
          next[c.id] = data.memories ?? []
        } catch { next[c.id] = [] }
      }
      if (!cancelled) setSimilarBy((old) => ({ ...old, ...next }))
    })()
    return () => { cancelled = true }
  }, [candidates, similarBy])

  if (candidates.length === 0) return null
  return <div className="mx-auto mt-2 max-w-3xl space-y-2" data-testid="memory-candidate-cards">
    <p className="text-xs font-medium text-mist-600">AI 提炼了 {candidates.length} 条候选记忆，确认后才会在后续对话中使用：</p>
    {candidates.map((c) => {
      const similar = similarBy[c.id] ?? []
      const hasSimilar = similar.length > 0
      return <div key={c.id} className="rounded-lg border border-mist-200 bg-white p-3" data-testid={`memory-candidate-${c.id}`}>
        <p className="text-[13px] text-ink-700">{c.text}</p>
        {hasSimilar && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[12px]" data-testid={`memory-similar-${c.id}`}>
          <p className="font-medium text-amber-700">已有相似记忆（字面匹配，非语义判断）：</p>
          {similar.slice(0, 2).map((s) => <p key={s.id} className="mt-1 text-mist-600">{s.text}</p>)}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onIgnore(c.id, c.revision)}>保持原项（忽略候选）</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onEdit(c.id, mergeTexts(c.text, similar[0].text), c.revision)}>合并保存</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm(c.id, c.revision)}>仍要替换保存</Button>
          </div>
        </div>}
        {!hasSimilar && <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm(c.id, c.revision)}>确认保存</Button>
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => { const text = window.prompt('修改记忆内容', c.text); if (text?.trim()) onEdit(c.id, text, c.revision) }}>
            修改后保存
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onIgnore(c.id, c.revision)}>忽略</Button>
        </div>}
      </div>
    })}
  </div>
}
