import { Check, ScanText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, cn, Input, Select } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { errorMessage, post, rawRequest } from '@/lib/api'
import type { Metric, Platform } from '@/lib/types'
import { useAIStatus } from '@/lib/v3'

export type MetricKey = 'reads' | 'likes' | 'wows' | 'favorites' | 'comments' | 'shares' | 'follows_gained'
export const metricFields: Record<Platform, { key: MetricKey; label: string }[]> = {
  wechat_mp: [
    { key: 'reads', label: '阅读' }, { key: 'likes', label: '点赞' }, { key: 'wows', label: '在看' },
    { key: 'shares', label: '分享' }, { key: 'comments', label: '留言' }, { key: 'follows_gained', label: '新增关注' },
  ],
  xhs: [
    { key: 'reads', label: '观看' }, { key: 'likes', label: '点赞' }, { key: 'favorites', label: '收藏' },
    { key: 'comments', label: '评论' }, { key: 'shares', label: '分享' }, { key: 'follows_gained', label: '涨粉' },
  ],
}

type ShotRow = {
  index: number; title: string; published_hint: string; day_hint: string
  work_id: string | null; match_type: 'exact' | 'fuzzy' | 'hint' | 'none'; similarity: number
  estimated: boolean; raw_text: string; dropped: string[]; status: 'pending' | 'confirmed'
} & Record<MetricKey, number | null>

type Draft = { work_id: string; vals: Record<MetricKey, string>; done: boolean }

const MAX_SHOTS = 9

const matchText = (r: ShotRow) =>
  r.match_type === 'exact' ? '按标题精确匹配' : r.match_type === 'fuzzy' ? `模糊匹配 ${Math.round(r.similarity * 100)}%，请确认`
    : r.match_type === 'hint' ? '截图里没有标题，默认为当前作品' : '没对上作品，请选择'

// DEV-DR05（14 文档 4.4）：上传 1–9 张数据截图，模型识别后逐行核对、逐行导入；没有"全部导入"。
export function ScreenshotImport({ accountId, platform, works, workId, onDone, label = '截图识别' }: {
  accountId: string
  platform: Platform
  works: { id: string; title: string }[]
  workId?: string
  onDone: () => void
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [upload, setUpload] = useState<{ id: string; rows: ShotRow[] } | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [saving, setSaving] = useState<number | null>(null)
  const fields = metricFields[platform]
  const ai = useAIStatus()

  const pick = async () => {
    if (ai && !ai.ready) {
      toast.error('还没有配置模型', { description: '截图识别需要模型。所有者可以在「设置 → 模型配置」用快速配置添加；也可以先手动录入。' })
      return
    }
    if (ai && !ai.vision_route && !(await confirm({
      title: '还没有指定图片识别模型',
      desc: '截图识别会使用默认模型；默认模型不支持图片输入时会识别失败。所有者可以在「设置 → 模型配置 → 快速配置」里填写图片识别模型。',
      confirmText: '仍要上传',
    }))) return
    input.current?.click()
  }

  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews])

  const recognize = async (files: File[]) => {
    if (files.length > MAX_SHOTS) {
      toast.error(`一次最多识别 ${MAX_SHOTS} 张截图`)
      return
    }
    const fd = new FormData()
    files.forEach((f) => fd.append('files', f))
    if (workId) fd.append('work_id', workId)
    setBusy(true)
    try {
      const res = await rawRequest('POST', `/accounts/${accountId}/metrics/screenshots`, fd)
      const data = await res.json() as { id: string; rows: ShotRow[] }
      if (!data.rows?.length) {
        toast.message('截图里没有识别出数据', { description: '请换一张清晰的数据页截图，或直接手动录入' })
        return
      }
      setPreviews(files.map((f) => URL.createObjectURL(f)))
      setUpload(data)
      setDrafts(data.rows.map((r) => ({
        work_id: r.work_id ?? '',
        vals: Object.fromEntries(fields.map((f) => [f.key, r[f.key]?.toString() ?? ''])) as Record<MetricKey, string>,
        done: r.status === 'confirmed',
      })))
    } catch (e) {
      aiError(e, '截图识别')
    } finally {
      setBusy(false)
    }
  }

  const confirmRow = async (i: number) => {
    if (!upload) return
    const d = drafts[i]
    if (!d.work_id) {
      toast.error('请先为这一行选择作品')
      return
    }
    const body: Record<string, unknown> = { work_id: d.work_id }
    for (const f of fields) body[f.key] = d.vals[f.key] === '' ? null : Number(d.vals[f.key])
    setSaving(i)
    try {
      const res = await post<Metric & { merged: boolean }>(`/metrics/screenshots/${upload.id}/rows/${i}/confirm`, body)
      toast.success(res.merged ? '已合并到同一节点的截图记录' : '这一行已导入')
      setDrafts((list) => list.map((x, j) => (j === i ? { ...x, done: true } : x)))
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  const close = () => {
    setUpload(null)
    setDrafts([])
    setPreviews([])
  }
  const edit = (i: number, patch: Partial<Draft>) => setDrafts((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  return (
    <>
      <Button size="sm" variant="secondary" icon={<ScanText className="size-3.5" />} loading={busy} onClick={() => void pick()}>{label}</Button>
      <input ref={input} type="file" accept="image/png,image/jpeg" multiple hidden
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) void recognize(fs) }} />
      <Dialog open={!!upload} onClose={close} title="核对截图识别结果" width="max-w-5xl"
        desc="对照左边的截图逐行核对，改对数字后点「导入这一行」；没导入的行不会保存。"
        footer={<Button variant="ghost" onClick={close}>完成</Button>}>
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div className="scrollbar-thin max-h-[60vh] space-y-2 overflow-y-auto">
            {previews.map((u, i) => <img key={u} src={u} alt={`截图 ${i + 1}`} className="w-full rounded-lg border border-mist-200" />)}
          </div>
          <div className="scrollbar-thin max-h-[60vh] space-y-3 overflow-y-auto">
            {upload?.rows.map((r, i) => {
              const d = drafts[i]
              if (!d) return null
              return (
                <div key={i} className={cn('rounded-lg border p-3', d.done ? 'border-emerald-200 bg-emerald-50/50' : 'border-mist-200')}>
                  <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-medium text-mist-800">{r.title || '（截图里没有标题）'}</div>
                      <div className="text-xs text-mist-400">
                        {matchText(r)}{r.day_hint && ` · ${r.day_hint}`}{r.published_hint && ` · 发布于 ${r.published_hint}`}
                      </div>
                    </div>
                    <Select value={d.work_id} disabled={d.done} onChange={(e) => edit(i, { work_id: e.target.value })}>
                      <option value="">选择作品</option>
                      {works.map((w) => <option key={w.id} value={w.id}>{w.title || '未命名'}</option>)}
                    </Select>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {fields.map((f) => (
                      <label key={f.key} className="text-[12px] text-mist-500">
                        {f.label}
                        <Input type="number" min={0} inputMode="numeric" disabled={d.done} value={d.vals[f.key]}
                          onChange={(e) => edit(i, { vals: { ...d.vals, [f.key]: e.target.value } })} />
                      </label>
                    ))}
                  </div>
                  {r.estimated && <div className="mt-2"><Badge>含「10万+」等估计值，按下限计入</Badge></div>}
                  {r.dropped.length > 0 && (
                    <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[12px] text-amber-800">
                      {r.dropped.join('、')}在截图文字里找不到，已丢弃，请对照截图手动补。
                    </p>
                  )}
                  {r.raw_text && <details className="mt-2 text-[12px] text-mist-400"><summary className="cursor-pointer">识别到的原始文字</summary><p className="mt-1 whitespace-pre-wrap">{r.raw_text}</p></details>}
                  <div className="mt-2 flex justify-end">
                    {d.done ? <span className="inline-flex items-center gap-1 text-[12.5px] text-emerald-700"><Check className="size-3.5" />已导入</span>
                      : <Button size="sm" variant="primary" loading={saving === i} onClick={() => confirmRow(i)}>导入这一行</Button>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <p className="mt-3 text-xs text-mist-400">截图只用于识别数字，7 天后自动删除，不进素材库、不进 AI 记忆；可以只截数据区域，避开私信和收益。</p>
      </Dialog>
    </>
  )
}
