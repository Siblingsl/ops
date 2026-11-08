import { useCallback, useEffect, useState } from 'react'
import { MessageSquareDiff } from 'lucide-react'
import { Button } from '@/components/ui'
import { get, post } from '@/lib/api'

// DEV-AI27-09（W09b）：工作视图"产物"页来源子页 + 浏览器证据/批注列表（27 §10.1/§8.4）。
// 证据：本机观察上报的可回查来源（脱敏 URL/标题/时点/隔离状态）；
// 批注：选区+备注的引用筹码记录（发送后进入消息引用，不自动修改）。
// 数据全部来自 W09 API（本人/工作区过滤服务端保证）；隔离项只显示标记不给正文。

interface EvidenceItem {
  id: string
  origin: string
  redacted_url: string
  title: string
  kind: string
  redaction_state: string
  created_at: string
}

interface AnnotationItem {
  id: string
  origin: string
  selection_text: string
  note: string
  created_at: string
}

export function SourcePanel({ conversationId }: { conversationId: string }) {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([])
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [draft, setDraft] = useState({ origin: '', selection_text: '', note: '' })

  const reload = useCallback(async () => {
    try {
      const [ev, ann] = await Promise.all([
        get<{ evidence: EvidenceItem[] }>(`/agent/browser/evidence?conversation_id=${conversationId}`),
        get<{ annotations: AnnotationItem[] }>(`/agent/browser/annotations?conversation_id=${conversationId}`),
      ])
      setEvidence(ev.evidence)
      setAnnotations(ann.annotations)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [conversationId])

  useEffect(() => {
    if (conversationId) void reload()
  }, [conversationId, reload])

  const createAnnotation = async () => {
    if (!draft.selection_text.trim() && !draft.note.trim()) return
    try {
      await post('/agent/browser/annotations', { conversation_id: conversationId, ...draft })
      setDraft({ origin: draft.origin, selection_text: '', note: '' })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return <div className="space-y-4" data-testid="source-panel">
    {error && <p className="text-xs text-danger" role="alert">{error}</p>}

    <section>
      <h4 className="text-[13px] font-semibold text-ink-700">来源（{evidence.length}）</h4>
      {evidence.length === 0 && <p className="mt-1 text-xs text-mist-500">暂无浏览器来源证据；AI 读取网页后会在此可回查。</p>}
      <ul className="mt-2 space-y-1.5">
        {evidence.map((e) => <li key={e.id} className="rounded-lg border border-mist-100 p-2 text-[12px]" data-testid={`source-${e.id}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-ink-700">{e.title || e.origin}</span>
            {e.redaction_state === 'quarantined' && <span className="shrink-0 rounded bg-gamboge-100 px-1.5 py-0.5 text-[10px] text-gamboge-700">已隔离</span>}
          </div>
          <p className="mt-0.5 truncate text-mist-500">{e.redacted_url || e.origin}</p>
          <p className="text-mist-400">读取于 {e.created_at}</p>
        </li>)}
      </ul>
    </section>

    <section>
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-semibold text-ink-700">页面批注（{annotations.length}）</h4>
        <Button size="sm" variant="ghost" aria-label="添加批注" onClick={() => setShowAdd((v) => !v)}>
          <MessageSquareDiff className="size-3.5" /> 添加
        </Button>
      </div>
      {showAdd && <div className="mt-2 space-y-2 rounded-lg border border-mist-200 p-2" data-testid="annotation-form">
        <input className="w-full rounded-md border border-mist-200 px-2 py-1 text-[12px]" aria-label="来源地址"
          placeholder="来源 origin（可选）" value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} />
        <textarea className="w-full rounded-md border border-mist-200 px-2 py-1 text-[12px]" aria-label="选区文本"
          rows={2} placeholder="选中的页面文本" value={draft.selection_text} onChange={(e) => setDraft({ ...draft, selection_text: e.target.value })} />
        <textarea className="w-full rounded-md border border-mist-200 px-2 py-1 text-[12px]" aria-label="批注备注"
          rows={2} placeholder="你的备注（例如：据此修改第 3 段）" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        <Button size="sm" variant="primary" aria-label="保存批注"
          disabled={!draft.selection_text.trim() && !draft.note.trim()}
          onClick={() => void createAnnotation()}>保存批注</Button>
      </div>}
      {annotations.length === 0 && !showAdd && <p className="mt-1 text-xs text-mist-500">暂无批注。</p>}
      <ul className="mt-2 space-y-1.5">
        {annotations.map((a) => <li key={a.id} className="rounded-lg border border-mist-100 p-2 text-[12px]">
          {a.selection_text && <p className="text-ink-700">“{a.selection_text.slice(0, 120)}”</p>}
          {a.note && <p className="mt-0.5 text-mist-600">备注：{a.note}</p>}
          <p className="mt-0.5 text-mist-400">{a.origin || '无来源'} · {a.created_at}</p>
        </li>)}
      </ul>
    </section>
  </div>
}
