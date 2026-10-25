import { useQuery } from '@tanstack/react-query'
import { Download, FileUp, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Notice, PageHeader, PageLoading, Select, Switch, Tabs, Textarea } from '@/components/ui'
import { api, errorMessage, get, post, stream } from '@/lib/api'
import { publishDigest as canonPublishDigest, serializeSkillMarkdown } from '@/lib/skill-canon'
import { useMe } from '@/lib/session'

// DEV-SK4 / 23 文档第 12 节：技能库页。个人默认；公开目标必须单独确认；
// 导入先解析预览；编辑 / 删除前展示影响；409 保留本地编辑。

export interface SkillDef {
  name: string
  summary: string
  triggers: string
  instructions: string
  platforms: string[]
  content_formats: string[]
  task_types: string[]
  task_enabled: boolean
  agent_enabled: boolean
  status: string
}

export interface SkillDefinition extends SkillDef {
  id: string
  scope: string
  account_id: string | null
  revision: number
  content_hash: string
  origin: string
  source_key: string
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

export interface SkillWarning { code: string; field: string; message: string }

const PLATFORMS = [
  { value: 'wechat_mp', label: '公众号' },
  { value: 'xhs', label: '小红书' },
  { value: 'toutiao', label: '今日头条' },
]
const FORMATS = [
  { value: 'long_article', label: '长图文' }, { value: 'image_note', label: '图文笔记' },
  { value: 'comic', label: '漫画' }, { value: 'qa_article', label: '问答体' },
  { value: 'briefing', label: '资讯简报' }, { value: 'list_note', label: '清单合集' },
  { value: 'card_post', label: '图文卡片' }, { value: 'script', label: '口播脚本' },
  { value: 'micro_post', label: '微头条' },
]
const TASKS = [
  'outline', 'section_draft', 'section_edit', 'title', 'summary', 'rewrite_plan',
  'section_rewrite', 'comic_storyboard', 'comic_panel_text', 'comic_rewrite',
  'section_continue', 'hook_suggest', 'topic_suggest', 'topic_hot_suggest',
  'image_suggest', 'organize_notes', 'daily_recommend', 'strategy_outline',
  'tag_suggest', 'outline_review', 'read_through', 'polish_check', 'fix_suggest', 'layout_suggest', 'copilot_chat',
]
const REASON_TEXT: Record<string, string> = {
  builtin_retired: '内置版本已退役', disabled: '技能已停用', task_disabled: '生成入口未开启',
  agent_disabled: '智能体入口未开启', platform_mismatch: '平台不匹配', format_mismatch: '作品形态不匹配',
  task_mismatch: '任务不在适用范围', candidate_limit: '超出入选上限', budget_exceeded: '超出装配预算',
  not_loaded: '未在智能体中加载',
}

export function skillScopeLabel(scope: string) {
  return scope === 'builtin' ? '内置' : scope === 'workspace' ? '工作区' : scope === 'account' ? '账号' : '个人'
}

export type SkillForm = SkillDef & { scope: string; account_id: string | null }

const emptyForm = (): SkillForm => ({
  name: '', summary: '', triggers: '', instructions: '',
  platforms: [], content_formats: [], task_types: [],
  task_enabled: true, agent_enabled: true, status: 'active', scope: 'personal', account_id: '',
})

export default function Skills() {
  const me = useMe()
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [editing, setEditing] = useState<null | { def: SkillDefinition | null; form: SkillForm; warnings?: SkillWarning[]; importMode?: boolean }>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['skills', tab, q, accountFilter, cursor],
    queryFn: () => get<{ items: SkillDefinition[]; next_cursor: string | null; total: number }>(
      `/skills?view=library&limit=12&scope=${tab === 'all' ? '' : tab}&q=${encodeURIComponent(q)}` +
      (tab === 'account' && accountFilter ? `&account_id=${accountFilter}` : '') + (cursor ? `&cursor=${cursor}` : '')),
  })
  const list = data?.items ?? []
  const loadMore = () => setCursor(data?.next_cursor ?? null)

  return (
    <div className="animate-fade-in">
      {/* 23 文档 10.2 节：viewer 也可维护本人个人库（表单只提供个人范围）；公共编辑按 canEditScope 控制。 */}
      <PageHeader
        title="写作技能"
        desc="可复用的创作指令包：按账号启用后进入 AI 生成与智能体。个人技能仅本人可见、跨工作区携带，需在每个账号分别启用。"
        action={(
          <Button variant="primary" onClick={() => setEditing({ def: null, form: emptyForm() })}><Plus className="size-4" />新建技能</Button>
        )}
      />
      <Card>
        <CardHeader title={<Tabs value={tab} onChange={(v) => { setTab(v); setCursor(null) }} items={[
          { value: 'all', label: '全部' },
          { value: 'personal', label: '我的技能' },
          { value: 'workspace', label: '工作区' },
          { value: 'account', label: '账号' },
          { value: 'builtin', label: '内置' },
        ]} />} action={
          <div className="flex items-center gap-2">
            {tab === 'account' && (
              <AccountPicker value={accountFilter} onChange={(v) => { setAccountFilter(v); setCursor(null) }} allLabel="选择账号查看专属技能" />
            )}
            <div className="relative w-44">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mist-400" />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setCursor(null) }} placeholder="搜索名称、用途、触发" className="h-8 pl-8 text-[13px]" />
            </div>
          </div>
        } />
        <div className="divide-y divide-mist-100">
          {isLoading && <PageLoading />}
          {!isLoading && list.length === 0 && (
            <Empty title="还没有匹配的技能" desc="新建一条个人技能，或从内置技能另存为副本。" />
          )}
          {list.map((s) => (
            <div key={s.id} className="flex items-start gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium text-ink-800">{s.name}</span>
                  <Badge>{skillScopeLabel(s.scope)}</Badge>
                  {s.status === 'disabled' && <Badge className="bg-mist-100 text-mist-500">已停用</Badge>}
                  {s.origin === 'imported' && <Badge className="bg-mist-100 text-mist-500">导入</Badge>}
                  {s.origin === 'copied' && <Badge className="bg-mist-100 text-mist-500">另存</Badge>}
                  <span className="text-[12px] text-mist-400">v{s.revision}</span>
                </div>
                <p className="mt-0.5 truncate text-[13px] text-mist-500">{s.summary}</p>
                <p className="mt-0.5 truncate text-[12px] text-mist-400">触发：{s.triggers}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a href={`/api/v1/skills/${s.id}/export`} download="写作技能.md" title="导出 .md"
                  className="cursor-pointer rounded p-1.5 text-mist-400 hover:bg-mist-100 hover:text-ink-600"><Download className="size-4" /></a>
                {canEditScope(me.data?.role, s.scope) && (
                  <button type="button" title="编辑" onClick={() => setEditing({ def: s, form: { ...s } })}
                    className="cursor-pointer rounded p-1.5 text-mist-400 hover:bg-mist-100 hover:text-ink-600"><Pencil className="size-4" /></button>
                )}
                {canEditScope(me.data?.role, s.scope) && (
                  <DeleteSkillButton skill={s} onDeleted={() => setCursor(null)} />
                )}
              </div>
            </div>
          ))}
        </div>
        {data?.next_cursor && (
          <div className="border-t border-mist-100 px-5 py-2.5 text-center">
            <Button variant="ghost" onClick={loadMore}>加载更多（共 {data.total} 条）</Button>
          </div>
        )}
      </Card>
      {editing && (
        <SkillEditor
          me={me}
          def={editing.def}
          initial={editing.form}
          warnings={editing.warnings}
          importMode={editing.importMode}
          onClose={() => setEditing(null)}
          onImport={(form, warnings) => setEditing({ def: null, form, warnings, importMode: true })}
        />
      )}
    </div>
  )
}

function canEditScope(role: string | undefined, scope: string) {
  if (scope === 'personal') return true
  return role === 'owner' || role === 'editor'
}

function DeleteSkillButton({ skill, onDeleted }: { skill: SkillDefinition; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [impact, setImpact] = useState<null | { affected_bindings: number; accounts: { id: string; name: string; workspace_name: string; bindings: number }[]; impact_token: string }>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setOpen(true)
    try {
      setImpact(await get(`/skills/${skill.id}/impact?action=delete`))
    } catch (e) {
      toast.error(errorMessage(e)); setOpen(false)
    }
  }
  const del = async () => {
    setBusy(true)
    try {
      const rev = new URLSearchParams({ confirm: 'true', base_revision: String(skill.revision), impact_token: impact!.impact_token })
      await api('DELETE', `/skills/${skill.id}?` + rev.toString())
      toast.success('技能已删除')
      setOpen(false); onDeleted()
    } catch (e) {
      toast.error(errorMessage(e))
      if ((e as { code?: string }).code === 'stale') { setOpen(false); onDeleted() }
    } finally { setBusy(false) }
  }
  return (
    <>
      <button type="button" title="删除" onClick={load}
        className="cursor-pointer rounded p-1.5 text-mist-400 hover:bg-mist-100 hover:text-red-600"><Trash2 className="size-4" /></button>
      {open && impact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" role="dialog" aria-label="删除技能">
          <Card className="w-full max-w-md space-y-3 p-5">
            <h2 className="text-[15px] font-semibold text-ink-800">删除技能「{skill.name}」</h2>
            <p className="text-[13px] leading-relaxed text-mist-600">
              将删除 {impact.affected_bindings} 条绑定，影响 {impact.accounts.length} 个账号：
              {impact.accounts.map((a) => a.name).join('、') || '（无绑定）'}。已生成的作品不受影响。此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
              <Button variant="primary" loading={busy} onClick={del}>确认删除</Button>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

function SkillEditor({ me, def, initial, warnings, importMode, onClose, onImport }: {
  me: { data?: { role?: string; user_id?: string } | null }
  def: SkillDefinition | null
  initial: ReturnType<typeof emptyForm>
  warnings?: SkillWarning[]
  importMode?: boolean
  onClose: () => void
  onImport: (form: SkillForm, warnings: SkillWarning[]) => void
}) {
  const isEdit = !!def
  const isViewer = me.data?.role === 'viewer'
  const canPublish = me.data?.role === 'owner' || me.data?.role === 'editor'
  const [form, setForm] = useState(initial)
  // 导入确认会替换编辑状态（onImport 重建 initial）；同步表单但不覆盖用户后续修改。
  useEffect(() => { setForm(initial) }, [initial])
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [importContent, setImportContent] = useState('')
  const [importWarnings] = useState<SkillWarning[]>(importMode ? (warnings ?? []) : [])
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [baseRevision] = useState(def?.revision ?? 0)
  const [impactToken, setImpactToken] = useState('')
  const [impact, setImpact] = useState<null | { affected_bindings: number; accounts: { name: string }[] }>(null)
  const [stale, setStale] = useState(false)
  const [draftBrief, setDraftBrief] = useState('')
  const set = (patch: Partial<ReturnType<typeof emptyForm>>) => {
    setForm((f) => ({ ...f, ...patch }))
    // 更改公开内容或目标会取消已勾选的公开确认（12.2 节）。
    setConfirmPublic(false)
  }
  const publicScope = form.scope === 'workspace' || form.scope === 'account'

  // 编辑：载入影响预览（13 节）。
  const loadImpact = async (silent = false) => {
    if (!def) return
    try {
      const token = await get<{ impact_token: string; affected_bindings: number; accounts: { name: string }[] }>(`/skills/${def.id}/impact?action=update`)
      setImpactToken(token.impact_token); setImpact(token); setStale(false)
    } catch (e) {
      if (!silent) toast.error(errorMessage(e))
    }
  }
  if (isEdit && !impactToken && !stale) void loadImpact(true)

  const toggleArr = (key: 'platforms' | 'content_formats' | 'task_types', v: string) => {
    const cur = form[key]
    set({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<ReturnType<typeof emptyForm>>)
  }

  // AI 草拟：保留表单；成功显示完整可编辑草稿；失败保留原表单（12.1 节第 4 项）。
  const draft = async () => {
    if (!draftBrief.trim()) { toast.error('请先填写你的需求（brief）'); return }
    setDrafting(true)
    try {
      const done = await stream<{ draft: SkillDef; ai_call_id: string }>('/skills/draft', {
        brief: draftBrief,
        ...(form.scope === 'account' && form.account_id ? {} : {}),
      })
      // 只采纳四个文字字段；条件与开关由服务端按请求确定。
      setForm((f) => ({ ...f, name: done.draft.name, summary: done.draft.summary, triggers: done.draft.triggers, instructions: done.draft.instructions }))
      setConfirmPublic(false)
      toast.success('草稿已生成，请确认后保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally { setDrafting(false) }
  }

  // 导入：先解析预览，确认后保存。
  const parseImport = async () => {
    setBusy(true)
    try {
      const r = await post<{ fields: SkillDef; warnings: SkillWarning[] }>('/skills/parse', { content: importContent })
      onImport({ ...emptyForm(), ...r.fields, scope: form.scope, account_id: form.account_id ?? '' }, r.warnings)
      toast.success('解析成功，请确认内容后保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally { setBusy(false) }
  }

  const save = async () => {
    setBusy(true)
    try {
      if (importMode && importContent.trim()) {
        // 预览后用户可能修改字段：按最终表单重新序列化，不能把原始文件原文
        // 直接提交而丢弃编辑（4.2 节第 5 项）。
        const finalMd = serializeSkillMarkdown(form)
        const body: Record<string, unknown> = { scope: form.scope, import_content: finalMd }
        if (form.scope === 'account') {
          body.account_id = form.account_id
          body.publish_confirmation = { confirmed: true, digest: await publishDigest('create', null, form) }
        } else if (form.scope === 'workspace') {
          body.publish_confirmation = { confirmed: true, digest: await publishDigest('create', null, form) }
        }
        await post('/skills', body)
      } else if (isEdit && def) {
        const body: Record<string, unknown> = { ...form, base_revision: baseRevision || def.revision, impact_token: impactToken }
        if (def.scope !== 'personal') {
          if (!confirmPublic) { toast.error('公开技能的修改需要单独确认可见范围'); setBusy(false); return }
          body.publish_confirmation = { confirmed: true, digest: await publishDigest('update', def, form) }
        }
        await api('PUT', `/skills/${def.id}`, body)
      } else {
        // 完整字段创建（import_content 模式已在导入确认时序列化为字段表单）。
        const body: Record<string, unknown> = { ...form }
        if (form.scope === 'account') {
          body.account_id = form.account_id
          body.publish_confirmation = { confirmed: true, digest: await publishDigest('create', null, form) }
        } else {
          // 非账号层不接受 account_id（空串也会被服务端拒绝）。
          delete body.account_id
          if (form.scope === 'workspace') body.publish_confirmation = { confirmed: true, digest: await publishDigest('create', null, form) }
        }
        await post('/skills', body)
      }
      // publishDigest 计算公开确认摘要（5.2.1 节 sp1），实现见文件底部。

      toast.success(isEdit ? '技能已保存' : '技能已创建')
      window.dispatchEvent(new CustomEvent('skills-changed'))
      onClose()
      location.reload()
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string }
      if (err.code === 'stale') {
        // 服务器配置已更新：保留本地编辑，可重新载入或重新预览（12.2 节）。
        setStale(true)
        toast.error('服务器配置已更新，请重新预览后再保存（当前编辑内容已保留）')
        await loadImpact(true)
      } else {
        toast.error(errorMessage(e))
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4" role="dialog" aria-label="技能编辑">
      <Card className="my-8 w-full max-w-2xl space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink-800">{isEdit ? `编辑技能（v${def!.revision}）` : importMode ? '确认导入内容' : '新建技能'}</h2>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        </div>
        {stale && (
          <Notice tone="gamboge">服务器配置已更新。你可以重新载入服务器值，或保留当前编辑并重新预览后再保存。</Notice>
        )}
        {!isEdit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="保存范围">
              <Select value={form.scope} onChange={(e) => set({ scope: e.target.value })} disabled={isViewer}>
                <option value="personal">个人（仅本人，跨工作区携带）</option>
                {canPublish && <option value="workspace">工作区（全体成员可见）</option>}
                {canPublish && <option value="account">账号（保存后同时启用）</option>}
              </Select>
            </Field>
            {form.scope === 'account' && <AccountPicker label="目标账号" value={form.account_id ?? ''} onChange={(v) => set({ account_id: v })} allLabel="选择账号…" />}
          </div>
        )}
        {form.scope === 'personal' && !isEdit && (
          <p className="text-[12px] text-mist-400">个人技能仅本人可见；要在某个账号生效，需在该账号档案中手动启用。</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="名称" counter={{ value: form.name.length, max: 30 }}>
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="用途（summary）" counter={{ value: form.summary.length, max: 60 }}>
            <Input value={form.summary} onChange={(e) => set({ summary: e.target.value })} />
          </Field>
        </div>
        <Field label="触发说明（什么时候适用）" counter={{ value: form.triggers.length, max: 120 }}>
          <Input value={form.triggers} onChange={(e) => set({ triggers: e.target.value })} />
        </Field>
        <Field label="完整指令正文（Markdown，最多 1200 字，不自动截断）" counter={{ value: form.instructions.length, max: 1200 }}>
          <Textarea rows={7} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="适用平台（空 = 全部）">
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => (
                <button key={p.value} type="button" onClick={() => toggleArr('platforms', p.value)}
                  className={`cursor-pointer rounded-full border px-2 py-0.5 text-[12px] ${form.platforms.includes(p.value) ? 'border-ink-600 bg-ink-50 text-ink-700' : 'border-mist-200 text-mist-500'}`}>{p.label}</button>
              ))}
            </div>
          </Field>
          <Field label="作品形态（空 = 全部）">
            <div className="flex flex-wrap gap-1.5">
              {FORMATS.map((p) => (
                <button key={p.value} type="button" onClick={() => toggleArr('content_formats', p.value)}
                  className={`cursor-pointer rounded-full border px-2 py-0.5 text-[12px] ${form.content_formats.includes(p.value) ? 'border-ink-600 bg-ink-50 text-ink-700' : 'border-mist-200 text-mist-500'}`}>{p.label}</button>
              ))}
            </div>
          </Field>
          <Field label="生效任务（空 = 默认创作集合）">
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {TASKS.map((t) => (
                <button key={t} type="button" onClick={() => toggleArr('task_types', t)}
                  className={`cursor-pointer rounded-full border px-2 py-0.5 text-[12px] ${form.task_types.includes(t) ? 'border-ink-600 bg-ink-50 text-ink-700' : 'border-mist-200 text-mist-500'}`}>{t}</button>
              ))}
            </div>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="生效入口">
            <div className="space-y-1.5 text-[13px] text-mist-700">
              <label className="flex items-center gap-2"><Switch checked={form.task_enabled} onChange={(v) => set({ task_enabled: v })} />用于普通 AI 生成任务</label>
              <label className="flex items-center gap-2"><Switch checked={form.agent_enabled} onChange={(v) => set({ agent_enabled: v })} />用于智能体（可被发现并加载）</label>
              {!form.task_enabled && !form.agent_enabled && <p className="text-[12px] text-red-600">两个入口不能同时关闭。</p>}
            </div>
          </Field>
          {isEdit && (
            <Field label="状态">
              <Select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="active">启用中</option>
                <option value="disabled">停用（保留配置与绑定）</option>
              </Select>
            </Field>
          )}
        </div>
        {!form.task_enabled && form.agent_enabled && (
          <p className="text-[12px] text-mist-400">仅智能体生效：任务筛选配置暂不生效，保留但不使用。</p>
        )}

        {isEdit && impact && (
          <Notice tone="ink">
            保存将影响 {impact.affected_bindings} 条绑定{impact.accounts.length ? `（${impact.accounts.map((a) => a.name).join('、')}）` : ''}；
            修改一个定义会影响所有引用它的账号的后续生成，已生成的作品不追溯修改。
          </Notice>
        )}

        {publicScope && (isEdit || !importMode) && (
          <label className="flex items-start gap-2 rounded-md border border-mist-200 bg-mist-50 p-3 text-[13px] text-mist-700">
            <Switch checked={confirmPublic} onChange={setConfirmPublic} />
            <span>我确认将以上技能内容公开给{form.scope === 'workspace' ? '当前工作区全体成员' : '该账号所在工作区全体成员（含观察者）'}。
              {def?.scope === 'personal' && '公开副本不会改变原个人技能。'}</span>
          </label>
        )}
        {publicScope && !confirmPublic && (
          <p className="text-[12px] text-gamboge-700">公开保存前需勾选确认；未确认不会写入。</p>
        )}

        {(importWarnings.length > 0 || (importMode && !isEdit)) && (
          <Notice tone="gamboge">
            {importWarnings.length > 0 ? `解析告警 ${importWarnings.length} 条：` + importWarnings.map((w) => `${w.field}：${w.message}`).join('；') : '导入内容已解析，确认字段后保存。'}
          </Notice>
        )}

        {!isEdit && !importMode && (
          <div className="rounded-md border border-mist-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-mist-700"><Sparkles className="size-4" />AI 辅助起草（可选）</div>
            <Textarea rows={2} placeholder="描述你想要的技能，例如：起草小红书笔记开头的方法" value={draftBrief} onChange={(e) => setDraftBrief(e.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" loading={drafting} onClick={draft}>生成草稿</Button>
            </div>
            <p className="mt-1 text-[12px] text-mist-400">草稿只填入表单供你修改，不会自动保存；失败时保留当前表单。</p>
          </div>
        )}
        {!isEdit && !importMode && (
          <div className="rounded-md border border-mist-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-mist-700"><FileUp className="size-4" />导入 .md 文件内容</div>
            <Textarea rows={4} aria-label="导入 Markdown 内容" placeholder={'---\nformat_version: 1\nname: …\n---\n正文'} value={importContent} onChange={(e) => setImportContent(e.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" loading={busy} disabled={!importContent.trim()} onClick={parseImport}>解析预览</Button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-mist-100 pt-3">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy}
            disabled={publicScope && !confirmPublic && (isEdit || !importMode) || (!form.task_enabled && !form.agent_enabled) || (form.scope === 'account' && !form.account_id)}
            onClick={save}>{isEdit ? '保存修改' : '创建技能'}</Button>
        </div>
      </Card>
    </div>
  )
}

// publishDigest 用与服务端相同的规范编码（5.2.1 节 sp1，见 lib/skill-canon.ts）计算
// 公开确认摘要：覆盖最终规范化字段与目标。服务端在权限与字段校验后验证摘要。
async function publishDigest(op: 'create' | 'update', def: SkillDefinition | null, form: SkillForm): Promise<string> {
  return canonPublishDigest({
    operation: op,
    skillId: op === 'update' ? def!.id : null,
    scope: form.scope === 'account' ? 'account' : 'workspace',
    accountId: form.scope === 'account' ? (form.account_id || null) : null,
  }, {
    name: form.name, summary: form.summary, triggers: form.triggers, instructions: form.instructions,
    platforms: form.platforms, content_formats: form.content_formats, task_types: form.task_types,
    task_enabled: form.task_enabled, agent_enabled: form.agent_enabled, status: form.status,
  })
}

function AccountPicker({ value, onChange, label, allLabel }: { value: string; onChange: (v: string) => void; label?: string; allLabel?: string }) {
  const { data } = useQuery({ queryKey: ['accounts'], queryFn: () => get<{ id: string; name: string; platform: string }[]>('/accounts') })
  const select = (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label ?? '账号'}>
      <option value="">{allLabel ?? '全部账号'}</option>
      {(data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </Select>
  )
  if (!label) return select
  return <Field label={label}>{select}</Field>
}

export function skillReasonText(reason: string | null | undefined) {
  if (!reason) return ''
  return REASON_TEXT[reason] ?? reason
}
