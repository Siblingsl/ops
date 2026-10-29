import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm, Dialog } from '@/components/dialog'
import { Button, Field, Input, Notice, Select, Switch, Textarea } from '@/components/ui'
import { api, ApiError, errorMessage, get, post, stream } from '@/lib/api'
import { runeLen } from '@/lib/format'
import { normalizeDefinitionFields, publishDigest, serializeSkillMarkdown } from '@/lib/skill-canon'
import { skillFields, skillFormats, skillPlatforms, skillTasks, type SkillDef, type SkillDefinition, type SkillForm, type SkillImpact, type SkillList, type SkillWarning } from '@/lib/skills'
import { useAccounts, useMe } from '@/lib/session'
import { useSkillDraftGuard } from './use-skill-draft-guard'

export default function SkillEditor({ def: initialDef, copyFrom, initial, fixedAccount, onClose, onSaved }: {
  def?: SkillDefinition; copyFrom?: SkillDefinition; initial: SkillForm; fixedAccount?: string; onClose: () => void; onSaved: () => void
}) {
  const me = useMe()
  const accounts = useAccounts()
  const [def, setDef] = useState(initialDef)
  const [form, setForm] = useState(initial)
  const [baseline, setBaseline] = useState(JSON.stringify(initial))
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftBrief, setDraftBrief] = useState('')
  const [stage, setStage] = useState('')
  const [importContent, setImportContent] = useState('')
  const [importMode, setImportMode] = useState(false)
  const [warnings, setWarnings] = useState<SkillWarning[]>([])
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [impact, setImpact] = useState<SkillImpact | null>(null)
  const [stale, setStale] = useState(false)
  const [failure, setFailure] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [reauth, setReauth] = useState(false)
  const alive = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const impactRequest = useRef(0)
  const builtinCopy = copyFrom?.scope === 'builtin'
  const viewer = me.data?.role === 'viewer'
  const publicScope = form.scope !== 'personal'
  const dirty = JSON.stringify(form) !== baseline || !!importContent || !!draftBrief
  const { allow, clear } = useSkillDraftGuard(dirty, busy || drafting)
  const close = async () => { if (await allow()) { clear(); onClose() } }
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  const set = (patch: Partial<SkillForm>) => { setForm(f => ({ ...f, ...patch })); setConfirmPublic(false) }

  const quota = useQuery({
    queryKey: ['skill-quota', me.data?.user_id, me.data?.workspace.id, form.scope, form.account_id],
    queryFn: ({ signal }) => get<SkillList>('/skills?' + new URLSearchParams({ view: 'library', scope: form.scope, limit: '1', ...(form.scope === 'account' ? { account_id: form.account_id! } : {}) }), { signal }),
    enabled: !def && (form.scope !== 'account' || !!form.account_id),
  })
  const bindings = useQuery({
    queryKey: ['skill-bindings', me.data?.user_id, me.data?.workspace.id, form.account_id],
    queryFn: ({ signal }) => get<{ public: { count: number; limit: number } }>(`/accounts/${form.account_id}/skill-bindings`, { signal }),
    enabled: !def && form.scope === 'account' && !!form.account_id,
  })
  const limit = form.scope === 'account' ? 30 : 50
  const quotaFull = !def && (quota.data?.total ?? 0) >= limit
  const bindingsFull = !def && form.scope === 'account' && bindings.data && bindings.data.public.count >= bindings.data.public.limit
  const quotaPending = !def && (quota.isPending || form.scope === 'account' && bindings.isPending)
  const fetchImpact = async (keepDraft: boolean, rebase = false) => {
    if (!def) return
    const request = ++impactRequest.current
    setBusy(true); setFailure(''); setConfirmPublic(false); setImpact(null)
    try {
      const next = await get<SkillImpact>(`/skills/${def.id}/impact?action=update`)
      if (!alive.current || request !== impactRequest.current) return
      if (keepDraft && !rebase && next.base_revision !== def.revision) {
        if (alive.current) { setStale(true); setImpact(null); setFailure('服务器配置已更新，已保留读取时的内容；请明确选择重新载入或重新预览。') }
        return
      }
      if (!keepDraft || rebase) {
        const current = await get<SkillDefinition>(`/skills/${def.id}`)
        if (!alive.current || request !== impactRequest.current) return
        if (current.revision !== next.base_revision) { setStale(true); setFailure('服务器配置再次更新，请重新预览'); return }
        setDef(current)
        if (!keepDraft) {
          const fresh = { ...skillFields(current), scope: current.scope, account_id: current.account_id }
          setForm(fresh); setBaseline(JSON.stringify(fresh))
        }
      }
      if (alive.current) { setImpact(next); setStale(false) }
    } catch (e) { if (alive.current && request === impactRequest.current) setFailure(errorMessage(e)) } finally { if (alive.current && request === impactRequest.current) setBusy(false) }
  }
  useEffect(() => { if (def) void fetchImpact(true) }, [def?.id])

  const draft = async () => {
    if (!draftBrief.trim() || drafting || busy) return
    if ((form.name || form.instructions) && !(await confirm({ title: '替换当前技能草稿？', desc: '生成成功后将替换当前文字；失败仍保留原表单。', confirmText: '生成并替换' }))) return
    setDrafting(true); setFailure(''); setStage('准备起草')
    controller.current = new AbortController()
    try {
      const source = def ?? copyFrom
      const result = await stream<{ draft: SkillDef; ai_call_id: string }>('/skills/draft', {
        brief: draftBrief, ...(source ? { source_skill_id: source.id, source_revision: def ? impact?.base_revision ?? source.revision : source.revision } : {}),
        platforms: form.platforms, content_formats: form.content_formats, task_types: form.task_types, task_enabled: form.task_enabled, agent_enabled: form.agent_enabled,
      }, { signal: controller.current.signal, onEvent: (name, data) => {
        if (name === 'stage' && alive.current) setStage(data.stage === 'queued' ? '排队中' : data.stage === 'validating' ? '校验草稿' : '正在起草')
      } })
      if (!alive.current) return
      setForm(f => ({ ...f, ...skillFields({ ...result.draft, status: f.status }) })); setConfirmPublic(false)
      toast.success('草稿已生成，请确认后保存')
    } catch (e) { if (alive.current) setFailure(errorMessage(e)) } finally { if (alive.current) { setDrafting(false); setStage('') } }
  }
  const parseImport = async () => {
    if ((form.name || form.instructions) && !(await confirm({ title: '用导入内容替换当前草稿？', confirmText: '解析并替换' }))) return
    setBusy(true); setFailure('')
    try {
      const parsed = await post<{ fields: SkillDef; warnings: SkillWarning[] }>('/skills/parse', { content: importContent })
      if (!alive.current) return
      setForm(f => ({ ...f, ...parsed.fields, status: 'active' })); setWarnings(parsed.warnings); setImportMode(true); setConfirmPublic(false)
    } catch (e) { if (alive.current) setFailure(errorMessage(e)) } finally { if (alive.current) setBusy(false) }
  }
  const chooseFile = async (file?: File) => {
    if (!file) return
    if (file.size > 64 * 1024) { setFailure('技能文件最多 64 KiB'); return }
    try { setImportContent(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())) }
    catch { setFailure('技能文件必须是有效的 UTF-8 文本') }
  }
  const save = async () => {
    if (busy || drafting || readOnly || unavailable || stale || (publicScope && !confirmPublic)) return
    if (def && !impact) return
    setBusy(true); setFailure('')
    const finalFields = skillFields(form)
    try {
      const body: Record<string, unknown> = def ? { ...finalFields, base_revision: impact!.base_revision, impact_token: impact!.impact_token }
        : builtinCopy ? { scope: form.scope, copy_from_id: copyFrom!.id }
          : importMode ? { scope: form.scope, import_content: serializeSkillMarkdown(form) }
            : { ...finalFields, scope: form.scope }
      if (!def && form.scope === 'account') body.account_id = form.account_id
      if (publicScope) body.publish_confirmation = { confirmed: confirmPublic, digest: await publishDigest({
        operation: def ? 'update' : 'create', skillId: def?.id ?? null, scope: form.scope, accountId: form.scope === 'account' ? form.account_id : null,
      }, finalFields) }
      const result = await api<{ binding?: unknown; affected_bindings?: number }>(def ? 'PUT' : 'POST', def ? `/skills/${def.id}` : '/skills', body)
      if (!alive.current) return
      clear(); toast.success(`${def ? '技能已保存' : '技能已创建'}；${result.binding || result.affected_bindings ? '已绑定，后续任务重新判定适用性' : '尚未绑定，请在账号档案中单项启用'}`)
      onSaved()
    } catch (e) {
      if (!alive.current) return
      if (e instanceof ApiError && e.code === 'stale') {
        impactRequest.current++
        setStale(true); setImpact(null); setConfirmPublic(false)
        setFailure('服务器配置已更新，当前编辑已保留；请重新载入或保留草稿重新预览。')
      } else {
        if (e instanceof ApiError && e.status === 401) setReauth(true)
        if (e instanceof ApiError && e.status === 403) setReadOnly(true)
        if (e instanceof ApiError && e.status === 404) setUnavailable(true)
        setFailure(errorMessage(e))
      }
    } finally { if (alive.current) setBusy(false) }
  }
  const entry = form.task_enabled ? form.agent_enabled ? 'both' : 'task' : 'agent'
  const normalized = normalizeDefinitionFields(form)
  const invalid = !normalized.name || !normalized.summary || !normalized.triggers || !/[^\p{White_Space}]/u.test(normalized.instructions)
    || runeLen(normalized.name) > 30 || runeLen(normalized.summary) > 60 || runeLen(normalized.triggers) > 120 || runeLen(normalized.instructions) > 1200
  const locked = busy || drafting || readOnly || unavailable
  return <Dialog open ariaLabel="技能编辑" title={def ? '编辑技能' : copyFrom ? '另存技能副本' : importMode ? '确认导入内容' : '新建技能'} width="max-w-2xl" onClose={() => void close()}>
    <div className="space-y-4">
      {failure && <Notice tone="gamboge">{failure}</Notice>}
      {reauth && <Notice tone="gamboge">登录已失效，草稿仍保留在当前页面。<a href="/login" target="_blank" rel="noopener noreferrer" className="underline">在新窗口登录</a><Button onClick={() => void me.refetch().then(() => setReauth(false))}>重新核验登录状态</Button></Notice>}
      {stale && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void fetchImpact(false)}>重新载入服务器值</Button><Button disabled={busy} onClick={() => void fetchImpact(true, true)}>保留草稿并重新预览</Button></div>}
      {def && !impact && !stale && !busy && <Button onClick={() => void fetchImpact(true)}>重新读取影响预览</Button>}
      {unavailable && <Button onClick={() => { setDef(undefined); setImpact(null); setUnavailable(false); setReadOnly(false); setForm(f => ({ ...f, scope: 'personal', account_id: '' })); setFailure('内容已保留为新的个人草稿，请确认后创建。') }}>另建为个人草稿</Button>}
      {!def && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="保存范围"><Select value={form.scope} disabled={locked || viewer || !!fixedAccount} onChange={e => set({ scope: e.target.value, account_id: '' })}>
          <option value="personal">个人（仅本人，跨工作区携带）</option>{!viewer && <><option value="workspace">工作区（全体成员可见）</option><option value="account">账号（保存后同时启用）</option></>}
        </Select></Field>
        {form.scope === 'account' && <Field label="目标账号"><Select value={form.account_id ?? ''} disabled={locked || !!fixedAccount} onChange={e => set({ account_id: e.target.value })}>
          <option value="">选择账号…</option>{accounts.data?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select></Field>}
      </div>}
      {form.scope === 'account' && !def && <Notice>保存后将同时为该账号启用这一条公共技能。</Notice>}
      {form.scope === 'personal' && <p className="text-xs text-mist-500">个人技能仅本人可见、跨工作区携带，需在每个账号档案中分别启用。</p>}
      {builtinCopy && <Notice>将完整内置内容另存为独立副本；保存后可编辑副本，原内置保持不变。</Notice>}
      <fieldset disabled={locked || builtinCopy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2"><Field label="名称" counter={{ value: runeLen(normalized.name), max: 30 }}><Input value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="用途（summary）" counter={{ value: runeLen(normalized.summary), max: 60 }}><Input value={form.summary} onChange={e => set({ summary: e.target.value })} /></Field></div>
        <Field label="触发说明（什么时候适用）" counter={{ value: runeLen(normalized.triggers), max: 120 }}><Input value={form.triggers} onChange={e => set({ triggers: e.target.value })} /></Field>
        <Field label="完整指令正文（Markdown，最多 1200 字，不自动截断）" counter={{ value: runeLen(normalized.instructions), max: 1200 }}><Textarea rows={7} value={form.instructions} onChange={e => set({ instructions: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">{([
          ['platforms', '适用平台（空 = 全部）', skillPlatforms], ['content_formats', '作品形态（空 = 全部）', skillFormats],
          ['task_types', '生效任务（空 = 默认创作集合）', skillTasks.map(value => ({ value, label: value }))],
        ] as const).map(([key, label, options]) => <Field key={key} label={label}><div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">{options.map(option => <button key={option.value} type="button" disabled={key === 'task_types' && !form.task_enabled}
          onClick={() => set({ [key]: form[key].includes(option.value) ? form[key].filter(v => v !== option.value) : [...form[key], option.value] })}
          className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-40 ${form[key].includes(option.value) ? 'border-ink-600 bg-ink-50' : 'border-mist-200'}`}>{option.label}</button>)}</div></Field>)}</div>
        <Field label="生效入口"><div className="flex gap-4 text-sm">{[{ value: 'task', label: '仅生成' }, { value: 'agent', label: '仅智能体' }, { value: 'both', label: '两者' }].map(item => <label key={item.value} className="flex items-center gap-1">
          <input type="radio" name="skill-entry" checked={entry === item.value} onChange={() => set({ task_enabled: item.value !== 'agent', agent_enabled: item.value !== 'task' })} />{item.label}</label>)}</div></Field>
        {!form.task_enabled && <p className="text-xs text-mist-500">仅智能体生效：保留任务配置，但当前任务筛选不生效。</p>}
        {def && <Field label="状态"><Select value={form.status} onChange={e => set({ status: e.target.value })}><option value="active">启用中</option><option value="disabled">停用（保留配置与绑定）</option></Select></Field>}
      </fieldset>
      {impact && <Notice>保存将影响 {impact.affected_bindings} 条绑定{impact.accounts.length ? `（${impact.accounts.map(a => a.name).join('、')}）` : ''}；已生成的作品不追溯修改。</Notice>}
      {!def && <div className="space-y-2 text-xs text-mist-500">
        <p>定义额度 {quota.data?.total ?? '…'} / {limit}</p>
        {(quotaFull || bindingsFull) && <Notice tone="gamboge">{quotaFull ? '该范围定义额度已满' : '账号公共绑定额度已满'}。请先单项管理已有技能。<a className="underline" href={bindingsFull ? `/a/${form.account_id}/profile?tab=skills` : '/settings/skills'}>管理已有技能</a></Notice>}
        {(quota.error || bindings.error) && <Notice tone="gamboge">额度读取失败，保存已暂停。<Button onClick={() => { void quota.refetch(); if (form.scope === 'account') void bindings.refetch() }}>重试额度检查</Button></Notice>}
      </div>}
      {publicScope && <label className="flex items-start gap-2 rounded border border-mist-200 bg-mist-50 p-3 text-sm"><Switch checked={confirmPublic} disabled={locked} onChange={setConfirmPublic} />
        <span>我确认将以上技能内容公开给{form.scope === 'workspace' ? '当前工作区全体成员' : '该账号所在工作区全体成员（含观察者）'}。{copyFrom?.scope === 'personal' && '原个人定义保留，公开副本独立。'}</span></label>}
      {publicScope && !confirmPublic && <p className="text-xs text-gamboge-700">公开保存前需勾选确认；未确认不会写入。</p>}
      {importMode && <Notice tone="gamboge">{warnings.length ? `解析告警 ${warnings.length} 条：${warnings.map(w => `${w.field}：${w.message}`).join('；')}` : '导入内容已解析，确认字段后保存。'}</Notice>}
      {!viewer && !builtinCopy && !importMode && <div className="space-y-2 rounded border border-mist-200 p-3">
        <p className="text-sm font-medium">AI 辅助起草（可选）</p><Textarea rows={2} disabled={locked} placeholder="描述你想要的技能，例如：起草小红书笔记开头的方法" value={draftBrief} onChange={e => setDraftBrief(e.target.value)} />
        <Button variant="ghost" loading={drafting} disabled={busy || !draftBrief.trim()} onClick={() => void draft()}>生成草稿</Button>{stage && <p role="status">{stage}</p>}
        <p className="text-xs text-mist-500">草稿需确认后保存；失败保留当前表单。调用产生的用量仍计入用量记录。</p>
      </div>}
      {!def && !copyFrom && !importMode && <div className="space-y-2 rounded border border-mist-200 p-3">
        <p className="text-sm font-medium">导入 .md 文件内容</p><input type="file" accept=".md,text/markdown,text/plain" aria-label="选择技能文件" disabled={locked} onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = '' }} />
        <Textarea rows={4} disabled={locked} aria-label="导入 Markdown 内容" value={importContent} onChange={e => setImportContent(e.target.value)} />
        <Button variant="ghost" loading={busy} disabled={drafting || !importContent.trim()} onClick={() => void parseImport()}>解析预览</Button>
      </div>}
      <div className="flex justify-end gap-2 border-t border-mist-100 pt-3"><Button variant="ghost" disabled={busy || drafting} onClick={() => void close()}>取消</Button>
        <Button variant="primary" loading={busy} disabled={drafting || readOnly || unavailable || invalid || stale || !!def && !impact || publicScope && !confirmPublic || !!quotaFull || !!bindingsFull || quotaPending || !!quota.error || !!bindings.error || form.scope === 'account' && !form.account_id}
          onClick={() => void save()}>{def ? '保存修改' : '创建技能'}</Button></div>
    </div>
  </Dialog>
}
