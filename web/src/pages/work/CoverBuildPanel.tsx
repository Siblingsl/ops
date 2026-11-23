import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LoaderCircle, PackageCheck } from 'lucide-react'
import { Button, Notice } from '@/components/ui'
import { ApiError, errorMessage, get, post, rawRequest } from '@/lib/api'
import { coverPresetsFor, coverUpscaleFactor, renderCoverImages, type CoverRenderResult } from '@/lib/cover-build'
import type { Work } from '@/lib/types'
import { dataURLBytes, zipStore } from '@/lib/zip'

// DEV-CX10 / FR-CX-09：多比例封面交付构建（cover_images）。
// 一次只读构建：沿用原图与 cover_crops，不覆盖 asset 字节、不新建派生 asset、不改裁剪；
// 公众号推送继续传 cover_crops。低分辨率必须用户确认后才允许放大。
// Q-CX-03/04 已拍板（90 D-165）：纯净封面构建 complete 直接置 built，下载按门禁四态开放。

type CoverCopyRules = {
  title_max: number
  subtitle_max: number
  tone: string
  required: string[]
  forbidden: string[]
  line_break_hint: string
}

type CoverPresetRule = { key: string; platform: string; width: number; height: number; copy_rules: CoverCopyRules }

const fallbackCopyRules: Record<string, CoverCopyRules> = {
  wechat_235: { title_max: 10, subtitle_max: 16, tone: '信息/稳重', required: [], forbidden: ['！', '？', '震惊', '必看'], line_break_hint: '主标题一行；副标题可两行，第二行不超过 8 字' },
  wechat_square: { title_max: 10, subtitle_max: 16, tone: '信息/稳重', required: [], forbidden: ['！', '？', '震惊', '必看'], line_break_hint: '小图空间有限，主标题尽量 ≤8 字保证缩略可读' },
  xhs_34: { title_max: 12, subtitle_max: 18, tone: '具体/口语', required: ['人群或结果'], forbidden: ['震惊', '必看'], line_break_hint: '主标题最多两行，每行 ≤6 字；副标题一行' },
  xhs_square: { title_max: 12, subtitle_max: 18, tone: '具体/口语', required: ['人群或结果'], forbidden: ['震惊', '必看'], line_break_hint: '主标题最多两行，每行 ≤6 字；副标题一行' },
  xhs_916: { title_max: 12, subtitle_max: 18, tone: '具体/口语', required: ['人群或结果'], forbidden: ['震惊', '必看'], line_break_hint: '主标题最多两行，每行 ≤6 字；副标题一行' },
}

function runeLength(value: string) {
  return Array.from(value).length
}

function shortCopy(value: string, max: number) {
  const chars = Array.from(value.trim())
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

type CoverBuildDetail = {
  id: string
  status: 'running' | 'built' | 'failed'
  basis_revision: number
  source_hash: string
  params_hash: string
  is_current: boolean
  error_code: string | null
  targets: string[]
  artifacts: Array<{ id: string; kind: string; name: string; bytes: number; sha256: string; downloadable?: boolean }>
  validation?: { covers?: { count: number; entries: Array<{ name: string; width: number; height: number; sha256: string }> } }
  download_gate: { allowed: boolean; reason: string }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function CoverBuildPanel({ work, canWrite, client = 'web' }: { work: Work; canWrite: boolean; client?: 'web' | 'desktop' }) {
  const presets = useMemo(() => coverPresetsFor(work.platform), [work.platform])
  const [selected, setSelected] = useState<string[]>(presets.map((preset) => preset.id))
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const presetRules = useQuery({
    queryKey: ['cover-presets'],
    queryFn: () => get<{ presets: CoverPresetRule[] }>('/cover-presets'),
  })
  const rulesByKey = useMemo(() => {
    const map = new Map<string, CoverCopyRules>()
    for (const preset of presetRules.data?.presets ?? []) map.set(preset.key, preset.copy_rules)
    return map
  }, [presetRules.data])
  const activePreset = presets.find((preset) => selected.includes(preset.id)) ?? presets[0]
  const copyRules = activePreset ? rulesByKey.get(activePreset.id) ?? fallbackCopyRules[activePreset.id] ?? null : null
  const titleCount = runeLength(title.trim())
  const subtitleCount = runeLength(subtitle.trim())
  const hasCopy = !!(title.trim() || subtitle.trim())
  const titleTooLong = !!copyRules && titleCount > copyRules.title_max
  const subtitleTooLong = !!copyRules && subtitleCount > copyRules.subtitle_max
  const forbiddenHit = copyRules?.forbidden.find((word) => title.includes(word) || subtitle.includes(word)) ?? ''
  const copyError = !hasCopy ? '' : !title.trim() ? '填写封面文案时主标题不能为空。' : titleTooLong
    ? `主标题超长：当前 ${titleCount} 字，上限 ${copyRules!.title_max} 字。`
    : subtitleTooLong ? `副标题超长：当前 ${subtitleCount} 字，上限 ${copyRules!.subtitle_max} 字。`
      : forbiddenHit ? `文案包含当前预设的禁用词：${forbiddenHit}` : ''
  const suggestions = useMemo(() => {
    if (!copyRules) return []
    const titles = [work.title, work.viewpoint, work.topic_angle]
      .map((value) => shortCopy(value || '', copyRules.title_max))
      .filter(Boolean)
    const subtitleValue = shortCopy(work.summary || '', copyRules.subtitle_max)
    return [...new Set(titles)].slice(0, 3).map((value) => ({ title: value, subtitle: subtitleValue }))
  }, [copyRules, work.title, work.viewpoint, work.topic_angle, work.summary])
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [acceptedUpscale, setAcceptedUpscale] = useState(false)
  const [detail, setDetail] = useState<CoverBuildDetail | null>(null)
  const cover = work.assets.find((asset) => asset.id === work.cover_asset_id)

  const blocked = !canWrite || work.locked || busy || selected.length === 0 || !cover || !!copyError
  // 低分辨率预估：任一所选预设需要放大原图就要求用户明确确认（FR-CX-09）。
  const upscaledPresets = useMemo(() => {
    if (!cover) return []
    return presets.filter((preset) => selected.includes(preset.id) && coverUpscaleFactor(preset, work.cover_crops, cover.width, cover.height) > 1)
  }, [presets, selected, cover, work.cover_crops])

  const run = async () => {
    if (blocked || !cover) return
    setBusy(true)
    setError('')
    setNotice('')
    setDetail(null)
    try {
      const chosen = presets.filter((preset) => selected.includes(preset.id))
      setStage(`正在生成 0/${chosen.length} 张封面`)
      const renders: CoverRenderResult[] = await renderCoverImages(
        cover.url, cover.width, cover.height, chosen, work.cover_crops,
        (done, total) => setStage(`正在生成 ${done}/${total} 张封面`),
      )
      if (renders.length !== chosen.length) throw new Error('本次渲染的封面数与所选预设不一致，已停止。')
      const upscaled = renders.filter((render) => render.upscale > 1)
      if (upscaled.length > 0 && !acceptedUpscale) {
        throw new Error('有预设需要放大原图（低分辨率）。请确认接受放大后重试，或先换更清晰的封面图。')
      }
      setStage('正在打包 ZIP')
      const archive = zipStore(renders.map((render) => ({ name: render.name, data: dataURLBytes(render.dataUrl) })))

      setStage('正在创建构建')
      const created = await post<{ build_id: string; status: string; source_hash: string; params_hash: string; reused: boolean }>(
        `/works/${work.id}/builds`, {
          basis_revision: work.revision, targets: ['cover_images'],
          options: hasCopy ? { presets: chosen.map((preset) => preset.id), title: title.trim(), subtitle: subtitle.trim() } : { presets: chosen.map((preset) => preset.id) },
          client, renderer_contract_version: 'ops.cover-images/v1',
        })
      if (created.status !== 'running') {
        setNotice(created.status === 'built' ? '已复用同一冻结版本的历史构建。' : '该构建已进入终态。')
        setDetail(await get<CoverBuildDetail>(`/builds/${created.build_id}`))
        return
      }

      setStage('正在上传交付包')
      const form = new FormData()
      form.append('kind', 'zip')
      form.append('sha256', await sha256(archive))
      form.append('file', new Blob([archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer], { type: 'application/zip' }), 'covers.zip')
      const uploaded = await (await rawRequest('POST', `/builds/${created.build_id}/artifacts`, form)).json() as { artifact_id: string }

      setStage('正在提交校验')
      try {
        await post(`/builds/${created.build_id}/complete`, {
          source_hash: created.source_hash, params_hash: created.params_hash,
          artifacts: [{ artifact_id: uploaded.artifact_id, kind: 'zip', name: 'covers.zip' }],
          renderer_receipt: { client, application_version: '0.1.0', renderer_contract_version: 'ops.cover-images/v1',
            chromium_version: /Chrom(?:e|ium)\/([^ )]+)/.exec(navigator.userAgent)?.[1] || 'web-browser',
            font_family: getComputedStyle(document.body).fontFamily || 'sans-serif',
            device_scale_factor: window.devicePixelRatio || 1, viewport_width: window.innerWidth, viewport_height: window.innerHeight },
        })
        setNotice('逐预设像素校验已完成。')
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== 'scanner_unverified') throw reason
        setNotice('结构与逐预设像素校验已完成；产物包含阻断级隐私发现，服务端已阻止交付。')
      }
      setDetail(await get<CoverBuildDetail>(`/builds/${created.build_id}`))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStage('')
      setBusy(false)
    }
  }

  const covers = detail?.validation?.covers
  return <div className="mt-3 rounded-lg border border-ink-200 bg-white p-3" data-testid="cover-build-panel">
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-ink-800">多比例封面交付（cover_images）</p>
        <p className="mt-1 text-[10px] text-mist-500">按所选预设从当前封面与裁剪坐标生成 PNG 打包；只读构建，不改原图、不新建派生图片、不改裁剪。公众号推送仍使用已保存的封面裁剪。</p>
      </div>
      <Button size="sm" variant="primary" icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
        loading={busy} disabled={blocked} onClick={() => void run()}>生成交付包</Button>
    </div>
    <div className="mt-2 flex flex-wrap gap-3" data-testid="cover-preset-options">
      {presets.map((preset) => (
        <label key={preset.id} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-mist-700">
          <input type="checkbox" className="accent-ink-600" checked={selected.includes(preset.id)}
            onChange={(event) => setSelected((prev) => event.target.checked ? [...prev, preset.id] : prev.filter((id) => id !== preset.id))} />
          {preset.label}（{preset.width}×{preset.height}）
        </label>
      ))}
    </div>
    {copyRules && <div className="mt-3 rounded-lg border border-mist-200 bg-mist-50/50 p-2.5" data-testid="cover-copy-editor">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11.5px] font-medium text-mist-700">封面文案（可选，随本次构建逐预设校验）</p>
        <span className="text-[10px] text-mist-400">语气：{copyRules.tone}{copyRules.required.length > 0 ? ` · 建议包含：${copyRules.required.join('、')}` : ''}</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-mist-600">主标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="主标题"
            className="mt-1 w-full rounded-md border border-mist-200 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-ink-400" data-testid="cover-copy-title" />
          <span data-testid="cover-copy-title-count" className={titleTooLong ? 'text-danger' : 'text-mist-400'}>{titleCount}/{copyRules.title_max} 字</span>
        </label>
        <label className="text-[11px] text-mist-600">副标题
          <input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="副标题（可留空）"
            className="mt-1 w-full rounded-md border border-mist-200 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-ink-400" data-testid="cover-copy-subtitle" />
          <span data-testid="cover-copy-subtitle-count" className={subtitleTooLong ? 'text-danger' : 'text-mist-400'}>{subtitleCount}/{copyRules.subtitle_max} 字</span>
        </label>
      </div>
      <p className="mt-1.5 text-[10px] text-mist-400">换行建议：{copyRules.line_break_hint}{copyRules.forbidden.length > 0 ? ` · 禁用：${copyRules.forbidden.join(' ')}` : ''}</p>
      {copyError && <p role="alert" data-testid="cover-copy-error" className="mt-1.5 text-[11px] font-medium text-danger">{copyError}</p>}
      <div className="mt-2" data-testid="cover-copy-suggestions">
        <p className="text-[10px] text-mist-500">文案建议（只建议，点击后才填入）：</p>
        {suggestions.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {suggestions.map((item, index) => <button key={`${item.title}-${index}`} type="button"
              onClick={() => { setTitle(item.title); setSubtitle(item.subtitle) }}
              className="rounded-md border border-mist-200 bg-white px-2 py-1 text-left text-[10.5px] text-mist-600 hover:border-ink-300"
              data-testid={`cover-copy-suggestion-${index}`}>
              {item.title}{item.subtitle ? ` · ${item.subtitle}` : ''}
            </button>)}
          </div>
        ) : (
          <p className="mt-1 text-[10px] text-mist-500" data-testid="cover-copy-suggestions-empty">
            暂无可生成的文案建议；可直接编辑上方文案，或先补充作品标题/观点/选题角度。
          </p>
        )}
        {suggestions.length === 1 && (
          <p className="mt-1 text-[10px] text-gamboge-700" data-testid="cover-copy-suggestions-short">
            可用作品字段不足，当前仅 {suggestions.length} 套建议；补充标题/观点/选题角度可获得更多建议，也可直接编辑文案。
          </p>
        )}
      </div>
    </div>}
    {presetRules.isError && <p className="mt-1 text-[10px] text-gamboge-700">文案规则接口加载失败，当前使用内置同版本规则。</p>}
    {upscaledPresets.length > 0 && (
      <div className="mt-2 rounded-md border border-gamboge-200 bg-gamboge-50 p-2 text-[11px] text-gamboge-800">
        <label className="flex cursor-pointer items-start gap-1.5">
          <input type="checkbox" className="mt-0.5 accent-ink-600" checked={acceptedUpscale}
            onChange={(event) => setAcceptedUpscale(event.target.checked)} />
          <span>以下预设的源图区域小于目标像素，需要放大输出：{upscaledPresets.map((preset) => `${preset.label} ${preset.width}×${preset.height}`).join('、')}。放大不会增加细节，确认接受后再生成。</span>
        </label>
      </div>
    )}
    {stage && <p role="status" className="mt-2 text-[11px] text-mist-500">{stage}</p>}
    {error && <Notice tone="red">{error}</Notice>}
    {notice && <Notice tone="gamboge">{notice}</Notice>}
    {detail && <div className="mt-2 space-y-2 rounded-md border border-mist-200 bg-mist-50/50 p-2 text-[11px]" data-testid="cover-build-detail">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-mist-800">构建状态：{detail.status === 'built' ? '已完成' : detail.status === 'running' ? '运行中' : '未完成'}</strong>
        <span className="text-mist-500">第 {detail.basis_revision} 版 · {detail.targets.join('、')}</span>
        {!detail.is_current && <span className="text-gamboge-700">历史快照</span>}
        {detail.error_code && <span className="text-danger">{detail.error_code}</span>}
      </div>
      {covers && <p className="text-mist-600">已校验 {covers.count} 张 · {covers.entries.map((entry) => `${entry.name} ${entry.width}×${entry.height}`).join('，')}</p>}
      <p className="text-mist-500">下载门禁：{detail.download_gate.allowed ? '已开放' : detail.download_gate.reason}</p>
      <p className="break-all text-[10px] text-mist-400">source {detail.source_hash.slice(0, 12)} · params {detail.params_hash.slice(0, 12)}</p>
    </div>}
    <p className="mt-2 text-[10px] text-mist-400">安全区提示：平台可能按自身规则再裁切，中心 80% 以内的主体最稳妥；此处不保证平台最终显示。</p>
  </div>
}
