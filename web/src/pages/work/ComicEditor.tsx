import { useQuery } from '@tanstack/react-query'
import {
  Check, CheckCircle2, Circle, Copy, ImagePlus, Loader2, Sparkles, Upload, Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm } from '@/components/dialog'
import { RefsNote } from '@/components/refs'
import { Badge, Button, Card, cn, Field, HumanGate, Input, Notice, Select, Textarea } from '@/components/ui'
import { errorMessage, get, patch, post, put, rawRequest } from '@/lib/api'
import { type AIRefs, copyText, fmtTime, runeLen } from '@/lib/format'
import type { Asset, CharacterCard, ComicBubble, ComicPanel, Work } from '@/lib/types'
import { useCanWrite } from '@/lib/session'
import { useWork } from './WorkLayout'

const DIALOGUE_MAX = 30
const PANEL_COUNTS = [4, 6, 9]

type DraftPanel = Omit<ComicPanel, 'id' | 'created_at' | 'updated_at' | 'asset_id'> & {
  id?: string
  asset_id?: string | null
}

export default function ComicEditor() {
  const { work, setWork, refresh } = useWork()
  const nav = useNavigate()
  const canWrite = useCanWrite()
  const readOnly = work.locked || !canWrite
  const confirmed = !!work.outline_confirmed_at
  const { data: characters = [] } = useQuery({
    queryKey: ['characters', work.account_id],
    queryFn: () => get<CharacterCard[]>(`/accounts/${work.account_id}/characters`),
  })

  const [viewpoint, setViewpoint] = useState(work.viewpoint)
  const [title, setTitle] = useState(work.title)
  const [panelCount, setPanelCount] = useState(work.panels.length || 6)
  const [selectedChars, setSelectedChars] = useState<string[]>(() => {
    const ids = new Set<string>()
    work.panels.forEach((p) => p.character_ids.forEach((id) => ids.add(id)))
    return [...ids]
  })
  const [draft, setDraft] = useState<DraftPanel[]>(() => work.panels.map(toDraft))
  const [busy, setBusy] = useState<'gen' | 'confirm' | string | null>(null)
  const [refs, setRefs] = useState<AIRefs | null>(null)
  const [panelBusy, setPanelBusy] = useState<string | null>(null)

  useEffect(() => setViewpoint(work.viewpoint), [work.viewpoint])
  useEffect(() => setTitle(work.title), [work.title])
  useEffect(() => {
    setDraft(work.panels.map(toDraft))
    if (work.panels.length) setPanelCount(work.panels.length)
  }, [work.panels, work.revision])

  const saveViewpoint = async () => {
    if (viewpoint.trim() === work.viewpoint) return
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { viewpoint }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const saveTitle = async () => {
    if (title.trim() === work.title) return
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { title }))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const toggleChar = (id: string) => {
    setSelectedChars((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const generate = async () => {
    if (draft.length && !(await confirm({ title: '重新生成分镜？', desc: '未确认的分镜会被替换。已确认后重新生成需要再次确认分镜。', confirmText: '重新生成' }))) return
    setBusy('gen')
    try {
      const r = await post<{ panels: DraftPanel[]; refs: AIRefs }>(`/works/${work.id}/storyboard/generate`, {
        panel_count: panelCount,
        character_ids: selectedChars,
      })
      setDraft(r.panels.map((p, i) => ({ ...p, position: i + 1, image_prompt: p.image_prompt ?? '', asset_id: null })))
      setRefs(r.refs)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const confirmStoryboard = async () => {
    if (!draft.length) return
    setBusy('confirm')
    try {
      setWork(await put<Work>(`/works/${work.id}/storyboard`, { panels: draft, confirm: true }))
      toast.success('分镜已确认，可以逐格生成文案和绘图提示词')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const updateDraft = (i: number, patchPanel: Partial<DraftPanel>) => {
    setDraft((d) => d.map((p, idx) => (idx === i ? { ...p, ...patchPanel } : p)))
  }

  const savePanel = async (panel: ComicPanel, patchPanel: Record<string, unknown>) => {
    try {
      setWork(await patch<Work>(`/panels/${panel.id}`, patchPanel))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const genPanelText = async (panel: ComicPanel) => {
    setPanelBusy(panel.id)
    try {
      const r = await post<{ narration: string; dialogue: string; image_prompt: string; refs: AIRefs }>(`/panels/${panel.id}/text`)
      setRefs(r.refs)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPanelBusy(null)
    }
  }

  const uploadPanel = async (panel: ComicPanel, file: File) => {
    setPanelBusy(panel.id + ':up')
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await rawRequest('POST', `/works/${work.id}/assets`, fd)
      const a = (await res.json()) as Asset
      setWork(await patch<Work>(`/panels/${panel.id}`, { asset_id: a.id }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPanelBusy(null)
    }
  }

  const charName = (id: string) => characters.find((c) => c.id === id)?.name ?? '角色'
  const withImages = work.panels.filter((p) => p.asset_id).length
  const steps = [
    { id: 'step-viewpoint', label: '核心观点', done: !!work.viewpoint.trim() },
    { id: 'step-chars', label: '角色选择', done: selectedChars.length > 0 || characters.length === 0 },
    { id: 'step-storyboard', label: '分镜脚本', done: confirmed },
    { id: 'step-panels', label: '逐格文案', done: confirmed && work.panels.every((p) => p.narration || p.dialogue) },
    { id: 'step-images', label: '回传图片', done: work.panels.length > 0 && withImages === work.panels.length },
  ]
  const toCheck = () => nav(`/works/${work.id}/check?start=1`)
  const editingDraft = !confirmed || draft.some((p, i) => {
    const cur = work.panels[i]
    return !cur || p.scene !== cur.scene || p.action !== cur.action
  })

  return (
    <div className="mx-auto flex w-full max-w-[1280px] gap-8 px-6 py-8">
      <aside className="sticky top-24 hidden h-fit w-52 shrink-0 lg:block">
        <div className="mb-3 text-[11px] font-semibold tracking-wider text-mist-400">漫画步骤</div>
        <ol className="space-y-0.5">
          {steps.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-mist-600 hover:bg-mist-100 hover:text-mist-900">
                {s.done ? <CheckCircle2 className="size-4 text-ink-500" /> : <Circle className="size-4 text-mist-300" />}
                <span>{s.label}</span>
              </a>
            </li>
          ))}
        </ol>
        {!readOnly && (
          <Button variant="primary" className="mt-6 w-full" onClick={toCheck} disabled={withImages === 0}>
            提交检查
          </Button>
        )}
        {work.platform === 'wechat_mp' && (
          <p className="mt-3 text-[11px] leading-relaxed text-mist-400">检查通过后可写入公众号图片消息草稿（newspic）。</p>
        )}
      </aside>

      <div className="min-w-0 flex-1 space-y-5">
        <Card className="flex flex-wrap items-end gap-4 p-5">
          <Field label="作品标题" className="min-w-[240px] flex-1">
            <Input value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} placeholder="漫画标题" />
          </Field>
          <Field label="格数">
            <Select value={String(panelCount)} disabled={readOnly || confirmed} onChange={(e) => setPanelCount(Number(e.target.value))}>
              {PANEL_COUNTS.map((n) => <option key={n} value={n}>{n} 格</option>)}
            </Select>
          </Field>
          <div className="text-[13px] text-mist-500">
            引用角色：{selectedChars.length ? selectedChars.map(charName).join('、') : '未选'}
          </div>
        </Card>

        <Card id="step-viewpoint" className="scroll-mt-24 p-5">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">核心观点</h2>
            <Badge tone="gamboge">H-02 必须由你来写</Badge>
          </div>
          <Textarea rows={3} value={viewpoint} disabled={readOnly} onChange={(e) => setViewpoint(e.target.value)} onBlur={saveViewpoint}
            placeholder="用一两句话写下这组漫画要表达的观点。AI 会围绕它生成分镜，不会替你决定立场。"
            className="font-display text-[16px] leading-relaxed" />
        </Card>

        <Card id="step-chars" className="scroll-mt-24 p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-[17px] font-bold text-mist-900">角色选择</h2>
              <Badge>{selectedChars.length} 个</Badge>
            </div>
            <Link to={`/a/${work.account_id}/profile?tab=characters`} className="text-[13px] text-ink-600 underline">管理角色卡</Link>
          </div>
          {characters.length === 0 ? (
            <Notice tone="gamboge">还没有角色设定卡。可以先去账号档案创建，也可以直接生成分镜（不引用角色外貌）。</Notice>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {characters.map((c) => {
                const on = selectedChars.includes(c.id)
                return (
                  <button key={c.id} type="button" disabled={readOnly} onClick={() => toggleChar(c.id)}
                    className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition',
                      on ? 'border-ink-400 bg-ink-50/50' : 'border-mist-200 hover:border-mist-300')}>
                    {(c.ref_url || c.ref_asset_id) ? (
                      <img src={c.ref_url || `/api/v1/assets/${c.ref_asset_id}/file`} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                    ) : (
                      <Users className={cn('mt-0.5 size-4', on ? 'text-ink-600' : 'text-mist-400')} />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium text-mist-800">{c.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-mist-500">{c.appearance || c.personality || '未填写外貌/性格'}</div>
                    </div>
                    {on && <Check className="ml-auto size-4 text-ink-600" />}
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        <Card id="step-storyboard" className="scroll-mt-24 p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">分镜脚本</h2>
            {confirmed ? <Badge tone="green">已确认</Badge> : <Badge tone="gamboge">H-03 需确认</Badge>}
            <div className="ml-auto flex gap-2">
              {!readOnly && (
                <Button size="sm" variant="secondary" loading={busy === 'gen'} disabled={!work.viewpoint.trim()}
                  onClick={generate} icon={<Sparkles className="size-3.5" />}>生成分镜</Button>
              )}
              {!readOnly && draft.length > 0 && !confirmed && (
                <Button size="sm" variant="primary" loading={busy === 'confirm'} onClick={confirmStoryboard}>确认分镜</Button>
              )}
            </div>
          </div>
          {!work.viewpoint.trim() && <HumanGate code="H-02">写下核心观点后，才能生成分镜。</HumanGate>}
          {refs && <div className="mb-3"><RefsNote refs={refs} /></div>}
          {draft.length === 0 ? (
            <p className="rounded-lg border border-dashed border-mist-200 px-4 py-8 text-center text-sm text-mist-400">生成分镜后，这里会列出每一格的场景、角色、动作和镜头。</p>
          ) : (
            <div className="space-y-3">
              {draft.map((p, i) => (
                <div key={p.id ?? i} className="rounded-xl border border-mist-200 p-4">
                  <div className="mb-2 text-[13px] font-semibold text-mist-700">格 {p.position}</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="场景"><Textarea rows={2} disabled={readOnly || confirmed} value={p.scene} onChange={(e) => updateDraft(i, { scene: e.target.value })} /></Field>
                    <Field label="动作"><Textarea rows={2} disabled={readOnly || confirmed} value={p.action} onChange={(e) => updateDraft(i, { action: e.target.value })} /></Field>
                    <Field label="镜头"><Input disabled={readOnly || confirmed} value={p.shot} onChange={(e) => updateDraft(i, { shot: e.target.value })} /></Field>
                    <Field label="出场角色">
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {(p.character_ids ?? []).map((id) => <Badge key={id}>{charName(id)}</Badge>)}
                        {(p.character_ids ?? []).length === 0 && <span className="text-xs text-mist-400">未指定</span>}
                      </div>
                    </Field>
                  </div>
                </div>
              ))}
              {!readOnly && confirmed && editingDraft && (
                <Notice tone="gamboge">分镜已确认。若要大改结构，请重新生成分镜并再次确认。</Notice>
              )}
            </div>
          )}
        </Card>

        <section id="step-panels" className="scroll-mt-24 space-y-4">
          <div className="flex items-center gap-2 pt-2">
            <h2 className="font-display text-[17px] font-bold text-mist-900">逐格文案与回传</h2>
            <span className="text-xs text-mist-400">对白建议不超过 {DIALOGUE_MAX} 字 · 可 AI 出图或回传外部图</span>
          </div>
          {!confirmed ? (
            <HumanGate code="H-03">确认分镜后，才能生成逐格文案和绘图提示词。</HumanGate>
          ) : (
            work.panels.map((panel) => {
              const asset = work.assets.find((a) => a.id === panel.asset_id)
              return (
                <Card key={panel.id} id="step-images" className="p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-mist-800">格 {panel.position}</span>
                    <span className="text-xs text-mist-400">{panel.scene || '（无场景）'}</span>
                    <div className="ml-auto flex gap-2">
                      {!readOnly && (
                        <Button size="sm" variant="secondary" loading={panelBusy === panel.id}
                          onClick={() => genPanelText(panel)} icon={<Sparkles className="size-3.5" />}>生成文案</Button>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
                    <div className="space-y-3">
                      <Field label="旁白">
                        <Textarea rows={2} disabled={readOnly} defaultValue={panel.narration}
                          onBlur={(e) => { if (e.target.value !== panel.narration) void savePanel(panel, { narration: e.target.value }) }} />
                      </Field>
                      <Field label="对白" counter={{ value: runeLen(panel.dialogue), max: DIALOGUE_MAX }}
                        hint={runeLen(panel.dialogue) > DIALOGUE_MAX ? '偏长，气泡可能放不下' : undefined}>
                        <Textarea rows={2} disabled={readOnly} defaultValue={panel.dialogue}
                          className={cn(runeLen(panel.dialogue) > DIALOGUE_MAX && 'border-gamboge-300')}
                          onBlur={(e) => { if (e.target.value !== panel.dialogue) void savePanel(panel, { dialogue: e.target.value }) }} />
                      </Field>
                      <Field label="绘图提示词" hint="已自动拼入角色外貌；可 AI 出图或外部出图后回传">
                        <div className="flex flex-col gap-2">
                          <Textarea rows={3} disabled={readOnly} className="flex-1" defaultValue={panel.image_prompt}
                            onBlur={(e) => { if (e.target.value !== panel.image_prompt) void savePanel(panel, { image_prompt: e.target.value }) }} />
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="ghost" disabled={!panel.image_prompt}
                              onClick={async () => { await copyText(panel.image_prompt); toast.success('提示词已复制') }}
                              icon={<Copy className="size-3.5" />}>复制</Button>
                            {!readOnly && (
                              <Button size="sm" variant="secondary" loading={panelBusy === panel.id + ':ai'}
                                disabled={!panel.image_prompt}
                                onClick={async () => {
                                  setPanelBusy(panel.id + ':ai')
                                  try {
                                    await post(`/panels/${panel.id}/generate-image`, { prompt: panel.image_prompt })
                                    toast.success('已生成（含 AI 标识）')
                                    await refresh()
                                  } catch (e) {
                                    toast.error(errorMessage(e))
                                  } finally {
                                    setPanelBusy(null)
                                  }
                                }}
                                icon={<Sparkles className="size-3.5" />}>AI 出图</Button>
                            )}
                          </div>
                        </div>
                      </Field>
                      {!readOnly && (panel.narration || panel.dialogue) && (
                        <Button size="sm" variant="ghost" onClick={async () => {
                          const bubbles = [] as ComicBubble[]
                          if (panel.narration.trim()) bubbles.push({ text: panel.narration.trim(), x: 0.05, y: 0.05, w: 0.9, h: 0.18 })
                          if (panel.dialogue.trim()) bubbles.push({ text: panel.dialogue.trim(), x: 0.1, y: 0.65, w: 0.8, h: 0.28 })
                          try {
                            await put(`/panels/${panel.id}/bubbles`, { bubbles })
                            toast.success('已按旁白/对白排气泡；可在图上拖动调整')
                            await refresh()
                          } catch (e) { toast.error(errorMessage(e)) }
                        }}>按文案排气泡</Button>
                      )}
                    </div>
                    <div>
                      <div className="mb-1.5 text-[12.5px] font-medium text-mist-600">回传 / AI 图片{!readOnly && (panel.bubbles?.length ?? 0) > 0 ? ' · 拖动气泡可调整' : ''}</div>
                      {asset ? (
                        <div className="overflow-hidden rounded-lg border border-mist-200">
                          <div className="relative">
                            <img src={asset.url} alt="" className="aspect-square w-full object-cover" />
                            <PanelBubbles
                              panelId={panel.id}
                              bubbles={panel.bubbles ?? []}
                              readOnly={readOnly}
                              onSaved={async () => { await refresh() }}
                            />
                          </div>
                          {asset.ai_generated && <div className="bg-mist-900/80 px-2 py-1 text-center text-[10px] text-white">AI 生成</div>}
                          {!readOnly && (
                            <label className="flex cursor-pointer items-center justify-center gap-1.5 border-t border-mist-100 py-2 text-xs text-mist-600 hover:bg-mist-50">
                              <Upload className="size-3.5" />更换
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0]
                                if (f) void uploadPanel(panel, f)
                              }} />
                            </label>
                          )}
                        </div>
                      ) : (
                        <label className={cn('flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-mist-200 text-mist-400 hover:border-ink-300 hover:text-ink-600',
                          readOnly && 'pointer-events-none opacity-50')}>
                          {panelBusy === panel.id + ':up' ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
                          <span className="text-xs">上传本格图片</span>
                          <input type="file" accept="image/*" className="hidden" disabled={readOnly} onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) void uploadPanel(panel, f)
                          }} />
                        </label>
                      )}
                    </div>
                  </div>
                </Card>
              )
            })
          )}
        </section>

        {!readOnly && (
          <div className="flex justify-end pb-10 lg:hidden">
            <Button variant="primary" onClick={toCheck} disabled={withImages === 0}>提交检查</Button>
          </div>
        )}
        {work.locked && <Notice tone="gray">作品已发布，当前为只读模式。</Notice>}
        <p className="pb-6 text-center text-xs text-mist-400">上次保存 {fmtTime(work.updated_at)}</p>
      </div>
    </div>
  )
}

function toDraft(p: ComicPanel): DraftPanel {
  return {
    id: p.id,
    position: p.position,
    scene: p.scene,
    character_ids: p.character_ids,
    action: p.action,
    shot: p.shot,
    narration: p.narration,
    dialogue: p.dialogue,
    image_prompt: p.image_prompt,
    asset_id: p.asset_id,
  }
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n))
}

function PanelBubbles({
  panelId, bubbles, readOnly, onSaved,
}: {
  panelId: string
  bubbles: ComicBubble[]
  readOnly: boolean
  onSaved: () => Promise<void> | void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [local, setLocal] = useState(bubbles)
  const localRef = useRef(bubbles)
  const drag = useRef<{ i: number; ox: number; oy: number; sx: number; sy: number } | null>(null)
  useEffect(() => {
    setLocal(bubbles)
    localRef.current = bubbles
  }, [bubbles])

  const persist = async (next: ComicBubble[]) => {
    try {
      await put(`/panels/${panelId}/bubbles`, { bubbles: next })
      await onSaved()
    } catch (e) {
      toast.error(errorMessage(e))
      setLocal(bubbles)
      localRef.current = bubbles
    }
  }

  if (local.length === 0) return null
  return (
    <div ref={boxRef} className="absolute inset-0">
      {local.map((b, bi) => (
        <div
          key={bi}
          className={cn(
            'absolute overflow-hidden rounded-2xl border border-mist-900/20 bg-white/90 px-1.5 py-1 text-[10px] leading-snug text-mist-800 shadow-sm',
            readOnly ? 'pointer-events-none' : 'cursor-grab touch-none active:cursor-grabbing',
          )}
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
          onPointerDown={readOnly ? undefined : (e) => {
            e.preventDefault()
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
            drag.current = { i: bi, ox: b.x, oy: b.y, sx: e.clientX, sy: e.clientY }
          }}
          onPointerMove={readOnly ? undefined : (e) => {
            const d = drag.current
            const box = boxRef.current
            if (!d || d.i !== bi || !box) return
            const rect = box.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return
            const nx = clamp01(d.ox + (e.clientX - d.sx) / rect.width)
            const ny = clamp01(d.oy + (e.clientY - d.sy) / rect.height)
            const maxX = clamp01(1 - b.w)
            const maxY = clamp01(1 - b.h)
            const next = localRef.current.map((x, i) => (i === bi ? { ...x, x: Math.min(maxX, nx), y: Math.min(maxY, ny) } : x))
            localRef.current = next
            setLocal(next)
          }}
          onPointerUp={readOnly ? undefined : () => {
            if (!drag.current || drag.current.i !== bi) return
            drag.current = null
            void persist(localRef.current)
          }}
        >
          {b.text}
        </div>
      ))}
    </div>
  )
}
