import { useMemo, useState } from 'react'
import { LoaderCircle, PackageCheck } from 'lucide-react'
import { Button, Notice } from '@/components/ui'
import { ApiError, errorMessage, get, post, rawRequest } from '@/lib/api'
import { coverPresetsFor, coverUpscaleFactor, renderCoverImages, type CoverRenderResult } from '@/lib/cover-build'
import type { Work } from '@/lib/types'
import { dataURLBytes, zipStore } from '@/lib/zip'

// DEV-CX10 / FR-CX-09：多比例封面交付构建（cover_images）。
// 一次只读构建：沿用原图与 cover_crops，不覆盖 asset 字节、不新建派生 asset、不改裁剪；
// 公众号推送继续传 cover_crops。低分辨率必须用户确认后才允许放大。
// Q-CX-03/04 未决：complete 仍停在 scanner_unverified，不置 built、不开放下载。

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
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [acceptedUpscale, setAcceptedUpscale] = useState(false)
  const [detail, setDetail] = useState<CoverBuildDetail | null>(null)
  const cover = work.assets.find((asset) => asset.id === work.cover_asset_id)

  const blocked = !canWrite || work.locked || busy || selected.length === 0 || !cover
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
          options: { presets: chosen.map((preset) => preset.id) },
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
        setNotice('结构与逐预设像素校验已完成；隐私扫描发布规则仍待确认，服务端已阻止交付。')
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
