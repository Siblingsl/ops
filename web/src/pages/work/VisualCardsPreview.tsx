import { Image as ImageIcon, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Notice } from '@/components/ui'
import type { Work } from '@/lib/types'
import { renderCXVisualCards, type CXVisualCardPreview, type RenderedCXVisualCard } from './cx-visual-cards-render'

export function VisualCardsPreview({ preview, work }: { preview: CXVisualCardPreview; work: Work }) {
  const [rendered, setRendered] = useState<RenderedCXVisualCard[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setRendered([])
    setError('')
  }, [preview])

  const render = async () => {
    if (busy || preview.basis_revision !== work.revision) return
    setBusy(true)
    setError('')
    setRendered([])
    setProgress(`正在生成 0/${preview.cards.length}`)
    try {
      const images = await renderCXVisualCards(preview, work, (done, total) => setProgress(`正在生成 ${done}/${total}`))
      setRendered(images)
      setProgress('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '组图预览生成失败。')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  const current = preview.basis_revision === work.revision
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-ink-200 bg-ink-50/30 p-3" data-testid="visual-cards-local-preview">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-ink-800">本机栅格预览 · 1080 × {preview.ratio === '1:1' ? 1080 : preview.ratio === '3:4' ? 1440 : 1920}</p>
          <p className="mt-1 text-[10px] text-mist-500">逐张等待系统字体和图片解码，再按三档字号检查溢出。未创建构建、ZIP 文件或下载。</p>
        </div>
        <Button size="sm" variant="secondary" icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
          loading={busy} disabled={!current || preview.cards.length === 0} onClick={() => void render()}>
          生成本地组图预览
        </Button>
      </div>
      {!current && <Notice tone="gamboge">作品已变化，当前计划预览已过期。请重新读取来源并逐卡确认后再预览。</Notice>}
      {progress && <p role="status" className="text-[11px] text-mist-500">{progress}</p>}
      {error && <Notice tone="red">{error}</Notice>}
      {rendered.some((image) => image.overflow.length > 0) && <Notice tone="gamboge">
        有卡片在三档字号调整后仍溢出。完整文案保留在上方计划中，请编辑后重新预览；溢出卡片未开放交付。
      </Notice>}
      {rendered.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rendered.map((image, index) => <figure key={`${preview.params_hash}-${image.name}`} className="min-w-0 rounded-md border border-mist-200 bg-white p-2">
          <img data-testid="visual-card-rendered-image" src={image.dataUrl} alt={`组图预览 ${index + 1}`} className="mx-auto block max-h-[420px] w-auto max-w-full object-contain" />
          <figcaption className="mt-2 flex justify-between gap-2 text-[10px] text-mist-500">
            <span>{image.name}</span><span>{image.width} × {image.height}</span>
          </figcaption>
          {image.overflow.length > 0 && <p className="mt-1 text-[10px] text-rose-700">{image.overflow.join('；')}</p>}
        </figure>)}
      </div>}
      {rendered.length > 0 && <p className="text-[10px] text-mist-400">本地预览不会创建构建、ZIP 文件或下载。</p>}
    </div>
  )
}
