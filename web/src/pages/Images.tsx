import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Images as ImagesIcon, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, Card, Empty, PageHeader, Select, Spinner, Textarea } from '@/components/ui'
import { errorMessage, get, patch, post } from '@/lib/api'
import { fmtNum, relTime } from '@/lib/format'
import { useAccounts, useCanWrite } from '@/lib/session'
import type { LibraryAsset } from '@/lib/types'

/** 图片库（EX-G-04）：工作区内所有作品的图片；复用在编辑器"从图片库选择"里完成，不重复上传。 */
export default function ImagesPage() {
  const [params, setParams] = useSearchParams()
  const account = params.get('account') ?? ''
  const workId = params.get('work') ?? ''
  const ai = params.get('ai') ?? ''
  const [open, setOpen] = useState<LibraryAsset | null>(null)
  const [altText, setAltText] = useState('')
  const [savingAlt, setSavingAlt] = useState(false)
  const [suggestingAlt, setSuggestingAlt] = useState(false)
  const canWrite = useCanWrite()
  const qc = useQueryClient()
  const { data: accounts } = useAccounts()
  const set = (k: string, v: string) => setParams((p) => {
    const n = new URLSearchParams(p)
    if (v) n.set(k, v)
    else n.delete(k)
    if (k === 'account') n.delete('work')
    return n
  }, { replace: true })
  const filters = [account && `account_id=${account}`, ai && `ai=${ai}`].filter(Boolean).join('&')
  const q = useQuery({ queryKey: ['library', 'page', filters], queryFn: () => get<LibraryAsset[]>(`/assets${filters ? `?${filters}` : ''}`) })
  const works = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of q.data ?? []) if (!m.has(a.work_id)) m.set(a.work_id, a.work_title || '未命名')
    return [...m.entries()]
  }, [q.data])
  const list = (q.data ?? []).filter((a) => !workId || a.work_id === workId)

  return (
    <div className="mx-auto max-w-6xl animate-fade-in">
      <PageHeader eyebrow="工作区" title="图片库" desc="汇总所有作品里的图片。要在别的作品里用，打开那篇作品的编辑器，点「从图片库选择」即可复用，不用重新上传。" />
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <Select className="h-8 w-40 text-[12.5px]" value={account} onChange={(e) => set('account', e.target.value)} aria-label="按账号筛选">
          <option value="">全部账号</option>
          {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select className="h-8 w-48 text-[12.5px]" value={workId} onChange={(e) => set('work', e.target.value)} aria-label="按作品筛选">
          <option value="">全部作品</option>
          {works.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </Select>
        <Select className="h-8 w-36 text-[12.5px]" value={ai} onChange={(e) => set('ai', e.target.value)} aria-label="按来源筛选">
          <option value="">全部图片</option>
          <option value="0">实拍 / 上传</option>
          <option value="1">AI 生成</option>
        </Select>
        <span className="ml-auto text-[12px] text-mist-400">{fmtNum(list.length)} 张</span>
      </Card>
      {q.isLoading ? <Spinner /> : list.length === 0 ? (
        <Card>
          <Empty icon={<ImagesIcon className="size-5" />} title={account || workId || ai ? '没有符合条件的图片' : '图片库还是空的'}
            desc={account || workId || ai ? '换个筛选条件试试。' : '在作品编辑器里上传或生成配图后，会自动汇总到这里。'}
            action={account || workId || ai
              ? <Button size="sm" onClick={() => setParams({}, { replace: true })}>清除筛选</Button>
              : <Link to="/"><Button size="sm" variant="primary">去写作品</Button></Link>} />
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {list.map((a) => (
            <button key={a.id} type="button" onClick={() => { setAltText(a.alt_text ?? ''); setOpen(a) }}
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-mist-200 bg-mist-50 text-left transition hover:border-ink-400">
              <img src={`${a.url}?variant=256`} alt={a.alt_text || ''} loading="lazy" className="aspect-square w-full object-cover" />
              {a.ai_generated && <span className="absolute left-1.5 top-1.5 rounded bg-mist-900/70 px-1.5 text-[10.5px] text-white">AI</span>}
              <div className="bg-white px-2 py-1.5">
                <div className="truncate text-[12.5px] font-medium text-mist-800">{a.work_title || '未命名'}</div>
                <div className="truncate text-[11px] text-mist-400">{a.account_name || '—'}{a.created_at && ` · ${relTime(a.created_at)}`}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={open.work_title || '未命名'} desc={`${open.account_name} · ${open.width}×${open.height} · ${open.ai_generated ? 'AI 生成' : '上传'}`} width="max-w-3xl"
          footer={<div className="flex flex-wrap items-center justify-between gap-2">
            {canWrite && <div className="flex gap-2">
              <Button variant="ghost" icon={<Sparkles className="size-3.5" />} loading={suggestingAlt} disabled={savingAlt || suggestingAlt}
                onClick={async () => {
                  setSuggestingAlt(true)
                  try {
                    const result = await post<{ suggestion: string }>(`/assets/${open.id}/alt-suggestion`)
                    setAltText(result.suggestion)
                  } catch (e) { toast.error(errorMessage(e)) }
                  finally { setSuggestingAlt(false) }
                }}>生成 AI 建议</Button>
              <Button variant="primary" loading={savingAlt} disabled={savingAlt || suggestingAlt}
                onClick={async () => {
                  setSavingAlt(true)
                  try {
                    await patch<LibraryAsset[]>(`/assets/${open.id}`, { alt_text: altText })
                    setOpen({ ...open, alt_text: altText.trim() })
                    await q.refetch()
                    void qc.invalidateQueries({ queryKey: ['work', open.work_id] })
                    toast.success('替代文字已保存')
                  } catch (e) { toast.error(errorMessage(e)) }
                  finally { setSavingAlt(false) }
                }}>保存替代文字</Button>
            </div>}
            <Link to={`/works/${open.work_id}`}><Button variant={canWrite ? 'secondary' : 'primary'} icon={<ExternalLink className="size-3.5" />}>打开所在作品</Button></Link>
          </div>}>
          <img src={open.url} alt={open.alt_text || ''} className="max-h-[55vh] w-full rounded-lg object-contain" />
          <div className="mt-4 space-y-2">
            <label htmlFor="image-alt-text" className="text-[13px] font-medium text-mist-700">替代文字</label>
            {canWrite
              ? <Textarea id="image-alt-text" value={altText} onChange={(e) => setAltText(e.target.value)} rows={3} placeholder="描述图片中重要的主体和信息" disabled={savingAlt || suggestingAlt} />
              : <p className="text-sm text-mist-500">{open.alt_text || '尚未填写替代文字'}</p>}
          </div>
        </Dialog>
      )}
    </div>
  )
}
