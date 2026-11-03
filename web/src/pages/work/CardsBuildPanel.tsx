import { useState } from 'react'
import { Download, LoaderCircle, PackageCheck } from 'lucide-react'
import { Button, Notice } from '@/components/ui'
import { ApiError, errorMessage, get, post, rawRequest } from '@/lib/api'
import type { Work } from '@/lib/types'
import { dataURLBytes, zipStore } from '@/lib/zip'
import { renderCXVisualCards, type CXVisualCardPreview } from './cx-visual-cards-render'

// 构建预览比本机预览多出冻结摘要与模板版本；其余字段与渲染器输入一致。
export type CardsBuildPreview = CXVisualCardPreview & {
  source_hash: string
  template_version: string
  visual_plan?: { diagnosis_id: string; input_hash: string; result_revision: number } | null
}

// DEV-CX09：用户确认计划 → 采用为 xhs_cards 构建输入 → 本机渲染 PNG → ZIP → 服务端逐张校验。
// 边界：一次点击只创建一个构建；Q-CX-03/04 未决时服务端仍停在 scanner_unverified，不置 built、不开放下载。
type CardsBuildDetail = {
  id: string
  status: 'running' | 'built' | 'failed'
  basis_revision: number
  source_hash: string
  params_hash: string
  is_current: boolean
  error_code: string | null
  targets: string[]
  artifacts: Array<{ id: string; kind: string; name: string; bytes: number; sha256: string; downloadable?: boolean }>
  validation?: { cards?: { count: number; ratio: string; entries: Array<{ name: string; width: number; height: number; sha256: string }> } }
  download_gate: { allowed: boolean; reason: string }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function CardsBuildPanel({ preview, work, canWrite }: { preview: CardsBuildPreview; work: Work; canWrite: boolean }) {
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState<CardsBuildDetail | null>(null)

  const current = preview.basis_revision === work.revision
  const blocked = !canWrite || work.locked || !current || busy || preview.cards.length === 0

  const run = async () => {
    if (blocked) return
    setBusy(true)
    setError('')
    setNotice('')
    setDetail(null)
    try {
      setStage(`正在生成 0/${preview.cards.length} 张卡片`)
      const images = await renderCXVisualCards(preview, work, (done, total) => setStage(`正在生成 ${done}/${total} 张卡片`))
      if (images.length !== preview.cards.length) throw new Error('本次渲染的卡片数与已确认计划不一致，已停止。')
      if (images.some((image) => image.overflow.length > 0)) throw new Error('有卡片缩小三档字号后仍然溢出，不能生成交付包。请先修改文案并重新预览。')
      setStage('正在打包 ZIP')
      const archive = zipStore(images.map((image) => ({ name: image.name, data: dataURLBytes(image.dataUrl) })))

      setStage('正在创建构建')
      // AI 计划预览会带报告引用；必须原样回传，服务端才能算出与预览相同的 params_hash。
      const options = { template: preview.template, ratio: preview.ratio, dna_version: preview.dna_version,
        cards: preview.cards, template_version: preview.template_version,
        ...(preview.visual_plan ? { visual_plan: preview.visual_plan } : {}) }
      const created = await post<{ build_id: string; status: string; source_hash: string; params_hash: string; reused: boolean }>(
        `/works/${work.id}/builds`, {
          basis_revision: work.revision, targets: ['xhs_cards'],
          options,
          client: 'web', renderer_contract_version: preview.template_version,
        })
      if (created.source_hash !== preview.source_hash || created.params_hash !== preview.params_hash) {
        throw new Error('服务端冻结的构建输入与本次预览不一致，已停止上传。请重新预览构建参数。')
      }
      if (created.status !== 'running') {
        setNotice(created.status === 'built' ? '已复用同一冻结版本的历史构建。' : '该构建已进入终态。')
        setDetail(await get<CardsBuildDetail>(`/builds/${created.build_id}`))
        return
      }

      setStage('正在上传交付包')
      const form = new FormData()
      form.append('kind', 'zip')
      form.append('sha256', await sha256(archive))
      form.append('file', new Blob([archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer], { type: 'application/zip' }), 'cards.zip')
      const uploaded = await (await rawRequest('POST', `/builds/${created.build_id}/artifacts`, form)).json() as { artifact_id: string }

      setStage('正在提交校验')
      try {
        await post(`/builds/${created.build_id}/complete`, {
          source_hash: created.source_hash, params_hash: created.params_hash,
          artifacts: [{ artifact_id: uploaded.artifact_id, kind: 'zip', name: 'cards.zip' }],
          renderer_receipt: { client: 'web', application_version: '0.1.0', renderer_contract_version: preview.template_version,
            chromium_version: /Chrom(?:e|ium)\/([^ )]+)/.exec(navigator.userAgent)?.[1] || 'web-browser',
            font_family: getComputedStyle(document.body).fontFamily || 'sans-serif',
            device_scale_factor: window.devicePixelRatio || 1, viewport_width: window.innerWidth, viewport_height: window.innerHeight },
        })
        setNotice('组图交付包已通过结构与像素校验。')
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== 'scanner_unverified') throw reason
        setNotice('结构与逐张像素校验已完成；隐私扫描发布规则仍待确认，服务端已阻止交付。')
      }
      setDetail(await get<CardsBuildDetail>(`/builds/${created.build_id}`))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStage('')
      setBusy(false)
    }
  }

  const cards = detail?.validation?.cards
  return <div className="space-y-3 rounded-lg border border-ink-200 bg-white p-3" data-testid="cards-build-panel">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-ink-800">交付构建（xhs_cards）</p>
        <p className="mt-1 text-[10px] text-mist-500">逐张渲染已确认的卡片并打包为 01-cover.png… 序列；服务端逐张复核尺寸与顺序。不会自动发布，也不会写入资产库。</p>
      </div>
      <Button size="sm" variant="primary" icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />}
        loading={busy} disabled={blocked} onClick={() => void run()}>生成交付构建</Button>
    </div>
    {!current && <Notice tone="gamboge">作品已变化，当前计划预览已过期。请重新读取来源并逐卡确认后再生成构建。</Notice>}
    {stage && <p role="status" className="text-[11px] text-mist-500">{stage}</p>}
    {error && <Notice tone="red">{error}</Notice>}
    {notice && <Notice tone="gamboge">{notice}</Notice>}
    {detail && <div className="space-y-2 rounded-md border border-mist-200 bg-mist-50/50 p-2 text-[11px]" data-testid="cards-build-detail">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-mist-800">构建状态：{detail.status === 'built' ? '已完成' : detail.status === 'running' ? '运行中' : '未完成'}</strong>
        <span className="text-mist-500">第 {detail.basis_revision} 版 · {detail.targets.join('、')}</span>
        {!detail.is_current && <span className="text-gamboge-700">历史快照</span>}
        {detail.error_code && <span className="text-danger">{detail.error_code}</span>}
      </div>
      {cards && <p className="text-mist-600">已校验 {cards.count} 张 · {cards.ratio} · {cards.entries.map((entry) => `${entry.name} ${entry.width}×${entry.height}`).join('，')}</p>}
      <p className="text-mist-500">下载门禁：{detail.download_gate.allowed ? '已开放' : detail.download_gate.reason}</p>
      {detail.artifacts.filter((artifact) => artifact.downloadable).map((artifact) => <div key={artifact.id} className="flex items-center justify-between gap-2">
        <span className="truncate">{artifact.name} · {artifact.bytes.toLocaleString()} 字节</span>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!detail.download_gate.allowed}
          onClick={() => void rawRequest('GET', `/builds/${detail.id}/artifacts/${artifact.id}`).then(async (response) => {
            const url = URL.createObjectURL(await response.blob())
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = artifact.name
            anchor.click()
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
          }).catch((reason) => setError(errorMessage(reason)))}>下载</Button>
      </div>)}
      <p className="break-all text-[10px] text-mist-400">source {detail.source_hash.slice(0, 12)} · params {detail.params_hash.slice(0, 12)}</p>
    </div>}
  </div>
}
