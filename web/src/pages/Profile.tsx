import { useQuery } from '@tanstack/react-query'
import { FileText, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, formatLabel, IconButton, Input, PageHeader, PageLoading, PlatformMark, Switch, Tabs, Textarea } from '@/components/ui'
import { del, errorMessage, get, patch, post, put, rawRequest, stream } from '@/lib/api'
import { relTime, runeLen } from '@/lib/format'
import { themes } from '@/lib/render'
import { useCurrentAccount, useInvalidate } from '@/lib/session'
import type { Account, CharacterCard, Profile, StyleSample } from '@/lib/types'

const splitList = (s: string) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)

function PositioningTab({ account, profile, onSaved }: { account: Account; profile: Profile; onSaved: (p: Profile) => void }) {
  const [tags, setTags] = useState(profile.positioning_tags.join(' '))
  const [audience, setAudience] = useState(profile.target_audience)
  const [tone, setTone] = useState(profile.persona_tone)
  const [banned, setBanned] = useState(profile.banned_words.join(' '))
  const [summary, setSummary] = useState(profile.style_summary)
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await put<Profile>(`/accounts/${account.id}/profile`, {
        ...profile, positioning_tags: splitList(tags), target_audience: audience, persona_tone: tone, banned_words: splitList(banned), style_summary: summary,
      }))
      toast.success('定位档案已保存，之后的 AI 生成都会使用新档案')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const genSummary = async () => {
    setGenBusy(true)
    setSummary('')
    abort.current = new AbortController()
    try {
      const done = await stream<{ text: string }>(`/accounts/${account.id}/style-summary`, {}, {
        signal: abort.current.signal,
        onDelta: (d) => setSummary((t) => t + d),
      })
      if (done?.text) setSummary(done.text)
      toast.success('已生成风格摘要，请编辑后保存')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setGenBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader title="定位档案" desc="AI 每次生成都会带上这份档案。" />
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <Field label="内容形态" hint={<>修改内容形态请到 <Link to="/settings/accounts" className="text-ink-600 underline">设置 → 平台账号</Link></>}>
          <div className="flex h-9 items-center gap-2 rounded-lg bg-mist-50 px-3 text-sm text-mist-700"><PlatformMark platform={account.platform} size="sm" />{formatLabel[account.content_format]}</div>
        </Field>
        <Field label="定位标签" hint="空格或逗号分隔"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="职场 效率 新人成长" /></Field>
        <Field label="目标读者"><Textarea rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
        <Field label="人设与语气"><Textarea rows={2} value={tone} onChange={(e) => setTone(e.target.value)} /></Field>
        <Field label="禁用词" hint="AI 生成时避免使用；发布前检查会单独标出" className="md:col-span-2"><Input value={banned} onChange={(e) => setBanned(e.target.value)} placeholder="空格分隔，例如：颠覆 震惊 必看" /></Field>
        <Field label="风格描述" hint="可从风格样本 AI 提炼，再人工编辑保存；后续生成使用你保存的版本。" className="md:col-span-2">
          <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} disabled={genBusy}
            placeholder="例如：短句为主，多用具体场景开头；结论先行；不用感叹号。" />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={genBusy} onClick={genSummary}>从样本生成</Button>
            {genBusy && <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>停止</Button>}
          </div>
        </Field>
      </div>
      <div className="flex justify-end border-t border-mist-100 px-5 py-3"><Button variant="primary" loading={busy} onClick={save} disabled={genBusy}>保存档案</Button></div>
    </Card>
  )
}

function SampleDialog({ accountId, editing, onClose }: { accountId: string; editing: StyleSample | null; onClose: () => void }) {
  const [title, setTitle] = useState(editing?.title ?? '')
  const [content, setContent] = useState(editing?.content_md ?? '')
  const [busy, setBusy] = useState(false)
  const inv = useInvalidate()
  const save = async () => {
    setBusy(true)
    try {
      if (editing) await patch(`/style-samples/${editing.id}`, { title, content_md: content })
      else await post(`/accounts/${accountId}/style-samples`, { title, content_md: content })
      inv(['samples', accountId])
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title={editing ? '编辑风格样本' : '添加风格样本'} width="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!title.trim() || !content.trim()} onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <Field label="标题"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="正文" counter={{ value: runeLen(content), max: 20000 }} hint="粘贴你本人写的完整作品。AI 只模仿语气和结构，不复用其中的事实。">
          <Textarea rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

function SamplesTab({ account }: { account: Account }) {
  const { data, isLoading } = useQuery({ queryKey: ['samples', account.id], queryFn: () => get<StyleSample[]>(`/accounts/${account.id}/style-samples`) })
  const [dialog, setDialog] = useState<{ editing: StyleSample | null } | null>(null)
  const inv = useInvalidate()
  const list = data ?? []
  const remove = async (s: StyleSample) => {
    if (!(await confirm({ title: `删除「${s.title}」？`, desc: '可以在回收站中恢复（30 天）。', confirmText: '删除', danger: true }))) return
    await del(`/style-samples/${s.id}`).catch((e) => toast.error(errorMessage(e)))
    inv(['samples', account.id])
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">风格样本<Badge tone={list.length >= 3 ? 'green' : 'gamboge'}>{list.length} 篇</Badge></span>}
        desc="建议 3–10 篇。生成时按篇幅挑选最相关的几篇放入提示词。"
        action={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ editing: null })} disabled={list.length >= 10}>添加</Button>} />
      {isLoading ? <PageLoading /> : list.length === 0 ? (
        <Empty icon={<FileText className="size-5" />} title="还没有风格样本" desc="粘贴你过去写的作品，AI 起草时会模仿你的语气和段落节奏。" />
      ) : (
        <ul className="divide-y divide-mist-100">
          {list.map((s) => (
            <li key={s.id} className="group flex items-center gap-3 px-5 py-3.5">
              <FileText className="size-4 shrink-0 text-mist-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-mist-800">{s.title}</div>
                <div className="truncate text-xs text-mist-400">{s.char_count.toLocaleString()} 字 · {relTime(s.created_at)} · {s.content_md.slice(0, 60)}</div>
              </div>
              <div className="flex opacity-0 transition group-hover:opacity-100">
                <IconButton label="编辑" onClick={() => setDialog({ editing: s })}><Pencil className="size-3.5" /></IconButton>
                <IconButton label="删除" className="hover:text-danger" onClick={() => remove(s)}><Trash2 className="size-3.5" /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog && <SampleDialog accountId={account.id} editing={dialog.editing} onClose={() => setDialog(null)} />}
    </Card>
  )
}

function CharacterDialog({ accountId, editing, onClose }: { accountId: string; editing: CharacterCard | null; onClose: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [appearance, setAppearance] = useState(editing?.appearance ?? '')
  const [personality, setPersonality] = useState(editing?.personality ?? '')
  const [catchphrase, setCatchphrase] = useState(editing?.catchphrase ?? '')
  const [preview, setPreview] = useState(editing?.ref_url || (editing?.ref_asset_id ? `/api/v1/assets/${editing.ref_asset_id}/file` : ''))
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const inv = useInvalidate()
  const uploadRef = async (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await rawRequest('POST', `/characters/${id}/ref`, fd)
    const card = await res.json() as CharacterCard
    setPreview(card.ref_url || `/api/v1/assets/${card.ref_asset_id}/file`)
  }
  const save = async () => {
    setBusy(true)
    try {
      const saved = editing
        ? await patch<CharacterCard>(`/characters/${editing.id}`, { name, appearance, personality, catchphrase })
        : await post<CharacterCard>(`/accounts/${accountId}/characters`, { name, appearance, personality, catchphrase })
      if (pendingFile) await uploadRef(saved.id, pendingFile)
      inv(['characters', accountId])
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const clearRef = async () => {
    if (!editing) {
      setPendingFile(null)
      setPreview('')
      return
    }
    try {
      await del(`/characters/${editing.id}/ref`)
      setPreview('')
      setPendingFile(null)
      inv(['characters', accountId])
      toast.success('已移除参考图')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Dialog open onClose={onClose} title={editing ? '编辑角色' : '新建角色'} width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>保存</Button></>}>
      <div className="space-y-4">
        <Field label="角色名"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小周" /></Field>
        <Field label="外貌" hint="会自动拼进每格绘图提示词"><Textarea rows={3} value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="短发、圆框眼镜、常穿卫衣…" /></Field>
        <Field label="性格"><Textarea rows={2} value={personality} onChange={(e) => setPersonality(e.target.value)} /></Field>
        <Field label="口头禅"><Input value={catchphrase} onChange={(e) => setCatchphrase(e.target.value)} /></Field>
        <Field label="参考图" hint="用于跨格外貌一致；出图时会写入提示词约束">
          <div className="flex items-start gap-3">
            {preview ? (
              <img src={preview} alt="" className="size-20 rounded-lg border border-mist-200 object-cover" />
            ) : (
              <div className="flex size-20 items-center justify-center rounded-lg border border-dashed border-mist-200 text-[11px] text-mist-400">无图</div>
            )}
            <div className="flex flex-col gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-ink-600">
                选择图片
                <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  setPendingFile(f)
                  setPreview(URL.createObjectURL(f))
                }} />
              </label>
              {preview && <button type="button" className="cursor-pointer text-left text-[13px] text-danger" onClick={() => void clearRef()}>移除</button>}
            </div>
          </div>
        </Field>
      </div>
    </Dialog>
  )
}

function CharactersTab({ account }: { account: Account }) {
  const { data, isLoading } = useQuery({ queryKey: ['characters', account.id], queryFn: () => get<CharacterCard[]>(`/accounts/${account.id}/characters`) })
  const [dialog, setDialog] = useState<{ editing: CharacterCard | null } | null>(null)
  const inv = useInvalidate()
  const list = data ?? []
  const remove = async (c: CharacterCard) => {
    if (!(await confirm({ title: `删除「${c.name}」？`, desc: '可以在回收站中恢复（30 天）。', confirmText: '删除', danger: true }))) return
    await del(`/characters/${c.id}`).catch((e) => toast.error(errorMessage(e)))
    inv(['characters', account.id])
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">角色设定卡<Badge>{list.length}</Badge></span>}
        desc="归属本账号，可被所有漫画作品引用。可上传参考图，出图时用于保持外貌一致。"
        action={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ editing: null })}>添加角色</Button>} />
      {isLoading ? <PageLoading /> : list.length === 0 ? (
        <Empty icon={<FileText className="size-5" />} title="还没有角色" desc="先建立固定角色，分镜和绘图提示词才会稳定。" />
      ) : (
        <ul className="divide-y divide-mist-100">
          {list.map((c) => (
            <li key={c.id} className="group flex items-start gap-3 px-5 py-3.5">
              {(c.ref_url || c.ref_asset_id) ? (
                <img src={c.ref_url || `/api/v1/assets/${c.ref_asset_id}/file`} alt="" className="size-11 shrink-0 rounded-lg object-cover" />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-mist-800">{c.name}</div>
                <div className="mt-0.5 text-xs text-mist-500 line-clamp-2">{c.appearance || '未填外貌'}{c.personality ? ` · ${c.personality}` : ''}</div>
                {c.catchphrase && <div className="mt-1 text-xs text-mist-400">口头禅：{c.catchphrase}</div>}
              </div>
              <div className="flex opacity-0 transition group-hover:opacity-100">
                <IconButton label="编辑" onClick={() => setDialog({ editing: c })}><Pencil className="size-3.5" /></IconButton>
                <IconButton label="删除" className="hover:text-danger" onClick={() => remove(c)}><Trash2 className="size-3.5" /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog && <CharacterDialog accountId={account.id} editing={dialog.editing} onClose={() => setDialog(null)} />}
    </Card>
  )
}

function LayoutTab({ account, profile, onSaved }: { account: Account; profile: Profile; onSaved: (p: Profile) => void }) {
  const [theme, setTheme] = useState(profile.default_theme)
  const [d, setD] = useState(profile.wechat_defaults)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await put<Profile>(`/accounts/${account.id}/profile`, { ...profile, default_theme: theme, wechat_defaults: d }))
      toast.success('已保存，新作品会使用这些默认值')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader title="排版与文章默认值" desc="只影响之后新建的作品；推送时还可以单篇修改。" />
      <div className="space-y-5 p-5">
        <Field label="默认主题">
          <div className="grid gap-2 sm:grid-cols-4">
            {themes.map((t) => (
              <button key={t.id} type="button" onClick={() => setTheme(t.id)}
                className={cn('cursor-pointer rounded-lg border p-3 text-left transition', theme === t.id ? 'border-ink-400 bg-ink-50/50 ring-3 ring-ink-100' : 'border-mist-200 hover:border-mist-300')}>
                <div className="mb-1.5 flex -space-x-1">{t.swatch.map((c) => <span key={c} className="size-4 rounded-full border-2 border-white" style={{ background: c }} />)}</div>
                <div className="text-[13.5px] font-semibold">{t.name}</div>
              </button>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="作者" counter={{ value: runeLen(d.author), max: 16 }}><Input value={d.author} onChange={(e) => setD({ ...d, author: e.target.value })} invalid={runeLen(d.author) > 16} /></Field>
          <Field label="阅读原文链接"><Input value={d.source_url} onChange={(e) => setD({ ...d, source_url: e.target.value })} placeholder="可选" /></Field>
        </div>
        <div className="flex gap-6 text-[13.5px] text-mist-700">
          <label className="flex items-center gap-2"><Switch checked={d.open_comment} onChange={(v) => setD({ ...d, open_comment: v, fans_only_comment: v && d.fans_only_comment })} />开启评论</label>
          <label className={cn('flex items-center gap-2', !d.open_comment && 'opacity-50')}><Switch checked={d.fans_only_comment} disabled={!d.open_comment} onChange={(v) => setD({ ...d, fans_only_comment: v })} />仅粉丝可评论</label>
        </div>
      </div>
      <div className="flex justify-end border-t border-mist-100 px-5 py-3"><Button variant="primary" loading={busy} onClick={save} disabled={runeLen(d.author) > 16}>保存</Button></div>
    </Card>
  )
}

export default function ProfilePage() {
  const acc = useCurrentAccount()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as 'positioning' | 'samples' | 'characters' | 'layout') || 'positioning'
  const { data, isLoading, refetch } = useQuery({ queryKey: ['profile', acc?.id], queryFn: () => get<Profile>(`/accounts/${acc!.id}/profile`), enabled: !!acc })
  const [profile, setProfile] = useState<Profile | null>(null)
  useEffect(() => setProfile(data ?? null), [data])
  if (!acc || isLoading || !profile) return <PageLoading />
  const wx = acc.platform === 'wechat_mp'
  const comic = acc.content_format === 'comic'
  const items = [
    { value: 'positioning' as const, label: '定位' },
    { value: 'samples' as const, label: '风格样本' },
    ...(comic ? [{ value: 'characters' as const, label: '角色卡' }] : []),
    ...(wx ? [{ value: 'layout' as const, label: '排版' }] : []),
  ]
  return (
    <div className="animate-fade-in">
      <PageHeader eyebrow={acc.name} title="账号档案" desc="定位、风格和默认设置。每个账号单独维护。" />
      <Tabs value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} items={items} className="mb-5" />
      {tab === 'positioning' && <PositioningTab key={acc.id} account={acc} profile={profile} onSaved={(p) => { setProfile(p); refetch() }} />}
      {tab === 'samples' && <SamplesTab account={acc} />}
      {tab === 'characters' && comic && <CharactersTab account={acc} />}
      {tab === 'layout' && wx && <LayoutTab key={acc.id} account={acc} profile={profile} onSaved={(p) => { setProfile(p); refetch() }} />}
    </div>
  )
}
