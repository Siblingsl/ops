import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, Field, Input, Notice, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { useCanWrite } from '@/lib/session'
import type { Account } from '@/lib/types'

// DEV-CX13-F / FR-CX-23：运营标准版本表。
// 软口径快照：定位说明不回写 profile；DNA 只引用不可变版本；版本不可改/删，只能新增；归档只变可见性。

interface TextRule { text: string }
interface StandardVersion {
  version: number
  positioning: string
  text_rules: TextRule[]
  visual_rules: { preferred_ratio?: string; min_images_hint?: number; dna_version: number | null }
  content_hash: string
  effective_from: string
  archived_at: string | null
}

function apiErrorText(reason: unknown) {
  if (reason instanceof ApiError && reason.code === 'version_conflict') return '标准已被其他窗口新增，请刷新后重试。'
  if (reason instanceof ApiError && reason.code === 'standard_exists') return '该生效日期或版本号已有标准。'
  return errorMessage(reason)
}

export default function StandardsTab({ account }: { account: Account }) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const [positioning, setPositioning] = useState('')
  const [rules, setRules] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useQuery({
    queryKey: ['standards', account.id],
    queryFn: () => get<{ items: StandardVersion[] }>(`/accounts/${account.id}/standards`),
  })
  const effective = useQuery({
    queryKey: ['standards-effective', account.id],
    queryFn: () => get<{ standard: StandardVersion | null }>(`/accounts/${account.id}/standards/effective?at=${new Date().toISOString().slice(0, 10)}`),
  })

  const create = async () => {
    if (!canWrite || busy || !effectiveFrom) return
    setBusy(true)
    setError('')
    try {
      const current = list.data?.items[0]?.version ?? 0
      const textRules = rules.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text }))
      await post(`/accounts/${account.id}/standards`, {
        base_version: current, positioning: positioning.trim(), text_rules: textRules,
        visual_rules: { dna_version: null }, effective_from: effectiveFrom,
      })
      setPositioning(''); setRules(''); setEffectiveFrom('')
      await qc.invalidateQueries({ queryKey: ['standards', account.id] })
      await qc.invalidateQueries({ queryKey: ['standards-effective', account.id] })
    } catch (reason) {
      setError(apiErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const archive = async (version: number, archived: boolean) => {
    try {
      await post(`/accounts/${account.id}/standards/${version}/archive`, { archived })
      await qc.invalidateQueries({ queryKey: ['standards', account.id] })
      await qc.invalidateQueries({ queryKey: ['standards-effective', account.id] })
    } catch (reason) {
      setError(apiErrorText(reason))
    }
  }

  return (
    <div className="space-y-4" data-testid="standards-tab">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold text-mist-900">回复标准</h2>
          <Badge tone="gray">版本不可修改 · 归档只隐藏</Badge>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-mist-500">
          这是给你的软口径备忘：定位说明与文本建议只约束你自己的写作取舍，不替代平台硬检查；当前生效版本会随每次发布前检查冻结留档，之后修改标准不会改写历史结论。
        </p>
        {error && <div className="mt-2"><Notice tone="red">{error}</Notice></div>}
        {effective.data?.standard && <div className="mt-2 rounded-lg bg-ink-50/50 p-2.5 text-[12px]" data-testid="standards-effective">
          <p className="font-semibold text-ink-800">当前生效 v{effective.data.standard.version}（自 {effective.data.standard.effective_from}）</p>
          {effective.data.standard.positioning && <p className="mt-0.5 text-mist-600">{effective.data.standard.positioning}</p>}
        </div>}
        {canWrite && <div className="mt-3 space-y-2">
          <Field label={`定位说明（≤500 字，不回写账号定位）`}>
            <Textarea rows={2} value={positioning} maxLength={500} aria-label="定位说明" onChange={(e) => setPositioning(e.target.value)} />
          </Field>
          <Field label="文本建议（每行一条，≤200 字、最多 20 条）">
            <Textarea rows={3} value={rules} aria-label="文本建议" onChange={(e) => setRules(e.target.value)}
              placeholder={'开头先给结论\n每段配一个可复现的小例子'} />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="生效日期（可为未来日期）">
              <Input type="date" value={effectiveFrom} aria-label="生效日期" onChange={(e) => setEffectiveFrom(e.target.value)} />
            </Field>
            <Button size="sm" variant="primary" className="mb-0.5" icon={<Plus className="size-3.5" />} loading={busy}
              disabled={!canWrite || busy || !effectiveFrom} onClick={() => void create()}>保存为新版本</Button>
          </div>
        </div>}
        <div className="mt-3 space-y-2" data-testid="standards-list">
          {list.data?.items.map((item) => (
            <Card key={item.version} className="p-3" data-testid="standard-version-item">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-mist-900">v{item.version}</strong>
                <Badge tone="gray">自 {item.effective_from}</Badge>
                <span className="text-[10px] text-mist-400">哈希 {item.content_hash.slice(0, 12)}…</span>
                <Button size="sm" variant="ghost" className="ml-auto"
                  icon={item.archived_at ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                  disabled={!canWrite} onClick={() => void archive(item.version, !item.archived_at)}>
                  {item.archived_at ? '恢复显示' : '归档'}
                </Button>
              </div>
              {item.positioning && <p className="mt-1 text-[12px] text-mist-700">{item.positioning}</p>}
              {item.text_rules.length > 0 && <ul className="mt-1 list-disc pl-5 text-[12px] text-mist-600">
                {item.text_rules.map((rule, index) => <li key={index}>{rule.text}</li>)}
              </ul>}
            </Card>
          ))}
          {list.data && list.data.items.length === 0 && <p className="text-[12px] text-mist-400">还没有标准版本。留空也可以，发布前检查不因此阻断。</p>}
        </div>
      </Card>
    </div>
  )
}
