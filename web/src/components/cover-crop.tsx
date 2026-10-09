import { useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Dialog } from './dialog'
import { Button, cn } from './ui'
import type { CropBox } from '@/lib/types'

const ratios = [
  { key: '2.35_1', label: '消息列表大图', aspect: 2.35 },
  { key: '1_1', label: '转发卡片小图', aspect: 1 },
] as const

function centered(aspect: number, w: number, h: number): CropBox {
  const imgAspect = w / h
  if (imgAspect > aspect) {
    const cw = aspect / imgAspect
    return { x1: (1 - cw) / 2, y1: 0, x2: (1 + cw) / 2, y2: 1 }
  }
  const ch = imgAspect / aspect
  return { x1: 0, y1: (1 - ch) / 2, x2: 1, y2: (1 + ch) / 2 }
}

export function defaultCrops(w: number, h: number): Record<string, CropBox> {
  return { '2.35_1': centered(2.35, w, h), '1_1': centered(1, w, h) }
}

export function CropPreview({ src, box, aspect, className }: { src: string; box: CropBox; aspect: number; className?: string }) {
  const w = box.x2 - box.x1
  const h = box.y2 - box.y1
  return (
    <div className={cn('overflow-hidden bg-mist-100', className)} style={{ aspectRatio: String(aspect) }}>
      <div className="relative size-full overflow-hidden">
        <img src={src} alt="" className="absolute max-w-none"
          style={{ width: `${100 / w}%`, height: `${100 / h}%`, left: `${(-box.x1 / w) * 100}%`, top: `${(-box.y1 / h) * 100}%` }} />
      </div>
    </div>
  )
}

export function CoverCropDialog({ open, onClose, src, width, height, initial, onSave }: {
  open: boolean
  onClose: () => void
  src: string
  width: number
  height: number
  initial: Record<string, CropBox> | null
  onSave: (crops: Record<string, CropBox>) => void
}) {
  const [active, setActive] = useState<(typeof ratios)[number]['key']>('2.35_1')
  const [boxes, setBoxes] = useState<Record<string, CropBox>>(initial ?? defaultCrops(width, height))
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const r = ratios.find((x) => x.key === active)!
  const initialArea = (() => {
    const b = boxes[active]
    return { x: b.x1 * 100, y: b.y1 * 100, width: (b.x2 - b.x1) * 100, height: (b.y2 - b.y1) * 100 }
  })()
  const onComplete = (a: Area) => {
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    setBoxes((prev) => ({ ...prev, [active]: { x1: clamp(a.x / 100), y1: clamp(a.y / 100), x2: clamp((a.x + a.width) / 100), y2: clamp((a.y + a.height) / 100) } }))
  }
  return (
    <Dialog open={open} onClose={onClose} title="调整封面裁剪" desc="公众号会按这两个区域分别裁剪封面：消息列表里的大图（2.35:1）和转发时的小图（1:1）。" width="max-w-3xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={() => onSave(boxes)}>保存裁剪</Button></>}>
      <div className="grid gap-5 md:grid-cols-[1fr_220px]">
        <div>
          <div className="mb-3 inline-flex rounded-lg bg-mist-100 p-1">
            {ratios.map((x) => (
              <button key={x.key} onClick={() => { setActive(x.key); setZoom(1); setCrop({ x: 0, y: 0 }) }}
                className={cn('h-7 cursor-pointer rounded-md px-3 text-[13px] font-medium', active === x.key ? 'bg-white shadow-sm' : 'text-mist-500')}>
                {x.key.replace('_', ':')} {x.label}
              </button>
            ))}
          </div>
          <div className="relative h-[340px] overflow-hidden rounded-xl bg-mist-900">
            <Cropper key={active} image={src} aspect={r.aspect} crop={crop} zoom={zoom} onCropChange={setCrop} onZoomChange={setZoom}
              onCropComplete={(area) => onComplete(area)} initialCroppedAreaPercentages={initialArea} objectFit="contain" />
          </div>
          <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="mt-3 w-full accent-ink-600" aria-label="缩放" />
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-mist-500">消息列表大图</div>
            <div className="overflow-hidden rounded-lg border border-mist-200 bg-white">
              <CropPreview src={src} box={boxes['2.35_1']} aspect={2.35} />
              <div className="px-2.5 py-2 text-[12.5px] font-semibold leading-snug text-mist-800">文章标题会显示在这里</div>
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-mist-500">转发卡片小图</div>
            <div className="flex items-center gap-2.5 rounded-lg border border-mist-200 bg-white p-2.5">
              <div className="min-w-0 flex-1 text-[12px] leading-snug text-mist-700">文章标题会显示在这里，两行以内</div>
              <CropPreview src={src} box={boxes['1_1']} aspect={1} className="w-12 shrink-0 rounded" />
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
