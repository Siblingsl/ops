import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog } from '@/components/dialog'
import { Button, Empty, Input, PageLoading } from '@/components/ui'
import { errorMessage, get, post, put } from '@/lib/api'
import { relTime } from '@/lib/format'
import { contentStateLabel, fieldNameLabel, fieldStateLabel, platformErrorCopy } from '@/lib/platform-errors'
import { requestDesktopPlatformIntent } from '@/lib/desktop-platform-intent'
import { useMe } from '@/lib/session'
import type { Account, PlatformConnection, PlatformSyncOperation, PlatformWorkMirror, PlatformWorkMirrorListItem, PlatformWorkMirrorPage, Work, WorkListItem } from '@/lib/types'

const contentTypeName: Record<string, string> = {
  image_note: '图文笔记', video_note: '视频笔记', wechat_article: '公众号文章',
  toutiao_article: '头条文章', toutiao_micro_post: '微头条', unknown: '未知体裁',
}
const remoteStatusName: Record<string, string> = {
  published: '已发布', draft: '草稿', reviewing: '审核中', hidden: '已隐藏', deleted: '平台已删除', unknown: '状态未知',
}
const contentStateName: Record<string, string> = {
  complete: '正文完整', partial: '正文部分可用', unsupported: '平台暂不支持读取正文', denied: '平台拒绝读取正文',
  not_requested: '尚未请求正文', failed: '正文读取失败', unknown: '完整性未知',
}
const syncStatusName: Record<PlatformSyncOperation['status'], string> = {
  queued: '等待本机开始同步', running: '正在同步', paused: '同步已暂停', waiting_budget: '等待可用读取额度',
  waiting_device: '等待保存登录态的客户端', waiting_login: '等待重新核对平台登录', succeeded: '同步完成',
  partial: '同步部分完成', failed: '同步失败', canceled: '同步已取消',
}
const syncStageName: Record<string, string> = {
  profile: '账号资料', catalog: '作品目录', content: '作品内容', metrics: '作品统计', complete: '结果整理',
}
const activeSyncStatuses = new Set<PlatformSyncOperation['status']>([
  'queued', 'running', 'paused', 'waiting_budget', 'waiting_device', 'waiting_login',
])
const terminalSyncStatuses = new Set<PlatformSyncOperation['status']>(['succeeded', 'partial', 'failed', 'canceled'])

function dateText(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '平台未提供'
}

export function mirrorDraftBlockReason(mirror: PlatformWorkMirror, account: Account): string | null {
  if (mirror.is_bound || mirror.bindings.length > 0) return '该平台作品已关联本地作品，请从关联作品继续查看或编辑。'
  if (mirror.remote_status !== 'published') return '平台作品不是已发布状态，暂不能从中创建草稿。'
  if (mirror.content_state !== 'complete' || !mirror.body_text.trim()) return '正文尚未完整同步，完成同步后才能创建草稿。'
  if (mirror.cover_ref || mirror.media_refs.length > 0) return '作品含封面或媒体引用，当前无法无损复制到本地草稿。'
  if (mirror.body_structure.some((block) => block.type !== 'paragraph')) return '作品包含当前编辑器不支持的排版，无法无损转换。'
  if (mirror.platform === 'wechat_mp' && (mirror.remote_content_type !== 'wechat_article' || account.content_format !== 'long_article')) {
    return '当前公众号账号类型不支持该作品体裁。'
  }
  if (mirror.platform === 'xhs' && (mirror.remote_content_type !== 'image_note' || account.content_format !== 'image_note')) {
    return '当前小红书账号类型不支持该作品体裁。'
  }
  return null
}

// WL-04：被阻止的转换按原因给出修复出口，避免只显示灰色说明。
function mirrorDraftRepair(mirror: PlatformWorkMirror): { to?: string; href?: string; label: string } {
  const linked = mirror.bindings[0]
  if (mirror.is_bound || linked) return linked
    ? { to: `/works/${linked.work_id}`, label: '打开关联作品' }
    : { to: '/works', label: '查看关联作品' }
  if (mirror.remote_status !== 'published') return mirror.canonical_url
    ? { href: mirror.canonical_url, label: '在平台核对发布状态' }
    : { to: '/settings/accounts', label: '检查平台账号' }
  if (mirror.content_state !== 'complete' || !mirror.body_text.trim()) return { to: '/settings/accounts', label: '检查账号连接并重试同步' }
  return { to: '/works?create=1', label: '新建作品并手动整理正文' }
}

function PlatformMirrorLinkDialog({ account, mirror, onClose, onLinked }: {
  account: Account
  mirror: PlatformWorkMirror
  onClose: () => void
  onLinked: () => void
}) {
  const [search, setSearch] = useState('')
  const [selectedID, setSelectedID] = useState('')
  const [saving, setSaving] = useState(false)
  const client = useQueryClient()
  const works = useQuery({
    queryKey: ['platform-mirror-link-targets', account.id, search],
    queryFn: () => get<WorkListItem[]>(`/accounts/${account.id}/works?q=${encodeURIComponent(search.trim())}`),
  })
  const selected = useQuery({
    queryKey: ['platform-mirror-link-target', selectedID],
    queryFn: () => get<Work>(`/works/${selectedID}`),
    enabled: !!selectedID,
  })
  const bind = async () => {
    const work = selected.data
    if (!work || work.account_id !== account.id || work.platform !== account.platform || work.external_id) return
    setSaving(true)
    try {
      await put(`/works/${work.id}/platform-binding`, {
        external_id: mirror.external_id,
        metric_binding_revision: work.metric_binding_revision,
        publish_revision: work.publish_revision,
        binding_source: 'user_confirm',
      })
      await client.invalidateQueries({ queryKey: ['platform-work-mirrors', account.id] })
      toast.success('已将这一篇平台作品关联到本地作品')
      onLinked()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="关联现有作品" desc="系统只按平台作品编号建立关联，不按标题或封面相似度自动匹配。" width="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-lg bg-mist-50 p-3 text-[13px] text-mist-700">
          <div><strong>当前账号：</strong>{account.name}（{account.platform === 'xhs' ? '小红书' : '公众号'}）</div>
          <div className="mt-1 break-all"><strong>平台编号：</strong>{mirror.external_id}</div>
          <div className="mt-1"><strong>平台体裁 / 发布时间：</strong>{contentTypeName[mirror.remote_content_type] ?? mirror.remote_content_type} · {dateText(mirror.published_at)}</div>
        </div>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索本地作品标题" aria-label="搜索本地作品" />
        {works.isLoading ? <div className="py-6 text-center text-sm text-mist-400">正在读取本地作品…</div> : works.isError ? (
          <div className="text-sm text-danger">{errorMessage(works.error)} <button className="ml-1 underline" onClick={() => void works.refetch()}>重试</button></div>
        ) : (works.data ?? []).length === 0 ? <Empty title="没有找到本地作品" desc="先创建本地作品，或调整搜索词。" /> : (
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-mist-200 p-1">
            {(works.data ?? []).map((work) => (
              <button key={work.id} type="button" onClick={() => setSelectedID(work.id)}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13px] ${selectedID === work.id ? 'bg-ink-50 text-ink-800' : 'hover:bg-mist-50'}`}>
                <span className="min-w-0"><strong className="block truncate">{work.title || '未命名作品'}</strong><small className="text-mist-500">{work.content_format} · {work.status}</small></span>
                <span className="shrink-0 text-xs text-mist-500">{selectedID === work.id ? '已选择' : '选择'}</span>
              </button>
            ))}
          </div>
        )}
        {selectedID && (selected.isLoading ? <p className="text-sm text-mist-400">正在核对所选作品…</p> : selected.data && (
          <div className="rounded-lg border border-gamboge-200 bg-gamboge-50 p-3 text-[13px] text-gamboge-900">
            <strong>请确认关联对象</strong>
            <p className="mt-1">本地作品《{selected.data.title || '未命名作品'}》 · {selected.data.content_format} · {selected.data.status}</p>
            {selected.data.content_format !== (mirror.platform === 'wechat_mp' ? 'long_article' : 'image_note') &&
              <p className="mt-1">平台体裁与本地作品类型不同，请确认绑定的确是同一篇已发布作品。</p>}
            {selected.data.external_id && <p className="mt-1">该本地作品已有平台编号 {selected.data.external_id}，为避免覆盖，不能在此替换。</p>}
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
        <Button variant="primary" loading={saving} disabled={!selected.data || selected.data.account_id !== account.id || selected.data.platform !== account.platform || !!selected.data.external_id}
          onClick={() => void bind()}>确认关联这一篇</Button>
      </div>
    </Dialog>
  )
}

function MirrorDetail({ account, mirrorID, canWrite, onClose, onLink, onCreateDraft, metricRefreshReason, onRefreshMetrics }: {
  account: Account
  mirrorID: string
  canWrite: boolean
  onClose: () => void
  onLink: (mirror: PlatformWorkMirror) => void
  onCreateDraft: (mirror: PlatformWorkMirror) => void
  metricRefreshReason: string | null
  onRefreshMetrics: (mirrorID: string) => Promise<string>
}) {
  const [metricOperationID, setMetricOperationID] = useState('')
  const query = useQuery({
    queryKey: ['platform-work-mirror', account.id, mirrorID],
    queryFn: async () => (await get<{ work: PlatformWorkMirror }>(`/accounts/${account.id}/platform-works/${mirrorID}`)).work,
  })
  const metricOperation = useQuery({
    queryKey: ['platform-sync-operation', account.id, metricOperationID],
    queryFn: () => get<{ operation: PlatformSyncOperation }>(`/accounts/${account.id}/platform-sync-operations/${metricOperationID}`),
    enabled: !!metricOperationID,
    refetchInterval: (state) => {
      const status = state.state.data?.operation.status
      return status && ['succeeded', 'partial', 'failed', 'canceled'].includes(status)
        ? false : document.visibilityState === 'visible' ? 5_000 : 30_000
    },
  })
  useEffect(() => {
    const status = metricOperation.data?.operation.status
    if (status && ['succeeded', 'partial', 'failed', 'canceled'].includes(status)) {
      void query.refetch()
      setMetricOperationID('')
    }
  }, [metricOperation.data?.operation.status])
  const mirror = query.data
  const draftBlockReason = mirror ? mirrorDraftBlockReason(mirror, account) : null
  const draftRepair = mirror && draftBlockReason ? mirrorDraftRepair(mirror) : null
  const latestMetric = mirror?.metric_observations[0]
  return (
    <Dialog open onClose={onClose} title={mirror?.title || '平台作品详情'} desc="此处展示同步到当前工作区的镜像；正文与统计不会自动进入本地发布状态。" width="max-w-4xl">
      {query.isLoading ? <PageLoading /> : query.isError ? (
        <div className="py-8 text-center text-sm text-danger">{errorMessage(query.error)} <button className="ml-1 underline" onClick={() => void query.refetch()}>重试</button></div>
      ) : mirror ? <div className="space-y-5 text-[13px] text-mist-700">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-ink-50 px-2.5 py-1 text-ink-700">{contentTypeName[mirror.remote_content_type] ?? mirror.remote_content_type}</span>
          <span className="rounded-full bg-mist-100 px-2.5 py-1">{remoteStatusName[mirror.remote_status] ?? mirror.remote_status}</span>
          <span className="rounded-full bg-mist-100 px-2.5 py-1">{contentStateName[mirror.content_state] ?? mirror.content_state}</span>
          <span className="rounded-full bg-mist-100 px-2.5 py-1">{mirror.is_bound || mirror.bindings.length ? '已关联本地作品' : '尚未关联'}</span>
        </div>
        <dl className="grid gap-3 rounded-lg bg-mist-50 p-4 sm:grid-cols-2">
          <div><dt className="text-mist-500">平台作品编号</dt><dd className="mt-1 break-all font-mono text-xs">{mirror.external_id}</dd></div>
          <div><dt className="text-mist-500">发布时间</dt><dd className="mt-1">{dateText(mirror.published_at)}</dd></div>
          <div><dt className="text-mist-500">最近内容同步</dt><dd className="mt-1">{dateText(mirror.content_observed_at)}</dd></div>
          <div><dt className="text-mist-500">最近目录发现</dt><dd className="mt-1">{dateText(mirror.last_seen_at)}</dd></div>
          <div><dt className="text-mist-500">统计截止时间</dt><dd className="mt-1">{dateText(latestMetric?.as_of_at)}</dd></div>
          <div><dt className="text-mist-500">统计读取时间</dt><dd className="mt-1">{dateText(latestMetric?.observed_at)}</dd></div>
        </dl>
        {/* PB-13：字段状态与错误码走中文映射，让用户能判断是平台不给、解析失败还是权限问题。 */}
        {mirror.content_error_code && <p className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-orange-800" data-testid="mirror-content-error">
          正文同步原因：{platformErrorCopy(mirror.content_error_code)?.title ?? '同步遇到未预期的问题'}
          {platformErrorCopy(mirror.content_error_code)?.hint ? ` — ${platformErrorCopy(mirror.content_error_code)!.hint}` : ''}
        </p>}
        <section>
          <h3 className="mb-2 font-semibold text-mist-900">字段完整性</h3>
          <div className="flex flex-wrap gap-2" data-testid="mirror-field-coverage">{Object.entries(mirror.field_coverage).map(([field, state]) =>
            <span key={field} className="rounded border border-mist-200 px-2 py-1 text-xs" title={`${field}：${state}`}>
              {fieldNameLabel(field)}：{fieldStateLabel(state)}
            </span>)}</div>
        </section>
        <section>
          <h3 className="mb-2 font-semibold text-mist-900">正文</h3>
          {mirror.body_text ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-mist-200 bg-white p-4 font-sans leading-7">{mirror.body_text}</pre>
            : <div className="rounded-lg bg-mist-50 p-4 text-mist-500">
              <p>{contentStateLabel(mirror.content_state)}；摘要不会替代正文。</p>
              {/* PB-13：平台不给正文时给出补录入口，而不是只留一句「没有正文」。 */}
              {mirror.content_state !== 'complete' && <p className="mt-1">可以在平台上复制正文后，回到本地作品里手动粘贴补录。</p>}
            </div>}
        </section>
        {(mirror.topics.length > 0 || mirror.tags.length > 0) && <section>
          <h3 className="mb-2 font-semibold text-mist-900">话题与标签</h3>
          <p>{[...mirror.topics, ...mirror.tags].join(' · ')}</p>
        </section>}
        {mirror.media_refs.length > 0 && <section>
          <h3 className="mb-2 font-semibold text-mist-900">媒体引用</h3>
          <ul className="space-y-1">{mirror.media_refs.map((media) => <li key={`${media.position}-${media.url}`} className="flex flex-wrap items-center gap-2">
            <span>{media.kind} · 第 {media.position + 1} 项</span>
            {media.width && media.height && <span className="text-mist-500">{media.width} × {media.height}</span>}
            <a href={media.url} target="_blank" rel="noopener noreferrer" className="text-ink-700 underline">按需打开媒体地址</a>
          </li>)}</ul>
        </section>}
        {mirror.metric_observations.length > 0 && <section>
          <h3 className="mb-2 font-semibold text-mist-900">最近统计</h3>
          <div className="space-y-2">{mirror.metric_observations.slice(0, 5).map((observation) => <div key={observation.id} className="rounded-lg border border-mist-200 p-3">
            <div className="mb-2 text-xs text-mist-500">读取于 {dateText(observation.observed_at)} · 截止 {dateText(observation.as_of_at)} · {observation.quality_state}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(observation.values).map(([field, value]) =>
              <span key={field}>{field}: {value.value.toLocaleString('zh-CN')} {value.unit}</span>)}</div>
          </div>)}</div>
        </section>}
        {mirror.bindings.length > 0 && <section>
          <h3 className="mb-2 font-semibold text-mist-900">关联的本地作品</h3>
          <ul className="space-y-1">{mirror.bindings.map((binding) => <li key={binding.work_id}>
            <Link to={`/works/${binding.work_id}`} onClick={onClose} className="text-ink-700 underline">{binding.title || '未命名作品'}</Link>
            <span className="ml-2 text-mist-500">{binding.status} · {dateText(binding.published_at)}</span>
          </li>)}</ul>
        </section>}
        {mirror.canonical_url && <a href={mirror.canonical_url} target="_blank" rel="noopener noreferrer" className="inline-block text-ink-700 underline">在平台打开原作品</a>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-mist-100 pt-4">
          {metricOperationID && <span className="mr-auto text-xs text-mist-500">
            {metricOperation.data?.operation.status === 'running' ? '正在刷新这篇作品的指标…' : '已排入这篇作品的指标刷新；进度可在账号设置查看。'}
          </span>}
          <div className="text-right">
            <Button variant="ghost" disabled={!!metricRefreshReason || !!metricOperationID || !mirror} onClick={() => {
              if (!mirror) return
              void onRefreshMetrics(mirror.id).then(setMetricOperationID).catch((error) => toast.error(errorMessage(error)))
            }}>刷新此篇指标</Button>
            {metricRefreshReason && <p className="mt-1 max-w-xs text-xs text-mist-500">{metricRefreshReason}</p>}
          </div>
          {canWrite && !mirror.bindings.length && !mirror.is_bound && <Button variant="secondary" onClick={() => onLink(mirror)}>关联现有作品</Button>}
          {canWrite && !mirror.is_bound && !mirror.bindings.length && <div className="text-right">
            <Button variant="primary" disabled={!!draftBlockReason} onClick={() => onCreateDraft(mirror)}>基于此作品创建草稿</Button>
            {draftBlockReason && <p className="mt-1 max-w-sm text-xs text-mist-500">{draftBlockReason}{draftRepair && <>
              {' '}{draftRepair.to ? <Link to={draftRepair.to} onClick={onClose} className="font-medium text-ink-700 underline">{draftRepair.label}</Link>
                : <a href={draftRepair.href} target="_blank" rel="noopener noreferrer" className="font-medium text-ink-700 underline">{draftRepair.label}</a>}
            </>}</p>}
          </div>}
        </div>
      </div> : null}
    </Dialog>
  )
}

export function PlatformWorksView({ account, canWrite }: { account: Account; canWrite: boolean }) {
  const [search, setSearch] = useState('')
  const [selectedID, setSelectedID] = useState('')
  const [linkingMirror, setLinkingMirror] = useState<PlatformWorkMirror | null>(null)
  const client = useQueryClient()
  const completedSyncRefresh = useRef(new Set<string>())
  const navigate = useNavigate()
  const { data: me } = useMe()
  const desktopPresentation = document.documentElement.dataset.presentation === 'ops-creative-desktop'
  const connectionQuery = useQuery({
    queryKey: ['platform-connection', account.id],
    queryFn: () => get<{ connection: PlatformConnection | null }>(`/accounts/${account.id}/platform-connection`),
    enabled: desktopPresentation && account.platform !== 'toutiao',
    staleTime: 15_000,
  })
  const policyQuery = useQuery({
    queryKey: ['platform-collection-policy', me?.workspace.id ?? ''],
    queryFn: () => get<{ global_enabled: boolean; metrics_refresh_platforms?: string[]; policy: { enabled: boolean } }>('/platform-collection/policy'),
    enabled: desktopPresentation && account.platform !== 'toutiao' && !!me?.workspace.id,
    staleTime: 60_000,
    retry: false,
  })
  const connection = connectionQuery.data?.connection ?? null
  const syncOperations = useQuery({
    queryKey: ['platform-sync-operations', account.id],
    queryFn: () => get<{ items: PlatformSyncOperation[] }>(`/accounts/${account.id}/platform-sync-operations?limit=20`),
    enabled: desktopPresentation && account.platform !== 'toutiao',
    staleTime: 5_000,
    refetchInterval: (query) => {
      const hasActiveSync = (query.state.data?.items ?? []).some((operation) =>
        operation.kind === 'account_sync' && activeSyncStatuses.has(operation.status))
      if (!hasActiveSync) return false
      return document.visibilityState === 'visible' ? 5_000 : 30_000
    },
  })
  const accountSync = syncOperations.data?.items.find((operation) => operation.kind === 'account_sync')
  const activeAccountSync = syncOperations.data?.items.find((operation) =>
    operation.kind === 'account_sync' && activeSyncStatuses.has(operation.status))
  const accountSyncText = accountSync && [
    syncStatusName[accountSync.status],
    syncStageName[accountSync.stage] ?? accountSync.stage,
    Number.isFinite(accountSync.counters.discovered) ? `发现 ${accountSync.counters.discovered} 篇` : '',
    Number.isFinite(accountSync.counters.content_received) ? `详情完成 ${accountSync.counters.content_received} 篇` : '',
    Number.isFinite(accountSync.counters.metrics_observed) ? `统计读取 ${accountSync.counters.metrics_observed} 篇` : '',
    Number.isFinite(accountSync.counters.failed) && accountSync.counters.failed > 0 ? `未完成 ${accountSync.counters.failed} 项` : '',
  ].filter(Boolean).join(' · ')
  const metricRefreshReason = !desktopPresentation ? '请在 OPS 桌面客户端刷新平台指标。'
    : !window.opsDesktopUI?.onPlatformIntentResult ? '当前 OPS 桌面客户端不支持指标刷新，请重启客户端后重试。'
    : me?.admin_override ? '系统管理员代入工作区时只能查看，不能读取平台数据。'
      : !canWrite ? '当前角色为只读，不能发起平台指标刷新。'
        : account.status !== 'active' ? '此账号已停用，不能刷新平台指标。'
          : connectionQuery.isLoading ? '正在核实本机平台连接…'
            : connectionQuery.isError ? '无法核实本机平台连接，请重试账号状态。'
              : !connection ? '请先在账号设置中登录并核对平台身份。'
                : !connection.is_holder ? '请由连接保管人在保存登录态的主设备上刷新。'
                  : connection.state !== 'active' || connection.availability !== 'ready' ? '平台连接当前不可读取，请先重新核对登录。'
                    : !policyQuery.data || policyQuery.isError ? '无法核实服务端能力与工作区策略。'
                      : !policyQuery.data.global_enabled || !policyQuery.data.policy.enabled ? '服务端或工作区尚未启用平台数据读取。'
                        : !policyQuery.data.metrics_refresh_platforms?.includes(account.platform) ? '该平台的指标刷新能力尚未通过验收并启用。'
                          : connection.sync_capabilities?.metrics !== 'supported' ? '平台作品指标读取能力尚未核验。'
                            : null

  const refreshSingleWorkMetrics = async (mirrorID: string): Promise<string> => {
    if (metricRefreshReason || !connection) throw new Error(metricRefreshReason || '平台连接不可用。')
    const result = await requestDesktopPlatformIntent({
      type: 'platform-metrics-refresh',
      accountId: account.id,
      connectionRevision: connection.authorization_revision,
      platformWorkId: mirrorID,
    })
    if (result.status === 'no_targets') throw new Error('当前没有可刷新指标的作品。')
    if (!result.operationId) throw new Error('服务端没有返回指标刷新操作编号。')
    if (result.status === 'existing') toast.info('已有同目标的指标刷新操作，正在刷新进度。')
    else toast.success('已建立这篇作品的指标刷新操作')
    return result.operationId
  }
  const works = useInfiniteQuery({
    queryKey: ['platform-work-mirrors', account.id, search],
    queryFn: ({ pageParam }) => get<PlatformWorkMirrorPage>(`/accounts/${account.id}/platform-works?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: activeAccountSync && ['queued', 'running'].includes(activeAccountSync.status)
      ? (document.visibilityState === 'visible' ? 15_000 : 30_000)
      : false,
  })
  useEffect(() => {
    if (!accountSync || !terminalSyncStatuses.has(accountSync.status) || completedSyncRefresh.current.has(accountSync.id)) return
    completedSyncRefresh.current.add(accountSync.id)
    void works.refetch()
  }, [accountSync?.id, accountSync?.status, works.refetch])
  const items = works.data?.pages.flatMap((page) => page.items) ?? []
  const createDraft = async (mirror: PlatformWorkMirror) => {
    try {
      const work = await post<Work>(`/accounts/${account.id}/platform-works/${mirror.id}/draft`, {
        expected_mirror_revision: mirror.revision,
        expected_content_revision: mirror.content_revision,
      })
      await client.invalidateQueries({ queryKey: ['works', account.id] })
      toast.success('已创建本地草稿；平台作品仍保持原状态')
      navigate(`/works/${work.id}`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <Input className="max-w-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索平台作品标题" aria-label="搜索平台作品" />
      <p className="text-xs text-mist-500">镜像只读展示，不计入本地创作和发布数量。</p>
    </div>
    {accountSyncText && <p className="rounded-lg border border-ink-100 bg-white px-3 py-2 text-xs text-mist-600" role="status" aria-live="polite">
      {accountSyncText}{activeAccountSync && <span className="ml-2 text-mist-500">新发现的作品会自动显示。</span>}
    </p>}
    {works.isLoading ? <PageLoading /> : works.isError ? <div className="rounded-xl border border-danger/20 bg-danger/5 p-5 text-sm text-danger">{errorMessage(works.error)} <button className="ml-1 underline" onClick={() => void works.refetch()}>重试</button></div>
      : items.length === 0 ? <div className="rounded-xl border border-mist-200 bg-white p-5"><Empty
        title={activeAccountSync ? '正在同步平台作品' : accountSync?.status === 'failed' ? '上次同步失败' : accountSync?.status === 'partial' ? '上次同步部分完成' : accountSync?.status === 'succeeded' ? '同步完成，暂无可显示作品' : '还没有同步的平台作品'}
        desc={activeAccountSync ? '已保存到项目的作品会自动显示在这里；目录同步期间列表会定时刷新。'
          : accountSync?.status === 'failed' ? '请到账号设置查看同步失败原因后重试。'
            : accountSync?.status === 'partial' ? '请到账号设置查看未完成范围；已保存的作品会显示在这里。'
              : accountSync?.status === 'succeeded' ? '本次同步没有返回可显示的已发布作品，请到账号设置查看目录覆盖情况。'
                : '请先在账号设置中发起平台账号同步。平台能力尚未核验时，同步入口会显示具体限制。'} /></div>
        : <div className="space-y-2">{items.map((item: PlatformWorkMirrorListItem) => <button key={item.id} type="button" onClick={() => setSelectedID(item.id)}
          className="grid w-full cursor-pointer gap-3 rounded-xl border border-mist-200 bg-white p-4 text-left transition hover:border-ink-300 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><strong className="truncate font-display text-[15px] text-mist-900">{item.title || '未命名作品'}</strong>
              <span className="rounded-full bg-ink-50 px-2 py-0.5 text-xs text-ink-700">{contentTypeName[item.remote_content_type] ?? item.remote_content_type}</span>
              <span className="rounded-full bg-mist-100 px-2 py-0.5 text-xs text-mist-600">{remoteStatusName[item.remote_status] ?? item.remote_status}</span>
              <span className="rounded-full bg-mist-100 px-2 py-0.5 text-xs text-mist-600">{contentStateName[item.content_state] ?? contentStateLabel(item.content_state)}</span>
              {item.is_bound && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">已关联</span>}
            </div>
            {item.summary && <p className="mt-1 line-clamp-2 text-[13px] text-mist-600">{item.summary}</p>}
            {/* PB-13：列表里也不显示裸错误码。 */}
            {item.content_error_code && <p className="mt-1 text-xs text-orange-700">同步原因：{platformErrorCopy(item.content_error_code)?.title ?? '同步遇到未预期的问题'}</p>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mist-500 sm:justify-end">
            <span>发布：{dateText(item.published_at)}</span>
            <span>内容同步：{dateText(item.content_observed_at)}</span>
            <span>统计截止：{dateText(item.latest_metric_as_of_at)}</span>
            <span>目录发现：{relTime(item.last_seen_at)}</span>
          </div>
        </button>)}</div>}
    {works.hasNextPage && <div className="flex justify-center"><Button variant="secondary" loading={works.isFetchingNextPage} onClick={() => void works.fetchNextPage()}>加载更多平台作品</Button></div>}
    {selectedID && <MirrorDetail key={selectedID} account={account} mirrorID={selectedID} canWrite={canWrite} onClose={() => setSelectedID('')}
      metricRefreshReason={metricRefreshReason} onRefreshMetrics={refreshSingleWorkMetrics}
      onLink={(mirror) => setLinkingMirror(mirror)} onCreateDraft={(mirror) => void createDraft(mirror)} />}
    {linkingMirror && <PlatformMirrorLinkDialog account={account} mirror={linkingMirror} onClose={() => setLinkingMirror(null)}
      onLinked={() => { setLinkingMirror(null); setSelectedID('') }} />}
  </div>
}
