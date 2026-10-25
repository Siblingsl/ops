import { useQuery } from '@tanstack/react-query'
import { Brain, Check, FileText, Palette, Pencil, Plus, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { AIFeedback } from '@/components/refs'
import { aiError } from '@/lib/ai-error'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, formatLabel, IconButton, Input, Notice, PageHeader, PageLoading, PageState, PlatformMark, Select, Switch, Tabs, Textarea } from '@/components/ui'
import { HealthRing } from '@/components/health-ring'
import { del, errorMessage, get, patch, post, put, rawRequest, stream } from '@/lib/api'
import { relTime, runeLen } from '@/lib/format'
import { CUSTOM_THEME_ID, customTheme, renderWechat, themes } from '@/lib/render'
import { setCustomTheme } from '@/lib/custom-theme-state'
import { useCanWrite, useCurrentAccount, useInvalidate } from '@/lib/session'
import type { Account, CharacterCard, CustomTheme, Memory, Profile, StyleSample } from '@/lib/types'
import SkillsTab from './ProfileSkills'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { memoryKindLabel, memoryScopeLabel, memorySourceLabel, useCustomTheme } from '@/lib/v3'

const splitList = (s: string) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)

interface BootstrapDraft {
  positioning_tags: string[]
  target_audience: string
  persona_tone: string
  banned_words_suggest: string[]
  style_summary: string
  evidence: Record<string, string>
}

const draftFields: { key: keyof Omit<BootstrapDraft, 'evidence'>; label: string }[] = [
  { key: 'positioning_tags', label: '定位标签' },
  { key: 'target_audience', label: '目标读者' },
  { key: 'persona_tone', label: '人设与语气' },
  { key: 'banned_words_suggest', label: '建议禁用词' },
  { key: 'style_summary', label: '风格摘要' },
]

/** splitPasted cuts one big paste into articles at "---" lines or Markdown heading lines (EX-A-01). */
export function splitPasted(text: string): { title: string; content: string }[] {
  const out: { title: string; content: string }[] = []
  let cur: { title: string; lines: string[] } = { title: '', lines: [] }
  const push = () => {
    const content = cur.lines.join('\n').trim()
    if (content) out.push({ title: cur.title, content })
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*-{3,}\s*$/.test(line)) {
      push()
      cur = { title: '', lines: [] }
    } else if (/^#{1,2}\s+\S/.test(line) && cur.lines.some((l) => l.trim())) {
      push()
      cur = { title: line.replace(/^#+\s+/, '').trim(), lines: [] }
    } else if (/^#{1,2}\s+\S/.test(line) && !cur.title) {
      cur.title = line.replace(/^#+\s+/, '').trim()
    } else cur.lines.push(line)
  }
  push()
  return out.slice(0, 10)
}

/** ST-02：建档向导结束后常被推后的两件事——公众号凭证与模型。
 *  这里按当前账号的真实状态列出「还差什么」，每项给一个直达按钮，不用回工作台碰运气。 */
function NextStepAfterProfile({ account }: { account: Account }) {
  const wx = account.platform === 'wechat_mp'
  const credDone = account.credential?.state === 'ok'
  const [dismissed, setDismissed] = useState(false)
  const models = useQuery({ queryKey: ['providers'], queryFn: () => get<{ models?: string[]; status?: string }[]>('/model-providers').catch(() => []) })
  const modelCount = models.data?.reduce((n, p) => n + (p.models?.length ?? 0), 0) ?? 0
  const missing = [
    ...(wx && !credDone ? [{ key: 'cred', text: '公众号凭证还没接通', desc: '填 AppID / AppSecret 并加入 IP 白名单后才能写入草稿箱。', to: `/settings/accounts?id=${account.id}` }] : []),
    ...(modelCount === 0 ? [{ key: 'model', text: '还没有可用模型', desc: '配好模型并完成自检，AI 生成按钮才可用。', to: '/settings/models' }] : []),
  ]
  if (dismissed || missing.length === 0 || models.isLoading) return null
  return (
    <div className="px-5 pt-4" data-testid="profile-next-steps">
      <Notice tone="gamboge">
        <p className="font-medium">建档完成，还差 {missing.length} 项才能完整跑通：</p>
        <ul className="mt-1.5 space-y-1 text-[12.5px]">
          {missing.map((m) => <li key={m.key} className="flex flex-wrap items-center gap-2">
            <span>{m.text} —— {m.desc}</span>
            <Link to={m.to}><Button type="button" size="sm" variant="outline">去处理</Button></Link>
          </li>)}
        </ul>
        <button type="button" className="mt-2 cursor-pointer text-xs text-ink-600 underline" onClick={() => setDismissed(true)}>先不管，稍后再说</button>
      </Notice>
    </div>
  )
}

/** BootstrapWizard (EX-A-01): paste a few past works, get a draft profile with evidence, edit it, and only "确认建档" saves. */
function BootstrapWizard({ account, onClose, onApply }: { account: Account; onClose: () => void; onApply: (d: BootstrapDraft, fields: Record<string, boolean>) => Promise<boolean> }) {
  const inv = useInvalidate()
  const [samples, setSamples] = useState([{ title: '', content: '', keep: true }, { title: '', content: '', keep: true }, { title: '', content: '', keep: true }])
  const [bulk, setBulk] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [draft, setDraft] = useState<BootstrapDraft | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const abort = useRef<AbortController | null>(null)
  const filled = samples.filter((s) => s.content.trim())
  const applyBulk = () => {
    const parts = splitPasted(bulk)
    if (parts.length === 0) return toast.info('没有识别到正文')
    setSamples(parts.map((p) => ({ ...p, keep: true })))
    setBulk('')
    toast.success(`已拆成 ${parts.length} 篇，可以逐篇检查和调整`)
  }
  const [texts, setTexts] = useState<Record<string, string>>({})
  const edited = (): BootstrapDraft | null => draft && {
    ...draft,
    positioning_tags: splitList(texts.positioning_tags ?? ''),
    banned_words_suggest: splitList(texts.banned_words_suggest ?? ''),
    target_audience: (texts.target_audience ?? '').trim(),
    persona_tone: (texts.persona_tone ?? '').trim(),
    style_summary: (texts.style_summary ?? '').trim(),
  }
  const run = async () => {
    setBusy(true)
    setStreamText('')
    setDraft(null)
    abort.current = new AbortController()
    try {
      const done = await stream<{ result: BootstrapDraft; ai_call_id: string }>(`/accounts/${account.id}/profile/bootstrap`, { samples: filled }, {
        signal: abort.current.signal,
        onDelta: (d) => setStreamText((t) => t + d),
      })
      if (done?.result) {
        setDraft(done.result)
        setCallId(done.ai_call_id)
        const p: Record<string, boolean> = {}
        const t: Record<string, string> = {}
        for (const f of draftFields) {
          const v = done.result[f.key]
          p[f.key] = Array.isArray(v) ? v.length > 0 : !!v
          t[f.key] = Array.isArray(v) ? v.join('、') : v
        }
        setPick(p)
        setTexts(t)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') aiError(e, '生成定位档案草稿', run)
    } finally {
      setBusy(false)
    }
  }
  const adopt = async () => {
    const d = edited()
    if (!d) return
    setSaving(true)
    try {
      if (!(await onApply(d, pick))) return
      const keep = filled.filter((s) => s.keep)
      let saved = 0
      for (const s of keep) {
        await post(`/accounts/${account.id}/style-samples`, { title: s.title.trim() || s.content.trim().slice(0, 20), content_md: s.content }).then(() => saved++, () => undefined)
      }
      if (keep.length) toast.success(`已存入 ${saved} 篇风格样本`)
      inv(['samples', account.id], ['health', account.id], ['dashboard', account.id])
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="从过往作品生成档案" width="max-w-3xl"
      desc="粘贴 1–10 篇你写过的作品，AI 只根据这些样本推断定位档案草稿，并说明每一项的依据。无法判断的会留空，不会编造你的身份或经历。"
      footer={draft ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setDraft(null)}>返回修改样本</Button>
        <Button variant="ghost" onClick={run} disabled={busy}>重新生成</Button>
        <Button variant="human" loading={saving} disabled={!Object.values(pick).some(Boolean)} onClick={adopt} icon={<Check className="size-4" />}>确认建档</Button>
      </> : <>
        <Button variant="ghost" onClick={onClose}>跳过，手动填写</Button>
        {busy ? <Button onClick={() => abort.current?.abort()}>停止</Button> : <Button variant="primary" icon={<Sparkles className="size-4" />} disabled={filled.length === 0} onClick={run}>生成档案草稿</Button>}
      </>}>
      <ol className="mb-4 flex gap-2 text-[12px]">
        {['粘贴过往作品', '分析', '确认档案'].map((s, i) => {
          const step = draft ? 2 : busy ? 1 : 0
          return <li key={s} className={cn('rounded-full px-2.5 py-0.5', i === step ? 'bg-ink-600 text-white' : i < step ? 'bg-ink-50 text-ink-700' : 'bg-mist-100 text-mist-400')}>{i + 1}. {s}</li>
        })}
      </ol>
      {!draft ? (
        busy ? (
          <pre className="scrollbar-thin max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-mist-50 p-3 font-mono text-[12px] text-mist-600">{streamText || '正在识别你的选题方向、读者、语气…'}</pre>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-dashed border-mist-300 p-3">
              <Textarea rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'一次粘贴多篇：用单独一行「---」分隔，或每篇以「# 标题」开头'} />
              <div className="mt-2 flex justify-end"><Button size="sm" variant="secondary" disabled={!bulk.trim()} onClick={applyBulk}>自动拆分</Button></div>
            </div>
            {samples.map((s, i) => (
              <div key={i} className="rounded-lg border border-mist-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Input value={s.title} onChange={(e) => setSamples((l) => l.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} placeholder={`作品 ${i + 1} 标题（可选）`} />
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-mist-600" title="确认建档时把这一篇存为风格样本">
                    <input type="checkbox" className="accent-ink-600" checked={s.keep} onChange={(e) => setSamples((l) => l.map((x, k) => (k === i ? { ...x, keep: e.target.checked } : x)))} />存为样本
                  </label>
                  {samples.length > 1 && <IconButton label="移除这一篇" onClick={() => setSamples((l) => l.filter((_, k) => k !== i))}><X className="size-3.5" /></IconButton>}
                </div>
                <Textarea rows={4} value={s.content} onChange={(e) => setSamples((l) => l.map((x, k) => (k === i ? { ...x, content: e.target.value } : x)))} placeholder="粘贴正文" />
              </div>
            ))}
            {samples.length < 10 && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setSamples((l) => [...l, { title: '', content: '', keep: true }])}>再加一篇</Button>}
          </div>
        )
      ) : (
        <div className="space-y-3">
          {draftFields.map((f) => {
            const text = texts[f.key] ?? ''
            return (
              <div key={f.key} className={cn('flex gap-3 rounded-lg border p-3', pick[f.key] ? 'border-ink-300 bg-ink-50/40' : 'border-mist-200')}>
                <input type="checkbox" aria-label={`采用${f.label}`} className="mt-1 accent-ink-600" checked={!!pick[f.key]} onChange={(e) => setPick((p) => ({ ...p, [f.key]: e.target.checked }))} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-mist-500">{f.label}</div>
                  <Textarea rows={f.key === 'style_summary' ? 3 : 1} className="mt-1 text-[13.5px]" value={text}
                    placeholder="无法从样本判断，留空；也可以自己填" onChange={(e) => { const v = e.target.value; setTexts((t) => ({ ...t, [f.key]: v })); if (v.trim()) setPick((p) => ({ ...p, [f.key]: true })) }} />
                  {draft.evidence[f.key] && <div className="mt-1 text-[12px] text-mist-500">依据：{draft.evidence[f.key]}</div>}
                </div>
              </div>
            )
          })}
          <p className="text-[12px] text-mist-500">勾选「存为样本」的 {filled.filter((s) => s.keep).length} 篇作品会在确认后存入风格样本。</p>
          {callId && <AIFeedback callId={callId} />}
        </div>
      )}
    </Dialog>
  )
}

function MemoryTab({ account }: { account: Account }) {
  const canWrite = useCanWrite()
  const inv = useInvalidate()
  const { data, isLoading } = useQuery({ queryKey: ['memories', account.id], queryFn: () => get<Memory[]>(`/accounts/${account.id}/memories`) })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Memory | null>(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<Memory['kind']>('wording')
  const [scope, setScope] = useState<Memory['scope']>('all')
  const list = data ?? []
  const open = (m: Memory | null) => {
    setEditing(m)
    setText(m?.text ?? '')
    setKind(m?.kind ?? 'wording')
    setScope(m?.scope ?? 'all')
    setAdding(true)
  }
  const save = async () => {
    try {
      if (editing) await patch(`/memories/${editing.id}`, { text, kind, scope })
      else await post(`/accounts/${account.id}/memories`, { text, kind, scope })
      inv(['memories', account.id], ['health', account.id])
      setAdding(false)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const setStatus = async (m: Memory, status: Memory['status']) => {
    try {
      await patch(`/memories/${m.id}`, { status })
      inv(['memories', account.id], ['health', account.id], ['next-actions', account.id])
      if (status === 'active') toast.success('已确认，之后的生成会遵守这条记忆')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (m: Memory) => {
    if (!(await confirm({ title: '删除这条记忆？', danger: true, confirmText: '删除' }))) return
    await del(`/memories/${m.id}`).catch((e) => toast.error(errorMessage(e)))
    inv(['memories', account.id], ['health', account.id])
  }
  const distill = async () => {
    try {
      await post(`/accounts/${account.id}/memories/distill`)
      toast.success('正在后台从最近 60 天的修改中提炼', { description: '提炼出的只是建议，需要你逐条确认后才会生效。' })
    } catch (e) {
      aiError(e, '提炼记忆', distill)
    }
  }
  const groups: { status: Memory['status']; title: string; desc: string }[] = [
    { status: 'suggested', title: '待确认', desc: 'AI 从你的修改、放弃和复盘里总结出来的，确认前不会影响任何生成。' },
    { status: 'active', title: '生效中', desc: '起草、改写、标题、选题时会按作用范围带上这些记忆。' },
    { status: 'disabled', title: '已停用', desc: '' },
  ]
  return (
    <Card>
      <CardHeader title="AI 写作记忆" desc="记住你的偏好，让 AI 越用越懂你。每条记忆都要你确认后才生效，随时可以停用。"
        action={canWrite ? <>
          <Button size="sm" icon={<Brain className="size-3.5" />} onClick={distill}>从最近修改中提炼</Button>
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => open(null)}>手动添加</Button>
        </> : undefined} />
      {isLoading ? <PageLoading /> : list.length === 0 ? (
        <Empty icon={<Brain className="size-5" />} title="还没有记忆" desc="例如「不用感叹号」「结尾给一个可执行的小建议」。你在编辑器里反复使用的指令，也会被建议成记忆。"
          action={canWrite ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open(null)}>写下第一条记忆</Button> : undefined} />
      ) : (
        <div className="divide-y divide-mist-100">
          {groups.map((g) => {
            const items = list.filter((m) => m.status === g.status)
            if (items.length === 0) return null
            return (
              <div key={g.status} className="px-5 py-4">
                <div className="mb-2 flex items-baseline gap-2">
                  <h4 className="text-[13.5px] font-semibold text-mist-800">{g.title}</h4>
                  <span className="text-xs text-mist-400">{items.length}</span>
                  {g.desc && <span className="text-[12px] text-mist-400">{g.desc}</span>}
                </div>
                <ul className="space-y-2">
                  {items.map((m) => (
                    <li key={m.id} className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5', m.status === 'suggested' ? 'border-gamboge-200 bg-gamboge-50/40' : 'border-mist-100')}>
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-[13.5px] text-mist-800', m.status === 'disabled' && 'text-mist-400 line-through')}>{m.text}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-mist-400">
                          <Badge>{memoryKindLabel[m.kind]}</Badge>
                          <Badge>{memoryScopeLabel[m.scope]}</Badge>
                          <span>{memorySourceLabel[m.source] ?? m.source}</span>
                          {m.evidence?.count != null && <span>· 依据 {m.evidence.count} 次相同指令</span>}
                          {m.evidence?.pairs != null && m.evidence.pairs > 0 && <span>· 基于 {m.evidence.pairs} 组采纳前后对比</span>}
                          {m.evidence?.rejections != null && m.evidence.rejections > 0 && <span>· {m.evidence.rejections} 条被拒反馈</span>}
                          {m.evidence?.note && <span>· {m.evidence.note}</span>}
                          {m.use_count > 0 && <span>· 生成时已使用 {m.use_count} 次</span>}
                          <span>· {relTime(m.created_at)}</span>
                        </div>
                      </div>
                      {canWrite && (
                        <div className="flex shrink-0 items-center gap-1">
                          {m.status === 'suggested' && <Button size="sm" variant="human" icon={<Check className="size-3.5" />} onClick={() => setStatus(m, 'active')}>确认</Button>}
                          {m.status === 'active' && <Switch checked onChange={() => setStatus(m, 'disabled')} label="停用" />}
                          {m.status === 'disabled' && <Switch checked={false} onChange={() => setStatus(m, 'active')} label="启用" />}
                          <IconButton label="编辑" onClick={() => open(m)}><Pencil className="size-3.5" /></IconButton>
                          {m.status === 'suggested' ? (
                            <IconButton label="忽略" onClick={() => setStatus(m, 'disabled')}><X className="size-3.5" /></IconButton>
                          ) : (
                            <IconButton label="删除" className="hover:text-danger" onClick={() => remove(m)}><Trash2 className="size-3.5" /></IconButton>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title={editing ? '编辑记忆' : '添加记忆'}
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>取消</Button><Button variant="primary" disabled={!text.trim()} onClick={save}>保存</Button></>}>
        <div className="space-y-4">
          <Field label="记忆内容" counter={{ value: runeLen(text), max: 200 }}><Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：开头先讲一个具体场景，不要用设问句开头" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="类型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as Memory['kind'])}>
                {Object.entries(memoryKindLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <Field label="作用范围">
              <Select value={scope} onChange={(e) => setScope(e.target.value as Memory['scope'])}>
                {Object.entries(memoryScopeLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
          </div>
          {!editing && <p className="text-[12px] text-mist-400">你亲手写的记忆会直接生效。</p>}
        </div>
      </Dialog>
    </Card>
  )
}

const defaultCustom: CustomTheme = { base: 'ink', primary_color: '#2F5D62', font_size: 16, line_height: 1.8, paragraph_gap: 18, heading_style: 'underline', quote_style: 'bar' }
const previewSections = [
  { heading: '这是一个小标题', content_md: '这是正文段落。好的排版让读者**一眼抓住重点**，也让长文读起来不累。\n\n> 引用的句子会这样显示。\n\n- 列表第一项\n- 列表第二项' },
]

function CustomThemeCard({ account, profile, onSaved }: { account: Account; profile: Profile; onSaved: (p: Profile) => void }) {
  const q = useCustomTheme(account.id)
  const [ct, setCt] = useState<CustomTheme>(defaultCustom)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (q.data) setCt(q.data) }, [q.data])
  const save = async (makeDefault: boolean) => {
    setBusy(true)
    try {
      await put(`/accounts/${account.id}/custom-theme`, ct)
      setCustomTheme(ct)
      void q.refetch()
      if (makeDefault) onSaved(await put<Profile>(`/accounts/${account.id}/profile`, { ...profile, default_theme: CUSTOM_THEME_ID }))
      toast.success(makeDefault ? '已保存，并设为新作品的默认主题' : '已保存我的主题')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const html = renderWechat(previewSections, customTheme(ct))
  return (
    <Card className="mt-5">
      <CardHeader title={<span className="flex items-center gap-2"><Palette className="size-4 text-ink-600" />我的主题</span>} desc="在预设主题基础上调整颜色、字号和间距。只使用公众号支持的基础样式。" />
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="基于">
              <Select value={ct.base} onChange={(e) => setCt({ ...ct, base: e.target.value })}>
                {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="主色">
              <div className="flex items-center gap-2">
                <input type="color" value={ct.primary_color} onChange={(e) => setCt({ ...ct, primary_color: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-mist-200" />
                <Input value={ct.primary_color} onChange={(e) => setCt({ ...ct, primary_color: e.target.value })} className="font-mono" />
              </div>
            </Field>
          </div>
          <Field label={`正文字号：${ct.font_size}px`}><input type="range" min={14} max={17} value={ct.font_size} onChange={(e) => setCt({ ...ct, font_size: +e.target.value })} className="w-full accent-ink-600" /></Field>
          <Field label={`行距：${ct.line_height.toFixed(1)}`}><input type="range" min={1.4} max={2.2} step={0.1} value={ct.line_height} onChange={(e) => setCt({ ...ct, line_height: +e.target.value })} className="w-full accent-ink-600" /></Field>
          <Field label={`段间距：${ct.paragraph_gap}px`}><input type="range" min={8} max={32} value={ct.paragraph_gap} onChange={(e) => setCt({ ...ct, paragraph_gap: +e.target.value })} className="w-full accent-ink-600" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="小标题样式">
              <Select value={ct.heading_style} onChange={(e) => setCt({ ...ct, heading_style: e.target.value as CustomTheme['heading_style'] })}>
                <option value="plain">纯文字</option><option value="underline">下划线</option><option value="bar">左侧竖条</option><option value="block">色块</option>
              </Select>
            </Field>
            <Field label="引用样式">
              <Select value={ct.quote_style} onChange={(e) => setCt({ ...ct, quote_style: e.target.value as CustomTheme['quote_style'] })}>
                <option value="bar">左侧竖条</option><option value="box">边框</option><option value="italic">斜体</option>
              </Select>
            </Field>
          </div>
        </div>
        <div className="rounded-xl border border-mist-200 bg-white p-4">
          <div className="mb-2 text-[11.5px] text-mist-400">预览</div>
          <div dangerouslySetInnerHTML={{ __html: html || '' }} />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-mist-100 px-5 py-3">
        <Button loading={busy} onClick={() => save(false)}>保存</Button>
        <Button variant="primary" loading={busy} onClick={() => save(true)}>保存并设为默认主题</Button>
      </div>
    </Card>
  )
}

function PositioningTab({ account, profile, onSaved }: { account: Account; profile: Profile; onSaved: (p: Profile) => void }) {
  const inv = useInvalidate()
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
      inv(['health', account.id], ['dashboard', account.id])
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
      if ((e as Error).name !== 'AbortError') aiError(e, '生成风格摘要', genSummary)
    } finally {
      setGenBusy(false)
    }
  }
  const [params, setParams] = useSearchParams()
  const [wizard, setWizard] = useState(params.get('wizard') === '1')
  // D-132: Profile may stay mounted while the active account changes, so honor the new wizard deep link.
  useEffect(() => {
    if (params.get('wizard') === '1') {
      toast.dismiss('account-create-success')
      setWizard(true)
    }
  }, [params])
  const closeWizard = () => {
    setWizard(false)
    if (params.has('wizard')) setParams((p) => { const n = new URLSearchParams(p); n.delete('wizard'); return n }, { replace: true })
  }
  const apply = async (d: BootstrapDraft, fields: Record<string, boolean>): Promise<boolean> => {
    const next = {
      tags: fields.positioning_tags ? d.positioning_tags.join(' ') : tags,
      audience: fields.target_audience ? d.target_audience : audience,
      tone: fields.persona_tone ? d.persona_tone : tone,
      banned: fields.banned_words_suggest ? [...new Set([...splitList(banned), ...d.banned_words_suggest])].join(' ') : banned,
      summary: fields.style_summary ? d.style_summary : summary,
    }
    try {
      onSaved(await put<Profile>(`/accounts/${account.id}/profile`, {
        ...profile, positioning_tags: splitList(next.tags), target_audience: next.audience, persona_tone: next.tone, banned_words: splitList(next.banned), style_summary: next.summary,
      }))
      setTags(next.tags)
      setAudience(next.audience)
      setTone(next.tone)
      setBanned(next.banned)
      setSummary(next.summary)
      inv(['health', account.id], ['dashboard', account.id])
      toast.success('已建档，之后的 AI 生成都会使用这份档案')
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }
  return (
    <Card>
      <CardHeader title="定位档案" desc="AI 每次生成都会带上这份档案。"
        action={<Button size="sm" icon={<Wand2 className="size-3.5" />} onClick={() => setWizard(true)}>从过往作品生成</Button>} />
      {wizard && <BootstrapWizard account={account} onClose={closeWizard} onApply={apply} />}
      <NextStepAfterProfile account={account} />
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <Field label="账号类型" hint="如需更换请到设置 → 账号的「修改类型」；已有作品保持原类型。业务定位（标签、读者、人设等）可随时调整" plain>
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
      inv(['samples', accountId], ['health', accountId], ['dashboard', accountId])
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
    inv(['samples', account.id], ['health', account.id], ['dashboard', account.id])
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">风格样本<Badge tone={list.length >= 3 ? 'green' : 'gamboge'}>{list.length} 篇</Badge></span>}
        desc="建议 3–10 篇。生成时按篇幅挑选最相关的几篇放入提示词。"
        action={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ editing: null })} disabled={list.length >= 10}>添加</Button>} />
      {isLoading ? <PageLoading /> : list.length === 0 ? (
        <Empty icon={<FileText className="size-5" />} title="还没有风格样本" desc="粘贴你过去写的作品，AI 起草时会模仿你的语气和段落节奏。"
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>粘贴第一篇样本</Button>} />
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
        <Empty icon={<FileText className="size-5" />} title="还没有角色" desc="先建立固定角色，分镜和绘图提示词才会稳定。"
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ editing: null })}>添加第一个角色</Button>} />
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
  const custom = useCustomTheme(account.id)
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
    <>
    <Card>
      <CardHeader title="排版与文章默认值" desc="只影响之后新建的作品；推送时还可以单篇修改。" />
      <div className="space-y-5 p-5">
        <Field label="默认主题">
          <div className="grid gap-2 sm:grid-cols-5">
            {[...themes, ...(custom.data ? [customTheme(custom.data)] : [])].map((t) => (
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
      <CustomThemeCard account={account} profile={profile} onSaved={(p) => { setTheme(p.default_theme); onSaved(p) }} />
    </>
  )
}

export default function ProfilePage() {
  const acc = useCurrentAccount()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as 'positioning' | 'samples' | 'memory' | 'characters' | 'layout' | 'skills') || 'positioning'
  const { data, isLoading, error, failureReason, isFetching, refetch } = useQuery({ queryKey: ['profile', acc?.id], queryFn: () => get<Profile>(`/accounts/${acc!.id}/profile`), enabled: !!acc })
  const [profile, setProfile] = useState<Profile | null>(null)
  useEffect(() => setProfile(data ?? null), [data])
  if (!acc || isLoading || !profile) return <PageState loading={!acc || isLoading || (!!data && !profile)} error={error ?? failureReason} retrying={isFetching} onRetry={() => void refetch()} emptyTitle="暂无账号档案" />
  const wx = acc.platform === 'wechat_mp'
  const comic = acc.content_format === 'comic'
  const items = [
    { value: 'positioning' as const, label: '定位' },
    { value: 'samples' as const, label: '风格样本' },
    { value: 'memory' as const, label: 'AI 记忆' },
    ...(!isElectronDesktop(navigator.userAgent) ? [{ value: 'skills' as const, label: '写作技能' }] : []),
    ...(comic ? [{ value: 'characters' as const, label: '角色卡' }] : []),
    ...(wx ? [{ value: 'layout' as const, label: '排版' }] : []),
  ]
  return (
    <div className="animate-fade-in">
      <PageHeader eyebrow={acc.name} title="账号档案" desc="定位、风格和默认设置。每个账号单独维护。" />
      <HealthRing accountId={acc.id} />
      <Tabs value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} items={items} className="mb-5" />
      {tab === 'positioning' && <PositioningTab key={acc.id} account={acc} profile={profile} onSaved={(p) => { setProfile(p); refetch() }} />}
      {tab === 'samples' && <SamplesTab account={acc} />}
      {tab === 'memory' && <MemoryTab account={acc} />}
      {tab === 'skills' && <SkillsTab key={acc.id} accountId={acc.id} />}
      {tab === 'characters' && comic && <CharactersTab account={acc} />}
      {tab === 'layout' && wx && <LayoutTab key={acc.id} account={acc} profile={profile} onSaved={(p) => { setProfile(p); refetch() }} />}
    </div>
  )
}
