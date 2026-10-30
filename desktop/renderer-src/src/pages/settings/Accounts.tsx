import { ChevronDown, Pencil, Plus, Power, RefreshCw, Search, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AccountCreateForm, credTone, CredentialPanel } from '@/components/account-forms'
import { confirm, Dialog } from '@/components/dialog'
import { PlatformConnectionCard } from '@/components/platform-connection'
import { Badge, Button, Card, CardHeader, cn, Empty, Field, Input, Notice, PageHeader, PageLoading, PlatformMark, platformFormatLabel, platformLabel, platformFormats, roleReadOnlyHint, Switch, Textarea } from '@/components/ui'
import { ApiError, del, errorMessage, get, patch, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { forgetAccount, useAccounts, useCurrentAccountSelection, useInvalidate, useMe } from '@/lib/session'
import type { Account, ContentFormat, Platform } from '@/lib/types'
import { requestDesktopAccountSwitcher, requestDesktopLeaveGuard, useSettingsDraft } from '@/lib/desktop-settings'

type Filter = 'all' | 'active' | 'disabled'

/** 账号类型迁移弹窗（D-123 / DEV-415）：同平台内改类型，已有作品保持原类型。 */
function ChangeTypeDialog({ account, open, onClose, onChanged }: {
  account: Account
  open: boolean
  onClose: () => void
  onChanged: (a: Account, summary: Record<string, unknown>) => void
}) {
  const options = platformFormats[account.platform].filter((f) => f !== account.content_format)
  const [format, setFormat] = useState<ContentFormat>(options[0])
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState<{ works: number; cards: number } | null>(null)
  const [impactError, setImpactError] = useState('')
  const [impactAttempt, setImpactAttempt] = useState(0)
  useSettingsDraft(false, busy)

  useEffect(() => {
    if (!open) return
    setFormat(options[0])
    setImpact(null)
    setImpactError('')
    let alive = true
    void (async () => {
      try {
        const cardRequest = get<{ id: string }[]>(`/accounts/${account.id}/characters`).catch((e) => {
          if (e instanceof ApiError && e.status === 422 && account.content_format !== 'comic') return [] as { id: string }[]
          throw e
        })
        const [works, cards] = await Promise.all([
          get<{ id: string }[]>(`/accounts/${account.id}/works`),
          cardRequest,
        ])
        if (alive) setImpact({ works: works.length, cards: cards.length })
      } catch (e) {
        if (alive) setImpactError(errorMessage(e))
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account.id, impactAttempt])

  const submit = async () => {
    setBusy(true)
    try {
      // 服务端只在类型确实变化时返回 {account, type_change}；竞态下（例如他人已改为同类型）
      // 返回裸账号对象，这里两种形态都接受，避免把正常响应误判为失败。
      type ChangeTypeRes = Account & { account?: Account; type_change?: Record<string, unknown> }
      const res = await patch<ChangeTypeRes>(`/accounts/${account.id}`, {
        content_format: format,
        confirm_type_change: true,
      })
      const updated = res.account ?? res
      if (!updated?.id) throw new Error('服务端未返回更新后的账号，请刷新后重试。')
      toast.success(`${account.platform === 'toutiao' ? '默认创作形态' : '账号类型'}已改为「${platformFormatLabel(account.platform, format)}」`)
      onChanged(updated, res.type_change ?? {})
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={account.platform === 'toutiao' ? '修改默认创作形态' : '修改账号类型'}
      desc={account.platform === 'toutiao' ? '只改变后续创作的默认选项；每篇仍可选择文章或微头条，已有作品、选题和计划保持原形态。' : '同平台内可以更换类型；已有作品不受影响，新作品使用新类型。'}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !impact || !options.length}>
            {busy ? '提交中…' : '确认修改'}
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        {impactError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12.5px] text-danger" role="alert">
          <span>读取修改影响失败：{impactError}。请重试读取后再确认。</span>
          <Button size="sm" variant="secondary" onClick={() => setImpactAttempt((attempt) => attempt + 1)}>重新读取修改影响</Button>
        </div>}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[12.5px] font-medium text-mist-600">{account.platform === 'toutiao' ? '选择新的默认创作形态' : '选择新的账号类型'}</legend>
          {options.map((f) => (
            <label key={f} className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-[13px] transition-colors',
              format === f ? 'border-ink-600 bg-ink-50' : 'border-mist-200 hover:border-mist-300',
            )}>
              <input type="radio" name="change-type" className="mt-0.5 accent-ink-600" checked={format === f} onChange={() => setFormat(f)} />
              <span>
                <span className="font-medium text-ink-800">{platformFormatLabel(account.platform, f)}</span>
                {f === 'comic' && <span className="ml-2 text-[12px] text-mist-500">角色卡 + 分镜脚本 + 逐格文案</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="rounded-lg bg-mist-50 p-3 text-[12.5px] leading-relaxed text-mist-700">
          <p className="mb-1.5 font-medium text-ink-800">这次修改会带来什么</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>已有 {impact?.works ?? (impactError ? '未知' : '…')} 篇作品保持原类型，检查、推送与打包行为完全不变。</li>
            <li>之后新建的作品将使用「{platformFormatLabel(account.platform, format)}」。</li>
            <li>
              {format === 'comic'
                ? '转为漫画后角色卡立刻可用。'
                : `转出漫画后角色卡会保留${impact?.cards ? `（${impact.cards} 张）` : ''}，只要账号里还有漫画作品就仍可管理。`}
            </li>
          </ul>
        </div>
      </div>
    </Dialog>
  )
}

function AccountDetail({ account, onStatusChange, canManage, desktop = false, connectionActionsTarget }: {
  account: Account
  onStatusChange: (kind: 'disabled' | 'enabled' | 'deleted') => void
  canManage: boolean
  desktop?: boolean
  connectionActionsTarget?: HTMLElement | null
}) {
  const inv = useInvalidate()
  const navigate = useNavigate()
  const { data: me } = useMe()
  const [name, setName] = useState(account.name)
  const [limit, setLimit] = useState(String(account.daily_push_limit))
  const [typeNote, setTypeNote] = useState(account.type_note ?? '')
  const [formError, setFormError] = useState('')
  const [typeOpen, setTypeOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirty = name !== account.name || typeNote !== (account.type_note ?? '') || (account.platform === 'wechat_mp' && limit !== String(account.daily_push_limit))
  const dirtyRef = useRef(false)
  const lastAccountId = useRef(account.id)
  dirtyRef.current = dirty
  useSettingsDraft(desktop && canManage && dirty, saving)
  useEffect(() => {
    const identityChanged = lastAccountId.current !== account.id
    lastAccountId.current = account.id
    if (dirtyRef.current && !identityChanged) return
    setName(account.name)
    setLimit(String(account.daily_push_limit))
    setTypeNote(account.type_note ?? '')
    setTypeOpen(false)
    setFormError('')
  }, [account.id, account.name, account.daily_push_limit, account.type_note])

  const save = async (body: Record<string, unknown>) => {
    setSaving(true)
    try {
      await patch(`/accounts/${account.id}`, body)
      await inv(['accounts'])
      toast.success('已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally { setSaving(false) }
  }

  const saveInformation = async () => {
    const cleanName = name.trim()
    const dailyLimit = Number(limit)
    if (!cleanName) { setFormError('账号名称不能为空。'); return }
    if (typeNote.length > 200) { setFormError('类型补充说明最多 200 字。'); return }
    if (account.platform === 'wechat_mp' && (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20)) {
      setFormError('每日写入草稿上限必须是 1–20 的整数。')
      return
    }
    setFormError('')
    setSaving(true)
    try {
      const body: Record<string, unknown> = { name: cleanName, type_note: typeNote }
      if (account.platform === 'wechat_mp') body.daily_push_limit = dailyLimit
      await patch(`/accounts/${account.id}`, body)
      setName(cleanName)
      await inv(['accounts'])
      toast.success('账号信息已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally { setSaving(false) }
  }

  const cancelInformation = () => {
    setName(account.name)
    setLimit(String(account.daily_push_limit))
    setTypeNote(account.type_note ?? '')
    setFormError('')
  }

  const toggle = async () => {
    const disabling = account.status === 'active'
    if (disabling) {
      if (!(await confirm({
      title: `停用「${platformLabel[account.platform]} · ${account.name}」？`,
        desc: '停用后不会出现在账号列表中，也不能写入草稿。作品、档案和素材会保留，可随时重新启用。若要永久清除请用「删除」。',
        confirmText: '停用',
        danger: true,
      }))) return
    }
    try {
      await post(`/accounts/${account.id}/${disabling ? 'disable' : 'enable'}`)
      inv(['accounts'])
      toast.success(disabling ? '已停用' : '已重新启用')
      onStatusChange(disabling ? 'disabled' : 'enabled')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async () => {
    if (!(await confirm({
      title: `删除「${platformLabel[account.platform]} · ${account.name}」？`,
      desc: '将永久删除该平台账号及其作品、选题、档案、凭证等，无法恢复。工作区共享素材会保留并解除与该账号的关联。',
      confirmText: '确认删除',
      danger: true,
    }))) return
    if (desktop && !(await requestDesktopLeaveGuard())) return
    try {
      await del(`/accounts/${account.id}?confirm=true`)
      inv(['accounts'])
      toast.success('账号已删除')
      onStatusChange('deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const platformConnectionCard = (['wechat_mp', 'xhs', 'toutiao'] as string[]).includes(account.platform)
    ? <PlatformConnectionCard key={account.id} accountId={account.id} platform={account.platform} canManage={canManage} role={me?.role ?? 'viewer'} adminOverride={me?.admin_override} accountStatus={account.status} actionsTarget={connectionActionsTarget} />
    : null

  const basicInformationCard = (
    <Card className={desktop ? 'desktop-basic-information @container' : undefined}>
      <CardHeader
        title="基本信息"
        desc={!canManage ? '编辑者可查看账号，修改由所有者操作。' : account.status === 'disabled' ? '该账号已停用，启用后可继续使用。' : undefined}
        className={desktop ? 'desktop-basic-information-header py-3.5' : undefined}
        action={canManage && !desktop ? (
          <div className="flex gap-2">
            {account.status === 'disabled' ? (
              <Button size="sm" variant="primary" icon={<Power className="size-3.5" />} onClick={toggle}>重新启用</Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<Power className="size-3.5" />} onClick={toggle}>停用</Button>
            )}
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove}>删除</Button>
          </div>
        ) : undefined}
      />
      <div className={cn('grid gap-4', desktop ? 'desktop-basic-information-grid gap-x-6 gap-y-4 p-5 @[640px]:grid-cols-2' : 'p-5 sm:grid-cols-2')}>
        <Field label="账号名称">
          <Input value={name} disabled={!canManage || saving} disabledHint={roleReadOnlyHint.owner} onChange={(e) => { setName(e.target.value); setFormError('') }} onBlur={() => !desktop && canManage && name.trim() && name !== account.name && save({ name: name.trim() })} />
        </Field>
        <Field label={account.platform === 'toutiao' ? '默认创作形态' : '账号类型'} hint={account.platform === 'toutiao' ? '每篇可选文章或微头条；修改默认值不影响已有内容' : '同平台内可以更换类型；跨平台请新建账号'} plain>
          {/* 窄列（如 1024 视口下详情卡只有约 370px、字段列 157px）时徽标＋按钮合计 162px 会撑破字段列，
              因此允许换行并用 min-h 兜住基准行高；宽屏下与原来的单行 h-9 完全一致。 */}
          <div className="flex min-h-9 flex-wrap items-center gap-2 text-[13.5px] text-mist-700">
            <Badge tone="ink">{platformFormatLabel(account.platform, account.content_format)}</Badge>
            {canManage && (
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => {
                if (desktop && dirty) { toast.info('请先保存或取消基本信息修改，再更改账号类型。'); return }
                setTypeOpen(true)
              }}>
                {account.platform === 'toutiao' ? '修改默认形态' : '修改类型'}
              </Button>
            )}
          </div>
        </Field>
        <Field className={desktop ? '@[640px]:col-span-2' : undefined} label="类型补充说明" hint="只帮助 AI 理解定位，不改变创作流程；最多 200 字">
          <Textarea rows={2} value={typeNote} maxLength={200} disabled={!canManage || account.status === 'disabled'} disabledHint={roleReadOnlyHint.owner}
            onChange={(e) => { setTypeNote(e.target.value); setFormError('') }}
            onBlur={() => !desktop && canManage && typeNote !== (account.type_note ?? '') && save({ type_note: typeNote })} />
        </Field>
        {account.platform === 'wechat_mp' && (
          <Field label="每日写入草稿上限" hint="1–20 次，不能关闭。超过后仍可写入，但每次都需要二次确认。">
            <Input
              type="number" min={1} max={20} value={limit}
              disabled={!canManage || account.status === 'disabled' || saving}
              disabledHint={roleReadOnlyHint.owner}
              onChange={(e) => { setLimit(e.target.value); setFormError('') }}
              onBlur={() => !desktop && canManage && Number(limit) !== account.daily_push_limit && save({ daily_push_limit: Number(limit) })}
            />
          </Field>
        )}
        {!desktop && <Field label="平台">
          <div className="flex h-9 items-center gap-2 text-[13.5px] text-mist-700">
            <PlatformMark platform={account.platform} size="sm" />
            {platformLabel[account.platform]}
          </div>
        </Field>}
        {!desktop && account.platform === 'wechat_mp' && account.metrics_wechat_auto && (
          <Field label="数据接口每日同步" hint={account.datacube_state === 'ok'
            ? '每天 10:00 后在后台只读同步一次最近 7 天群发的文章数据；连续 3 天失败或没有权限时会自动关闭并通知你。'
            : account.datacube_state === 'no_permission' ? '当前公众号没有数据统计接口权限（通常需要微信认证），不会同步。' : '凭证测试通过、确认有数据接口权限后才会同步。'}>
            <div className="flex min-h-9 flex-wrap items-center gap-3 text-[13px] text-mist-600">
              <Switch label="数据接口每日同步" checked={account.metrics_wechat_auto.enabled} disabled={!canManage || account.status === 'disabled'} disabledHint={roleReadOnlyHint.owner}
                onChange={(v) => save({ metrics_wechat_auto: v })} />
              <span>{account.metrics_wechat_auto.enabled ? '已开启' : '已关闭'}</span>
              {account.metrics_wechat_auto.last_at && <span className="text-mist-400">上次同步 {fmtTime(account.metrics_wechat_auto.last_at)}</span>}
            </div>
            {account.metrics_wechat_auto.note && <p className="mt-1 text-[12px] text-amber-700">{account.metrics_wechat_auto.note}</p>}
          </Field>
        )}
      </div>
      {desktop && canManage && <div className="desktop-basic-information-footer flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="min-w-0 flex-1 text-[12.5px] text-danger" role={formError ? 'alert' : undefined}>{formError}</p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" disabled={!dirty || saving} disabledHint="没有未保存的修改" onClick={cancelInformation}>取消修改</Button>
          <Button variant="primary" disabled={!dirty || saving} disabledHint={saving ? '正在保存…' : '没有未保存的修改'} onClick={() => void saveInformation()}>{saving ? '保存中…' : '保存信息'}</Button>
        </div>
      </div>}
    </Card>
  )

  return (
    <div className={desktop ? 'min-w-0 space-y-4' : 'space-y-5'}>
      {desktop ? <>{basicInformationCard}{platformConnectionCard}</> : <>{platformConnectionCard}{basicInformationCard}</>}
      <ChangeTypeDialog
        account={account}
        open={typeOpen}
        onClose={() => setTypeOpen(false)}
        onChanged={(_a, summary) => {
          inv(['accounts'])
          const kept = summary?.works_kept
          if (typeof kept === 'number' && kept > 0) {
            toast.success(`已有 ${kept} 篇作品保持原类型`)
          }
          const stale = summary?.stale_plan_slots
          if (typeof stale === 'number' && stale > 0) {
            toast.warning(`有 ${stale} 个未采用的计划槽位仍是旧类型，请到运营方案页启用新方案后重建`)
          }
        }}
      />
      {account.platform === 'wechat_mp' ? (
        canManage ? (
          <Card>
            <CardHeader title="公众号开发者凭证" desc="在公众号后台「设置与开发 → 基本配置」中获取 AppID 和 AppSecret。" className={desktop ? 'py-3.5' : undefined} />
            <div className={desktop ? 'p-4' : 'p-5'}><CredentialPanel key={account.id} account={account} desktop={desktop} onChanged={() => inv(['accounts'])} /></div>
          </Card>
        ) : (
          <Card className={desktop ? 'p-4 text-[13px] text-mist-600' : 'p-5 text-[13px] text-mist-600'}>公众号凭证仅所有者可查看与修改。</Card>
        )
      ) : (
        <Card className={desktop ? 'p-4 text-[13px] leading-relaxed text-mist-600' : 'p-5 text-[13px] leading-relaxed text-mist-600'}>
          {account.platform === 'xhs'
            ? '小红书作品通过「发布包」由你手动发布。'
            : '今日头条作品通过「发布包」由你手动发布；系统账号不代表已绑定或验证头条号身份。'}
        </Card>
      )}
      {desktop && <Card className="@container">
        <CardHeader title="数据回填" className="py-3.5" desc={account.platform === 'toutiao'
          ? '今日头条目前通过作品发布包手动发布；作品数据可在当前账号复盘页粘贴、导入或确认。'
          : '回填只作用于当前账号。自动读取状态与逐条观测见上方平台连接；人工回填在复盘页完成。'} />
        {account.platform === 'wechat_mp' && account.metrics_wechat_auto && <div className="grid gap-3 border-b border-line/60 p-4 @[640px]:grid-cols-2 @[640px]:p-5">
          <Field label="公众号数据接口每日同步" hint={account.datacube_state === 'ok'
            ? '每天 10:00 后只读同步最近 7 天群发文章数据。后台扫码会话不代替数据接口权限。'
            : account.datacube_state === 'no_permission' ? '当前公众号没有数据统计接口权限，不会同步；仍可使用人工回填。' : '凭证检测与统计权限确认后才会同步。'}>
            <div className="flex min-h-9 flex-wrap items-center gap-3 text-[13px] text-mist-600">
              <Switch label="公众号数据接口每日同步" checked={account.metrics_wechat_auto.enabled} disabled={!canManage || account.status === 'disabled' || saving} disabledHint={roleReadOnlyHint.owner}
                onChange={(v) => void save({ metrics_wechat_auto: v })} />
              <span>{account.metrics_wechat_auto.enabled ? '已开启' : '已关闭'}</span>
              {account.metrics_wechat_auto.last_at && <span className="text-mist-400">上次同步 {fmtTime(account.metrics_wechat_auto.last_at)}</span>}
            </div>
            {account.metrics_wechat_auto.note && <p className="mt-1 text-[12px] text-amber-700">{account.metrics_wechat_auto.note}</p>}
          </Field>
        </div>}
        <div className="flex flex-wrap gap-2 p-4 @[640px]:p-5">
          <Button variant="primary" onClick={() => navigate(`/a/${account.id}/review`)}>打开当前账号复盘与数据回填</Button>
          <Button variant="secondary" onClick={() => navigate(`/a/${account.id}/works`)}>打开当前账号作品</Button>
        </div>
      </Card>}
      {desktop && <Card className="desktop-account-actions @container">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-[14px] font-semibold text-mist-800">
            <span className="min-w-0">账号操作 <span className="ml-2 text-[12px] font-normal text-mist-500">停用、重新启用或永久删除当前账号</span></span>
            <ChevronDown className="size-4 shrink-0 text-mist-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 px-4 py-3.5 @[640px]:px-5 @[640px]:py-4">
            <p className="text-[12.5px] leading-relaxed text-mist-500">操作对象：{platformLabel[account.platform]} · {account.name}</p>
            {canManage && <div className="flex gap-2">
              <Button size="sm" variant={account.status === 'disabled' ? 'primary' : 'ghost'} icon={<Power className="size-3.5" />} onClick={() => void toggle()}>{account.status === 'disabled' ? '重新启用' : '停用当前账号'}</Button>
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()}>删除当前账号</Button>
            </div>}
          </div>
        </details>
      </Card>}
    </div>
  )
}

export default function SettingsAccounts() {
  const { data: me } = useMe()
  const desktop = isElectronDesktop(navigator.userAgent)
  const selection = useCurrentAccountSelection()
  const nav = useNavigate()
  const canManage = me?.role === 'owner'
  const { data, isLoading } = useAccounts()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const inv = useInvalidate()
  const [deletedCurrent, setDeletedCurrent] = useState<string | null>(null)
  const [connectionActionsTarget, setConnectionActionsTarget] = useState<HTMLDivElement | null>(null)
  const creating = params.get('new') === '1'
  const focusSearch = params.get('q') === '1'
  const createPlatform = (['wechat_mp', 'xhs', 'toutiao'] as Platform[]).find((p) => p === params.get('platform'))
  const list = data ?? []

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return list.filter((a) => {
      if (filter === 'active' && a.status !== 'active') return false
      if (filter === 'disabled' && a.status !== 'disabled') return false
      if (!needle) return true
      return a.name.toLowerCase().includes(needle) || platformLabel[a.platform].includes(needle)
    })
  }, [list, q, filter])

  useEffect(() => {
    const id = params.get('id')
    if (id && list.some((a) => a.id === id)) setSelected(id)
  }, [params, list])

  useEffect(() => {
    if (focusSearch) {
      const el = document.querySelector<HTMLInputElement>('[data-account-search]')
      el?.focus()
      el?.select()
    }
  }, [focusSearch])

  useEffect(() => {
    if (!selected && filtered.length) setSelected(filtered.find((account) => account.id === params.get('id'))?.id ?? filtered[0].id)
  }, [filtered, selected, params])

  useEffect(() => {
    if (selected && !filtered.some((a) => a.id === selected)) {
      setSelected(filtered[0]?.id ?? null)
    }
  }, [filtered, selected])

  if (isLoading) return <PageLoading />

  if (desktop) {
    if (selection.isLoading) return <PageLoading />
    if (selection.error) return <Card className="space-y-3 p-5" role="alert">
      <div className="font-semibold text-mist-900">当前账号信息暂时无法读取</div>
      <p className="text-[13px] text-mist-600">{errorMessage(selection.error)}</p>
      <Button variant="secondary" onClick={() => void inv(['me'], ['accounts'])}>重试</Button>
    </Card>

    const assertedId = params.get('id')
    if (assertedId && assertedId !== selection.selectedId) return <Card className="space-y-3 p-5">
      <div className="font-semibold text-mist-900">当前账号与此链接不一致</div>
      <p className="text-[13px] text-mist-600">请从头像菜单选择目标账号后再打开设置。此页面不会显示链接中其他账号的信息。</p>
      <Button variant="primary" onClick={requestDesktopAccountSwitcher}>返回并选择账号</Button>
    </Card>

    const current = selection.account
    if (!current || deletedCurrent === current.id) {
      const noAccounts = selection.accounts?.length === 0
      return <Card className="space-y-3 p-5">
        <div className="font-semibold text-mist-900">{noAccounts ? '当前工作区还没有平台账号' : '请先在头像菜单选择账号'}</div>
        <p className="text-[13px] text-mist-600">平台账号设置只显示已选择且已验证的当前账号。</p>
        <Button variant="primary" onClick={requestDesktopAccountSwitcher}>{noAccounts ? '打开账号入口' : '返回并选择账号'}</Button>
      </Card>
    }

    return <div className="desktop-current-account-settings min-w-0 max-w-[960px] space-y-4">
      <Card className="desktop-current-account-summary @container min-w-0 border-l-[3px] border-l-ink-400">
        <div className="grid gap-3 p-4 @[760px]:grid-cols-[minmax(0,1fr)_max-content] @[760px]:items-center @[760px]:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <PlatformMark platform={current.platform} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 truncate text-[16px] font-semibold text-mist-900" title={current.name}>{current.name}</div>
                <Badge className="shrink-0" tone={current.status === 'disabled' ? 'gamboge' : 'green'}>{current.status === 'disabled' ? '已停用' : '使用中'}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-mist-500">
                <span>{platformLabel[current.platform]}</span><span aria-hidden="true">·</span>
                <span>{platformFormatLabel(current.platform, current.content_format)}</span>
              </div>
            </div>
          </div>
          <div ref={setConnectionActionsTarget} className="w-fit max-w-full @[760px]:justify-self-end" />
        </div>
      </Card>
        <AccountDetail key={current.id} account={current} canManage={!!canManage} desktop connectionActionsTarget={connectionActionsTarget}
        onStatusChange={(kind) => {
          if (kind === 'deleted') {
            forgetAccount(current.id, selection.userId, selection.workspaceId)
            setDeletedCurrent(current.id)
            setParams({}, { replace: true })
          }
        }} />
    </div>
  }

  const current = list.find((a) => a.id === selected)

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: `全部 ${list.length}` },
    { id: 'active', label: `使用中 ${list.filter((a) => a.status === 'active').length}` },
    { id: 'disabled', label: `已停用 ${list.filter((a) => a.status === 'disabled').length}` },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="平台账号与凭证"
        desc="增删改查都在这里：添加、搜索筛选、编辑资料与凭证；暂不用可停用（可恢复），确定不要再点删除（不可恢复）。"
        action={canManage ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>添加账号</Button> : undefined}
      />

      {list.length === 0 ? (
        <Card className="overflow-hidden">
          <Empty
            icon={<Users className="size-5" />}
            title="还没有平台账号"
            desc={canManage ? '先添加平台账号。公众号凭证、定位档案、风格样本和模型可在添加后配置。' : '请联系工作区所有者添加平台账号。'}
            action={canManage ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>添加账号</Button> : undefined}
          />
          <ol className="space-y-2 border-t border-mist-100 bg-mist-50/60 px-6 py-4 text-[13px] text-mist-600">
            <li><span className="font-medium text-mist-800">1. 添加账号</span> — 本页</li>
            <li><span className="font-medium text-mist-800">2. 平台凭证</span> — 仅公众号需要；小红书和今日头条可手动发布</li>
            <li><span className="font-medium text-mist-800">3. 定位档案 / 风格样本</span> — 左侧「账号档案」</li>
            <li><span className="font-medium text-mist-800">4. 模型</span> — 头像菜单 → 模型配置</li>
          </ol>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <Card className="flex h-fit flex-col overflow-hidden">
            <div className="space-y-3 border-b border-mist-100 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mist-400" />
                <Input data-account-search className="h-9 pl-8" placeholder="搜索账号名称或平台" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-1">
                {filters.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      'cursor-pointer rounded-full px-2.5 py-1 text-[12px] transition',
                      filter === f.id ? 'bg-ink-600 text-white' : 'bg-mist-100 text-mist-600 hover:bg-mist-200',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[min(60vh,520px)] overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-3 py-8 text-center text-[13px] text-mist-400">没有符合条件的账号</p>
              ) : (
                filtered.map((a) => {
                  const t = credTone(a.credential)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelected(a.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                        selected === a.id ? 'bg-ink-50' : 'hover:bg-mist-50',
                        a.status === 'disabled' && 'opacity-60',
                      )}
                    >
                      <PlatformMark platform={a.platform} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-mist-900">{a.name}</span>
                          {selected === a.id && <Pencil className="size-3 shrink-0 text-ink-500" />}
                        </div>
                        <div className="text-[11.5px] text-mist-500">{platformLabel[a.platform]} · {platformFormatLabel(a.platform, a.content_format)}</div>
                      </div>
                      {a.status === 'disabled' ? <Badge>已停用</Badge> : a.platform === 'wechat_mp' && <Badge tone={t.tone}>{t.label}</Badge>}
                    </button>
                  )
                })
              )}
            </div>
            {canManage && (
              <div className="border-t border-mist-100 p-2">
                <Button className="w-full" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>
                  添加账号
                </Button>
              </div>
            )}
          </Card>
          {current ? (
            <AccountDetail
              account={current}
              canManage={!!canManage}
              onStatusChange={(kind) => {
                if (kind === 'deleted') {
                  setSelected(null)
                  setFilter('all')
                  return
                }
                if (kind === 'disabled') {
                  setFilter('disabled')
                  setSelected(current.id)
                }
              }}
            />
          ) : (
            <Card className="flex items-center justify-center p-10 text-[13px] text-mist-400">选择左侧账号进行编辑</Card>
          )}
        </div>
      )}

      <Dialog open={creating && !!canManage} onClose={() => setParams({})} title="添加平台账号" width="max-w-lg">
        {/* ST-01：注册/首次安装会直接落到这个弹窗，光填平台和名称看不出后面还有几步。 */}
        {list.length === 0 && <div className="mb-4" data-testid="account-create-path"><Notice tone="ink">
          <p className="font-medium">第一次使用，整体是这四步：</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12.5px]">
            <li>添加平台账号 —— 本弹窗</li>
            <li>填平台凭证 —— 仅公众号需要；小红书与今日头条可手动发布，可跳过</li>
            <li>写定位档案与风格样本 —— 账号「档案」页，可稍后补</li>
            <li>配置模型 —— 设置 → 模型配置，配好后 AI 按钮才可用</li>
          </ol>
        </Notice></div>}
        <AccountCreateForm
          key={createPlatform ?? 'any'}
          defaultPlatform={createPlatform}
          onCreated={(a) => {
            inv(['accounts'])
            setFilter('all')
            setSelected(a.id)
            setParams({})
            toast.success(a.platform === 'wechat_mp' ? '账号已添加，先建档；连接公众号可稍后回到这里完成' : '账号已添加，先来建档')
            nav(`/a/${a.id}/profile?wizard=1`)
          }}
        />
      </Dialog>
    </div>
  )
}
