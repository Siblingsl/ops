import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Crop, ImagePlus, Images, Loader2, Sparkles, Star, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { AssetCropDialog, CoverCropDialog, CropPreview, defaultCrops } from '@/components/cover-crop'
import { confirm, Dialog } from '@/components/dialog'
import { Button, Card, cn, Input, Select, Spinner } from '@/components/ui'
import { XhsCardMaker } from '@/components/xhs-cards'
import { aiError } from '@/lib/ai-error'
import { del, errorMessage, get, patch, post } from '@/lib/api'
import type { Asset, CropBox, LibraryAsset, Work } from '@/lib/types'
import { waitJob } from '@/lib/v3'

// ---------- 配图与封面 ----------

export function ImagesCard({ work, setWork, readOnly, upload }: { work: Work; setWork: (w: Work) => void; readOnly: boolean; upload: (f: File) => Promise<Asset | null> }) {
  const wx = work.platform === 'wechat_mp'
  const xhs = work.platform === 'xhs'
  const toutiao = work.platform === 'toutiao'
  const [cropFor, setCropFor] = useState<Asset | null>(null)
  const [ratioCrop, setRatioCrop] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(0)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cover = work.assets.find((a) => a.id === work.cover_asset_id)
  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const list = Array.from(files)
    setUploading(list.length)
    for (const f of list) {
      await upload(f)
      setUploading((n) => n - 1)
    }
  }
  const move = async (a: Asset, d: number) => {
    const list = await patch<Asset[]>(`/assets/${a.id}`, { position: a.position + d })
    setWork({ ...work, assets: list })
  }
  const remove = async (a: Asset) => {
    if (!(await confirm({ title: '删除这张图片？', desc: a.id === work.cover_asset_id ? '它是当前封面，删除后需要重新设置封面。' : '正文中引用这张图片的地方会显示为空。', confirmText: '删除', danger: true }))) return
    await del(`/assets/${a.id}`)
    setWork(await get<Work>(`/works/${work.id}`))
  }
  const [coverInit, setCoverInit] = useState<Record<string, CropBox> | null>(null)
  const [library, setLibrary] = useState(false)
  const [cardMaker, setCardMaker] = useState(false)
  // DEV-A108（13 文档）：AI 生成封面候选——复用文生图链路，人工挑选后走既有封面裁剪流程。
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverCands, setCoverCands] = useState<Asset[] | null>(null)
  const genCover = async () => {
    // NW-B7：标题和观点都为空时不能发空主题请求。
    const theme = (work.title || work.viewpoint).trim()
    if (!theme) {
      toast.info('先写下标题或核心观点，再让 AI 生成封面')
      return
    }
    setCoverBusy(true)
    try {
      const base = `公众号封面插图：围绕「${theme.slice(0, 24)}」的主题画面，构图简洁、留出文字空间，画面中不出现文字。`
      const cands: Asset[] = []
      for (let i = 0; i < 3; i++) {
        const { job_id } = await post<{ job_id: string }>(`/works/${work.id}/generate-image`, { prompt: `${base}（构图方案 ${i + 1}）`, background: true })
        cands.push(await waitJob<Asset>(job_id))
      }
      setCoverCands(cands)
      setWork(await get<Work>(`/works/${work.id}`))
      toast.success('已生成 3 张封面候选')
    } catch (e) {
      aiError(e, '生成封面候选')
    } finally {
      setCoverBusy(false)
    }
  }
  const setCover = async (a: Asset) => {
    let init = a.id === work.cover_asset_id && work.cover_crops ? work.cover_crops : null
    if (!init) {
      try {
        const r = await get<{ crops: Record<string, CropBox> }>(`/assets/${a.id}/smart-crop?aspects=2.35:1,1:1`)
        if (r.crops['2.35:1'] && r.crops['1:1']) init = { '2.35_1': r.crops['2.35:1'], '1_1': r.crops['1:1'] }
      } catch {
        // 智能裁剪失败时退回居中裁剪。
      }
    }
    setCoverInit(init ?? defaultCrops(a.width, a.height))
    setCropFor(a)
  }
  const saveCrop = async (crops: Record<string, unknown>) => {
    try {
      setWork(await patch<Work>(`/works/${work.id}`, { cover_asset_id: cropFor!.id, cover_crops: crops }))
      setCropFor(null)
      toast.success('封面已设置')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Card id="step-images" className="scroll-mt-24 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-mist-900">{wx ? '配图与封面' : toutiao ? '头条配图' : '笔记图片'}</h2>
        <span className="text-xs text-mist-400">{wx ? '正文图片会自动压缩到 1MB 以内' : toutiao ? `${work.assets.length} 张；配图可选，按此顺序导出，平台上限待实测` : `已选 ${work.assets.length} 张（最多 18 张），按顺序发布；第一张作为封面`}</span>
        {!readOnly && (
          <div className="ml-auto flex gap-2">
            {xhs && <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => setCardMaker(true)}>文字卡片</Button>}
            <Button size="sm" variant="ghost" icon={<Images className="size-3.5" />} onClick={() => setLibrary(true)}>从图片库选择</Button>
            <Button size="sm" icon={<ImagePlus className="size-3.5" />} loading={uploading > 0} onClick={() => input.current?.click()}>上传图片</Button>
          </div>
        )}
      </div>
      {!readOnly && (
        <>
          {wx && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-mist-200 px-3 py-2.5">
              <Sparkles className="size-4 text-ink-500" />
              <span className="text-[12.5px] text-mist-500">没有合适的封面图？让 AI 按标题生成 3 张候选（会计入 AI 用量），挑一张再裁剪。</span>
              <Button size="sm" variant="secondary" className="ml-auto" icon={<Sparkles className="size-3.5" />} loading={coverBusy} onClick={genCover}>AI 封面候选</Button>
            </div>
          )}
          {coverCands && (
            <Dialog open onClose={() => setCoverCands(null)} title="封面候选" desc="挑选一张后进入裁剪确认；候选图同时保存在这篇作品的图片里。" width="max-w-2xl">
              <div className="grid grid-cols-3 gap-3">
                {coverCands.map((a) => (
                  <div key={a.id} className="overflow-hidden rounded-lg border border-mist-200">
                    <img src={a.url} alt="封面候选" className="h-28 w-full object-cover" />
                    <div className="p-2"><Button size="sm" variant="secondary" className="w-full" onClick={() => { setCoverCands(null); void setCover(a) }}>设为封面</Button></div>
                  </div>
                ))}
              </div>
            </Dialog>
          )}
          <div className="mb-4 flex flex-wrap gap-2">
          <Input className="h-9 min-w-[220px] flex-1" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="AI 出图提示词（生成图带「AI 生成」标识）" />
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={aiBusy} disabled={!aiPrompt.trim()} onClick={async () => {
            setAiBusy(true)
            try {
              const { job_id } = await post<{ job_id: string }>(`/works/${work.id}/generate-image`, { prompt: aiPrompt.trim(), background: true })
              const a = await waitJob<Asset>(job_id)
              setWork({ ...work, assets: [...work.assets, a] })
              setAiPrompt('')
              toast.success('已出图（含 AI 标识）')
            } catch (e) { aiError(e, 'AI 出图') }
            finally { setAiBusy(false) }
          }}>AI 出图</Button>
        </div>
        </>
      )}
      {wx && (
        <div className="mb-4 flex items-center gap-4 rounded-xl bg-mist-50 p-3">
          {cover && work.cover_crops ? (
            <>
              <CropPreview src={cover.url} box={work.cover_crops['2.35_1']} aspect={2.35} className="w-40 rounded-md" />
              <CropPreview src={cover.url} box={work.cover_crops['1_1']} aspect={1} className="w-[68px] rounded-md" />
              <div className="text-[13px] text-mist-600">已设置封面<div className="text-xs text-mist-400">左：消息列表大图，右：转发卡片小图</div></div>
              {!readOnly && <Button size="sm" variant="ghost" className="ml-auto" icon={<Crop className="size-3.5" />} onClick={() => void setCover(cover)}>调整裁剪</Button>}
            </>
          ) : (
            <p className="text-[13px] text-mist-500"><Star className="mr-1 inline size-3.5 text-gamboge-400" />还没有封面。写入草稿前必须设置封面：在下方图片上点「设为封面」。</p>
          )}
        </div>
      )}
      {work.assets.length === 0 ? (
        <button disabled={readOnly} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
          className="flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-mist-200 py-10 text-mist-400 transition hover:border-ink-300 hover:text-ink-600">
          <ImagePlus className="mb-2 size-6" />
          <span className="text-[13px]">点击或拖拽上传图片（JPG、PNG、WebP、GIF，单张不超过 20MB）</span>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-3 md:grid-cols-4" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}>
          {work.assets.map((a, i) => (
            <div key={a.id} className="group relative overflow-hidden rounded-lg border border-mist-200 bg-mist-50">
              <img src={a.url} alt="" className={cn('w-full object-cover', wx ? 'aspect-[4/3]' : xhs ? 'aspect-[3/4]' : 'aspect-square')} />
              <span className="absolute left-1.5 top-1.5 rounded bg-mist-900/60 px-1.5 text-[11px] font-medium text-white">{String(i + 1).padStart(2, '0')}</span>
              {a.id === work.cover_asset_id && <span className="absolute right-1.5 top-1.5 rounded bg-gamboge-400 px-1.5 text-[11px] font-bold text-mist-900">封面</span>}
              {a.ai_generated && <span className="absolute left-1.5 bottom-8 rounded bg-mist-900/70 px-1.5 text-[10px] text-white">AI</span>}
              {!readOnly && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-mist-900/70 to-transparent px-1.5 pb-1.5 pt-6 opacity-0 transition group-hover:opacity-100">
                  <div className="flex">
                    <button disabled={i === 0} onClick={() => move(a, -1)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="前移"><ArrowLeft className="size-3.5" /></button>
                    <button disabled={i === work.assets.length - 1} onClick={() => move(a, 1)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="后移"><ArrowRight className="size-3.5" /></button>
                  </div>
                  <div className="flex">
                    {wx && <button onClick={() => void setCover(a)} className="cursor-pointer rounded px-1.5 py-1 text-[11px] text-white hover:bg-white/20">设为封面</button>}
                    <button onClick={() => setRatioCrop(a)} className="cursor-pointer rounded px-1.5 py-1 text-[11px] text-white hover:bg-white/20" title="3:4 裁剪另存">3:4</button>
                    <button onClick={() => remove(a)} className="cursor-pointer rounded p-1 text-white hover:bg-white/20" title="删除"><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }} />
      {cropFor && (
        <CoverCropDialog open onClose={() => setCropFor(null)} src={cropFor.url} width={cropFor.width} height={cropFor.height}
          initial={coverInit ?? defaultCrops(cropFor.width, cropFor.height)} onSave={saveCrop} />
      )}
      {library && <LibraryDialog work={work} onClose={() => setLibrary(false)} onPicked={(a) => setWork({ ...work, assets: [...work.assets, a] })} />}
      {xhs && <XhsCardMaker workId={work.id} open={cardMaker} onClose={() => setCardMaker(false)} onAdded={(a) => setWork({ ...work, assets: [...work.assets, a] })} />}
      {ratioCrop && (
        <AssetCropDialog open onClose={() => setRatioCrop(null)} src={ratioCrop.url} width={ratioCrop.width} height={ratioCrop.height}
          onSave={async (box) => {
            try {
              const a = await post<Asset>(`/assets/${ratioCrop.id}/crop`, { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, aspect: box.aspect })
              setWork({ ...work, assets: [...work.assets, a] })
              setRatioCrop(null)
              toast.success('已另存 3:4 裁剪图')
            } catch (e) { toast.error(errorMessage(e)) }
          }} />
      )}
    </Card>
  )
}

// ---------- 图片库（EX-G-04） ----------

function LibraryDialog({ work, onClose, onPicked }: { work: Work; onClose: () => void; onPicked: (a: Asset) => void }) {
  const [scope, setScope] = useState<'account' | 'all'>('account')
  const [ai, setAi] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['library', scope, ai, work.account_id],
    queryFn: () => get<LibraryAsset[]>(`/assets?${scope === 'account' ? `account_id=${work.account_id}&` : ''}${ai ? `ai=${ai}` : ''}`),
  })
  const list = (q.data ?? []).filter((a) => a.work_id !== work.id)
  const reuse = async (a: LibraryAsset) => {
    setBusy(a.id)
    try {
      onPicked(await post<Asset>(`/works/${work.id}/assets/reuse`, { asset_id: a.id }))
      toast.success('已加入本作品的图片')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onClose={onClose} title="从图片库选择" desc="复用其他作品里的图片，不用重新上传。每次点选加入一张。" width="max-w-3xl"
      footer={<Button variant="primary" onClick={onClose}>完成</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="h-8 w-36 text-[12.5px]" value={scope} onChange={(e) => setScope(e.target.value as 'account' | 'all')}>
          <option value="account">本账号</option>
          <option value="all">全部账号</option>
        </Select>
        <Select className="h-8 w-36 text-[12.5px]" value={ai} onChange={(e) => setAi(e.target.value)}>
          <option value="">全部图片</option>
          <option value="0">实拍 / 上传</option>
          <option value="1">AI 生成</option>
        </Select>
      </div>
      {q.isLoading ? <Spinner /> : list.length === 0 ? <p className="py-10 text-center text-sm text-mist-400">图片库里还没有其他作品的图片。</p> : (
        <div className="scrollbar-thin grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-5">
          {list.map((a) => (
            <button key={a.id} type="button" disabled={!!busy} onClick={() => reuse(a)} title={`《${a.work_title || '未命名'}》 · ${a.account_name}`}
              className="group relative cursor-pointer overflow-hidden rounded-lg border border-mist-200 bg-mist-50 transition hover:border-ink-400">
              <img src={a.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
              {a.ai_generated && <span className="absolute left-1 top-1 rounded bg-mist-900/70 px-1 text-[10px] text-white">AI</span>}
              <span className="absolute inset-x-0 bottom-0 truncate bg-mist-900/60 px-1.5 py-0.5 text-[10.5px] text-white">{a.work_title || '未命名'}</span>
              {busy === a.id && <span className="absolute inset-0 flex items-center justify-center bg-white/60"><Loader2 className="size-5 animate-spin text-ink-600" /></span>}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  )
}
