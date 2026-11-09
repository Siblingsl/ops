import { ImagePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage, rawRequest } from '@/lib/api'
import type { Asset } from '@/lib/types'
import { Dialog } from './dialog'
import { Button, cn, Field, Input, Notice, Textarea } from './ui'

// 小红书文字卡片（EX-F-03）：前端 Canvas 渲染，导出 1242×1656（3:4）PNG。

export const CARD_W = 1242
export const CARD_H = 1656

export type CardTemplate = 'solid' | 'gradient' | 'note' | 'list' | 'compare' | 'quote'

export const cardTemplates: { id: CardTemplate; label: string }[] = [
  { id: 'solid', label: '纯色大字' },
  { id: 'gradient', label: '渐变' },
  { id: 'note', label: '便签' },
  { id: 'list', label: '清单' },
  { id: 'compare', label: '对比' },
  { id: 'quote', label: '引用' },
]

const palette = ['#e8473b', '#1f6f5c', '#2f54eb', '#f2a516', '#7a4cc2', '#222222']

export interface CardSpec { title: string; body: string; template: CardTemplate; color: string }

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",sans-serif'

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (const ch of para) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        lines.push(cur)
        cur = ch
      } else cur += ch
    }
    lines.push(cur)
  }
  return lines
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, lh: number, maxLines: number, align: CanvasTextAlign = 'left') {
  ctx.textAlign = align
  const shown = lines.slice(0, maxLines)
  if (lines.length > maxLines && shown.length) shown[shown.length - 1] = shown[shown.length - 1].slice(0, -1) + '…'
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lh))
  return y + shown.length * lh
}

function lighten(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (s: number) => Math.min(255, Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * amt))
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}

export function drawCard(canvas: HTMLCanvasElement, c: CardSpec) {
  canvas.width = CARD_W
  canvas.height = CARD_H
  const ctx = canvas.getContext('2d')!
  ctx.textBaseline = 'top'
  const pad = 110
  const inner = CARD_W - pad * 2
  const title = c.title.trim()
  const body = c.body.trim()
  switch (c.template) {
    case 'solid':
    case 'gradient': {
      if (c.template === 'solid') ctx.fillStyle = c.color
      else {
        const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H)
        g.addColorStop(0, c.color)
        g.addColorStop(1, lighten(c.color, 0.55))
        ctx.fillStyle = g
      }
      ctx.fillRect(0, 0, CARD_W, CARD_H)
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold 120px ${FONT}`
      const tl = wrap(ctx, title, inner)
      const th = Math.min(tl.length, 5) * 160
      ctx.font = `48px ${FONT}`
      const bl = wrap(ctx, body, inner)
      const bh = Math.min(bl.length, 8) * 76
      let y = (CARD_H - th - (body ? bh + 80 : 0)) / 2
      ctx.font = `bold 120px ${FONT}`
      y = drawLines(ctx, tl, CARD_W / 2, y, 160, 5, 'center')
      if (body) {
        ctx.globalAlpha = 0.9
        ctx.font = `48px ${FONT}`
        drawLines(ctx, bl, CARD_W / 2, y + 80, 76, 8, 'center')
        ctx.globalAlpha = 1
      }
      break
    }
    case 'note': {
      ctx.fillStyle = '#fbf6e6'
      ctx.fillRect(0, 0, CARD_W, CARD_H)
      ctx.strokeStyle = 'rgba(0,0,0,0.07)'
      ctx.lineWidth = 3
      for (let y = 420; y < CARD_H - 100; y += 92) {
        ctx.beginPath()
        ctx.moveTo(pad, y + 74)
        ctx.lineTo(CARD_W - pad, y + 74)
        ctx.stroke()
      }
      ctx.fillStyle = c.color
      ctx.fillRect(pad, 150, 18, 160)
      ctx.fillStyle = '#2b2b2b'
      ctx.font = `bold 92px ${FONT}`
      drawLines(ctx, wrap(ctx, title, inner - 60), pad + 60, 160, 120, 2)
      ctx.fillStyle = '#3a3a3a'
      ctx.font = `50px ${FONT}`
      drawLines(ctx, wrap(ctx, body, inner), pad, 430, 92, 12)
      break
    }
    case 'list': {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, CARD_W, CARD_H)
      ctx.fillStyle = c.color
      ctx.fillRect(0, 0, CARD_W, 360)
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold 96px ${FONT}`
      drawLines(ctx, wrap(ctx, title, inner), pad, 110, 124, 2)
      const items = body.split(/\n|；|;/).map((s) => s.trim()).filter(Boolean).slice(0, 7)
      let y = 450
      for (const [i, it] of items.entries()) {
        ctx.fillStyle = c.color
        ctx.beginPath()
        ctx.arc(pad + 34, y + 34, 34, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.font = `bold 40px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(String(i + 1), pad + 34, y + 12)
        ctx.fillStyle = '#2b2b2b'
        ctx.font = `48px ${FONT}`
        y = drawLines(ctx, wrap(ctx, it, inner - 110), pad + 110, y + 6, 70, 2) + 50
      }
      break
    }
    case 'compare': {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, CARD_W, CARD_H)
      ctx.fillStyle = '#2b2b2b'
      ctx.font = `bold 92px ${FONT}`
      drawLines(ctx, wrap(ctx, title, inner), CARD_W / 2, 120, 120, 2, 'center')
      const [l, r] = body.includes('|') ? body.split('|') : [body.split('\n')[0] ?? '', body.split('\n').slice(1).join('\n')]
      const colW = (CARD_W - pad * 2 - 40) / 2
      const top = 420
      ctx.fillStyle = lighten(c.color, 0.85)
      ctx.fillRect(pad, top, colW, CARD_H - top - 140)
      ctx.fillStyle = '#f2f2f2'
      ctx.fillRect(pad + colW + 40, top, colW, CARD_H - top - 140)
      ctx.font = `46px ${FONT}`
      ctx.fillStyle = c.color
      drawLines(ctx, wrap(ctx, (l ?? '').trim(), colW - 80), pad + 40, top + 60, 72, 13)
      ctx.fillStyle = '#555555'
      drawLines(ctx, wrap(ctx, (r ?? '').trim(), colW - 80), pad + colW + 80, top + 60, 72, 13)
      break
    }
    case 'quote': {
      ctx.fillStyle = '#f7f5f0'
      ctx.fillRect(0, 0, CARD_W, CARD_H)
      ctx.fillStyle = c.color
      ctx.font = `bold 360px Georgia, serif`
      ctx.textAlign = 'left'
      ctx.fillText('“', pad - 20, 140)
      ctx.fillStyle = '#222222'
      ctx.font = `bold 76px ${FONT}`
      const y = drawLines(ctx, wrap(ctx, body || title, inner), pad, 560, 116, 7)
      if (body && title) {
        ctx.fillStyle = '#777777'
        ctx.font = `44px ${FONT}`
        drawLines(ctx, wrap(ctx, `—— ${title}`, inner), CARD_W - pad, y + 60, 64, 2, 'right')
      }
      break
    }
  }
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出图片失败'))), 'image/png'))
}

function CardPreview({ spec, className }: { spec: CardSpec; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawCard(ref.current, spec)
  }, [spec])
  return <canvas ref={ref} className={cn('aspect-[3/4] w-full rounded-lg border border-mist-200', className)} />
}

/** XhsCardMaker turns page suggestions (or typed text) into 3:4 text cards, one card at a time. */
export function XhsCardMaker({ workId, pages, open, onClose, onAdded, warn }: {
  workId: string
  pages?: { title: string; body: string }[] | null
  open: boolean
  onClose: () => void
  onAdded: (a: Asset) => void
  warn?: string
}) {
  const [cards, setCards] = useState<CardSpec[]>([])
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const src = pages?.length ? pages : [{ title: '', body: '' }]
    setCards(src.map((p, i) => ({ title: p.title, body: p.body, template: i === 0 ? 'solid' : 'list', color: palette[0] })))
    setIdx(0)
  }, [open, pages])
  const cur = cards[idx]
  const set = (p: Partial<CardSpec>) => setCards(cards.map((c, i) => (i === idx ? { ...c, ...p } : c)))
  const add = async () => {
    if (!cur) return
    setBusy(true)
    try {
      const cv = document.createElement('canvas')
      drawCard(cv, cur)
      const blob = await canvasBlob(cv)
      const fd = new FormData()
      fd.append('file', new File([blob], `card-${idx + 1}.png`, { type: 'image/png' }))
      const res = await rawRequest('POST', `/works/${workId}/assets`, fd)
      onAdded((await res.json()) as Asset)
      toast.success(`第 ${idx + 1} 张卡片已加入作品图片`)
      if (idx < cards.length - 1) setIdx(idx + 1)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="生成文字卡片" desc="3:4 竖图（1242×1656），每次导出一张并加入作品图片，参与 1–18 张检查。" width="max-w-4xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>完成</Button>
        <Button variant="primary" loading={busy} disabled={!cur || (!cur.title.trim() && !cur.body.trim())} icon={<ImagePlus className="size-4" />} onClick={add}>导出这张并加入图片</Button>
      </>}>
      {warn && <Notice tone="gamboge" className="mb-3">{warn}</Notice>}
      {cur && (
        <div className="grid gap-5 md:grid-cols-[280px_1fr]">
          <div>
            <CardPreview spec={cur} />
            {cards.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {cards.map((_, i) => (
                  <button key={i} type="button" onClick={() => setIdx(i)}
                    className={cn('size-7 cursor-pointer rounded text-[12px]', i === idx ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200')}>{i + 1}</button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-4">
            <Field label="模板">
              <div className="flex flex-wrap gap-1.5">
                {cardTemplates.map((t) => (
                  <button key={t.id} type="button" onClick={() => set({ template: t.id })}
                    className={cn('cursor-pointer rounded-md border px-2.5 py-1 text-[12.5px]', cur.template === t.id ? 'border-ink-400 bg-ink-50 text-ink-800' : 'border-mist-200 text-mist-600 hover:border-mist-300')}>{t.label}</button>
                ))}
              </div>
            </Field>
            <Field label="主色">
              <div className="flex items-center gap-1.5">
                {palette.map((c) => (
                  <button key={c} type="button" onClick={() => set({ color: c })} title={c}
                    className={cn('size-7 cursor-pointer rounded-full border-2', cur.color === c ? 'border-mist-900' : 'border-white shadow')} style={{ background: c }} />
                ))}
                <Input type="color" value={cur.color} onChange={(e) => set({ color: e.target.value })} className="h-8 w-12 p-0.5" />
              </div>
            </Field>
            <Field label="标题"><Input value={cur.title} onChange={(e) => set({ title: e.target.value })} /></Field>
            <Field label="正文" hint={cur.template === 'list' ? '每行一条要点' : cur.template === 'compare' ? '用 | 分隔左右两栏，或第一行为左栏' : undefined}>
              <Textarea rows={6} value={cur.body} onChange={(e) => set({ body: e.target.value })} />
            </Field>
            <Button size="sm" variant="ghost" onClick={() => { setCards([...cards, { title: '', body: '', template: cur.template, color: cur.color }]); setIdx(cards.length) }}>再加一张</Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
