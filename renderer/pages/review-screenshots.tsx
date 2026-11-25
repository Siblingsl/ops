import { Check, ClipboardPaste, Loader2, ScanText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, cn, Input, platformFormatLabel, Select } from '@/components/ui'
import { aiError } from '@/lib/ai-error'
import { errorMessage, post, rawRequest } from '@/lib/api'
import type { Metric, Platform } from '@/lib/types'
import { useAIStatus } from '@/lib/v3'

export type MetricKey = 'impressions' | 'reads' | 'likes' | 'wows' | 'favorites' | 'comments' | 'shares' | 'follows_gained'
export const metricFields: Record<Platform, { key: MetricKey; label: string }[]> = {
  wechat_mp: [
    { key: 'reads', label: '阅读' }, { key: 'likes', label: '点赞' }, { key: 'wows', label: '在看' },
    { key: 'shares', label: '分享' }, { key: 'comments', label: '留言' }, { key: 'follows_gained', label: '新增关注' },
  ],
  xhs: [
    { key: 'reads', label: '观看' }, { key: 'likes', label: '点赞' }, { key: 'favorites', label: '收藏' },
    { key: 'comments', label: '评论' }, { key: 'shares', label: '分享' }, { key: 'follows_gained', label: '涨粉' },
  ],
  toutiao: [
    { key: 'impressions', label: '展现量' }, { key: 'reads', label: '阅读' }, { key: 'likes', label: '点赞' },
    { key: 'favorites', label: '收藏' },
    { key: 'comments', label: '评论' }, { key: 'shares', label: '转发' }, { key: 'follows_gained', label: '涨粉' },
  ],
}

type ShotRow = {
  index: number; title: string; content_format?: string; published_hint: string; day_hint: string; interval_hint?: boolean
  work_id: string | null; match_type: 'exact' | 'fuzzy' | 'hint' | 'none'; similarity: number
  impressions_exact?: string | null
  estimated: boolean; raw_text: string; dropped: string[]; status: 'pending' | 'confirmed'
} & Record<MetricKey, number | null>

type Draft = { work_id: string; vals: Record<MetricKey, string>; cumulativeConfirmed: boolean; done: boolean }

const MAX_SHOTS = 9

const matchText = (r: ShotRow) =>
  r.match_type === 'exact' ? '按标题精确匹配' : r.match_type === 'fuzzy' ? `模糊匹配 ${Math.round(r.similarity * 100)}%，请确认`
    : r.match_type === 'hint' ? '截图里没有标题，默认为当前作品' : '没对上作品，请选择'

// DEV-DR05（14 文档 4.4）：上传 1–9 张数据截图，模型识别后逐行核对、逐行导入；没有"全部导入"。
// OPT-U05：新增拖拽 / Ctrl+V 粘贴入口，全部复用既有 `/metrics/screenshots` 与逐行确认接口。
export function ScreenshotImport({ accountId, platform, works, workId, onDone, label = '截图识别', variant = 'button', enableWindowPaste = false, highlightHint }: {
  accountId: string
  platform: Platform
  works: { id: string; title: string; content_format?: string }[]
  workId?: string
  onDone: () => void
  label?: string
  /** 'dropzone' 是复盘页顶部常驻的拖拽 / 粘贴引导卡；默认 'button'，既有调用零改动。 */
  variant?: 'button' | 'dropzone'
  /** 只有页面唯一一张引导卡开启 window paste 监听，避免多个实例按一次 Ctrl+V 并发识别。 */
  enableWindowPaste?: boolean
  /** 个人号无 datacube / 小红书 / 未开自动同步时的场景说明。 */
  highlightHint?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [upload, setUpload] = useState<{ id: string; rows: ShotRow[] } | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [saving, setSaving] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const fields = metricFields[platform]
  const ai = useAIStatus()

  // 点击选文件、拖拽释放、Ctrl+V 粘贴三种入口共用同一前置校验，避免任一路径绕过模型检查。
  const ensureModelReady = async () => {
    if (ai && !ai.ready) {
      toast.error('还没有配置模型', { description: '截图识别需要模型。所有者可以在「设置 → 模型配置」用快速配置添加；也可以先手动录入。' })
      return false
    }
    if (ai && !ai.vision_route && !(await confirm({
      title: '还没有指定图片识别模型',
      desc: '截图识别会使用默认模型；默认模型不支持图片输入时会识别失败。所有者可以在「设置 → 模型配置 → 快速配置」里填写图片识别模型。',
      confirmText: '仍要上传',
    }))) return false
    return true
  }

  const pick = async () => {
    if (!(await ensureModelReady())) return
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
        vals: Object.fromEntries(fields.map((f) => [f.key, f.key === 'impressions' ? (r.impressions_exact ?? r[f.key]?.toString() ?? '') : (r[f.key]?.toString() ?? '')])) as Record<MetricKey, string>,
        cumulativeConfirmed: false,
        done: r.status === 'confirmed',
      })))
    } catch (e) {
      aiError(e, '截图识别')
    } finally {
      setBusy(false)
    }
  }

  // Windows 资源管理器拖拽、部分剪贴板来源会丢 MIME，只能回落到文件名；webp / gif 等其他图片格式一律不认。
  const isSupportedShot = (file: File) => {
    const mime = (file.type || '').toLowerCase()
    if (mime === 'image/png' || mime === 'image/jpeg') return true
    if (!mime || mime === 'application/octet-stream') return /\.(png|jpg|jpeg)$/i.test(file.name || '')
    return false
  }

  // 拖拽、粘贴、选择文件共用同一套文件校验，识别请求仍然是既有的那一支。
  // 选择文件这条路径的模型校验已由 pick() 提前完成，skipModelCheck 避免无 vision_route 时连弹两遍确认框。
  const handleIncomingFiles = async (rawFiles: File[], skipModelCheck = false) => {
    if (busy || !!upload) return
    if (!rawFiles.length) return
    const valid = rawFiles.filter(isSupportedShot)
    if (!valid.length) {
      toast.error('仅支持 PNG / JPEG 格式截图，请重新截取或转换后再试')
      return
    }
    if (rawFiles.length > valid.length) toast.error('仅支持 PNG / JPEG 格式截图，请重新截取或转换后再试')
    if (valid.length > MAX_SHOTS) {
      toast.error(`一次最多识别 ${MAX_SHOTS} 张截图`)
      return
    }
    if (!skipModelCheck && !(await ensureModelReady())) return
    void recognize(valid)
  }

  // 粘贴监听挂在 window 上，闭包必须拿最新状态，否则一次识别后 busy/upload 会停留在旧值。
  const liveRef = useRef({ busy, upload, handle: handleIncomingFiles })
  useEffect(() => { liveRef.current = { busy, upload, handle: handleIncomingFiles } })

  useEffect(() => {
    if (!enableWindowPaste) return
    // 输入框、可编辑区域、打开中的弹窗（粘贴回填 / 录入抽屉 / 核对弹窗）里的 Ctrl+V 绝不抢占。
    const editing = (node: EventTarget | null) => {
      const el = node instanceof HTMLElement ? node : (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      return !!el && (!!el.closest('input, textarea, [contenteditable="true"]') || !!el.closest('[role="dialog"]'))
    }
    const clipboardImages = (data: DataTransfer | null) => {
      if (!data) return []
      const files: File[] = []
      const seen = new Set<string>()
      const add = (file: File | null) => {
        if (!file || !file.type.toLowerCase().startsWith('image/')) return
        const key = `${file.name}|${file.size}|${file.lastModified}`
        if (seen.has(key)) return
        seen.add(key)
        files.push(file)
      }
      Array.from(data.items ?? []).forEach((item) => { if (item.kind === 'file' && item.type.startsWith('image/')) add(item.getAsFile()) })
      Array.from(data.files ?? []).forEach(add)
      return files
    }
    const onPaste = (event: ClipboardEvent) => {
      if (editing(event.target) || editing(document.activeElement)) return
      const live = liveRef.current
      if (live.busy || !!live.upload) return
      const images = clipboardImages(event.clipboardData)
      if (!images.length) return // 纯文本粘贴直接放过，不改动默认行为
      event.preventDefault()
      void live.handle(images)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [enableWindowPaste])

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void handleIncomingFiles(Array.from(event.dataTransfer?.files ?? []))
  }

  const confirmRow = async (i: number) => {
    if (!upload) return
    const d = drafts[i]
    if (!d.work_id) {
      toast.error('请先为这一行选择作品')
      return
    }
    if (platform === 'toutiao' && upload.rows[i]?.interval_hint && !d.cumulativeConfirmed) {
      toast.error('请先核对累计值并勾选确认')
      return
    }
    const body: Record<string, unknown> = { work_id: d.work_id, cumulative_confirmed: d.cumulativeConfirmed }
    for (const f of fields) {
      if (d.vals[f.key] === '') body[f.key] = null
      else if (f.key === 'impressions') {
        const n = Number(d.vals[f.key])
        if (!/^\d+$/.test(d.vals[f.key]) || !Number.isSafeInteger(n) || n < 0) {
          toast.error('展现量必须是 JavaScript 安全范围内的非负整数，请核对原始截图')
          return
        }
        body[f.key] = n
      } else body[f.key] = Number(d.vals[f.key])
    }
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
      {variant === 'dropzone' ? (
        <div data-testid="review-screenshot-dropzone" data-dragging={dragging ? 'true' : 'false'}
          onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDrop={onDrop}
          className={cn('rounded-xl border border-dashed px-4 py-3.5 transition-colors',
            dragging ? 'border-ink-400 bg-ink-50 ring-2 ring-ink-200' : 'border-mist-200 bg-white')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-mist-800">
                <ClipboardPaste className="size-3.5 text-ink-600" />截图粘贴 / 拖拽一键识图录入
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">
                用微信 / QQ / Win+Shift+S 截完数据页后，直接在本页按 Ctrl+V 粘贴，或将 1–9 张 PNG/JPEG 截图拖到这里；识别后仍逐行核对确认，无「全部导入」。
              </p>
              {highlightHint && <p className="mt-1.5 rounded-md bg-ink-50 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-800">{highlightHint}</p>}
            </div>
            <Button size="sm" variant="secondary" icon={<ScanText className="size-3.5" />} loading={busy} onClick={() => void pick()}>选择截图文件</Button>
          </div>
          {busy
            ? <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-700"><Loader2 className="size-3.5 animate-spin" />正在识别截图数据…</p>
            : dragging && <p className="mt-2 text-[12px] text-ink-700">松开即可识别，识别后仍逐行核对确认</p>}
        </div>
      ) : (
        <Button size="sm" variant="secondary" icon={<ScanText className="size-3.5" />} loading={busy} onClick={() => void pick()}>{label}</Button>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg" multiple hidden
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) void handleIncomingFiles(fs, true) }} />
      <Dialog open={!!upload} onClose={close} title="核对截图识别结果" width="max-w-5xl"
        desc="对照左边的截图逐行核对，改对数字后点「导入这一行」；没导入的行不会保存。"
        footer={<Button variant="ghost" onClick={close}>完成</Button>}>
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div className="scrollbar-thin max-h-[18vh] space-y-2 overflow-y-auto md:max-h-[60vh]">
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
                        {platform === 'toutiao' && r.content_format && `${platformFormatLabel(platform, r.content_format)} · `}
                        {matchText(r)}{r.day_hint && ` · ${r.day_hint}`}{r.published_hint && ` · 发布于 ${r.published_hint}`}
                      </div>
                    </div>
                    <Select value={d.work_id} disabled={d.done} onChange={(e) => edit(i, { work_id: e.target.value })}>
                      <option value="">选择作品</option>
                      {works.map((w) => <option key={w.id} value={w.id}>{w.title || '未命名'}{platform === 'toutiao' && w.content_format ? ` · ${platformFormatLabel(platform, w.content_format)}` : ''}</option>)}
                    </Select>
                  </div>
                  {platform === 'toutiao' && r.interval_hint && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900">
                      截图中显示的是区间统计，首版只保存截至采集时间的累计作品数据。请对照头条后台把数字改成累计值后确认。
                      <label className="mt-2 flex items-start gap-2 font-medium">
                        <input type="checkbox" className="mt-0.5 accent-amber-700" disabled={d.done} checked={d.cumulativeConfirmed}
                          onChange={(e) => edit(i, { cumulativeConfirmed: e.target.checked })} />
                        <span>我已核对，并将本行数值改为截至采集时间的累计值</span>
                      </label>
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {fields.map((f) => (
                      <label key={f.key} className="text-[12px] text-mist-500">
                        {f.label}
                        <Input type="number" min={0} max={f.key === 'impressions' ? Number.MAX_SAFE_INTEGER : undefined} step={1} inputMode="numeric" disabled={d.done} value={d.vals[f.key]}
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
                      : <Button size="sm" variant="primary" disabled={platform === 'toutiao' && !!r.interval_hint && !d.cumulativeConfirmed} loading={saving === i} onClick={() => confirmRow(i)}>导入这一行</Button>}
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
