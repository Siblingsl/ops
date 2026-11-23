import { useEffect, useState } from 'react'
import { ChevronDown, CircleAlert, CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import type { Work } from '@/lib/types'
import { Button } from './ui'

interface ManifestCheck {
  code: string
  ok: boolean
  severity: 'block' | 'warn'
  field: string
  message: string
}

interface Manifest {
  platform: string
  revision: number
  content_hash: string
  validation_state: 'pending' | 'valid' | 'invalid' | 'stale'
  validation: { checks: ManifestCheck[] }
  payload: { fields: { title: string; body_text: string; tags: string[]; cover_asset_id: string | null } }
  updated_at: string
}

interface ReadbackField {
  ok?: boolean
  expected_hash?: string
  actual_hash?: string
  expected_len?: number
  actual_len?: number
  expected_count?: number
  actual_count?: number
  first?: string
  expected_present?: boolean
  present?: boolean
  expected_ratio?: number | string
  actual_ratio?: number | string
  expected?: string | null
  actual?: string | null
}

interface Readback {
  checked_at?: string
  adapter_version?: string
  ok?: boolean
  fields?: Record<string, ReadbackField>
  screenshot_asset_id?: string
  tab_ref?: string
}

interface TaskProjection {
  id: string
  platform: string
  mode?: string
  state: string
  state_version: number
  attempt: number
  max_attempts: number
  last_error_code?: string
  last_event_kind?: string
  last_event_at?: string
  evidence?: { readback?: Readback }
}

interface CapabilityChannel {
  platform: string
  channel: string
  requires: string[]
  why: string
  default_on: boolean
  calibrated: boolean
  available: boolean
  disabled_reason?: string
  missing?: string[]
  adapter_version?: string
  current_adapter_version?: string
}

interface CapabilityPlatform {
  platform: string
  channels: CapabilityChannel[]
}

// REF41 P5：发布通道体检投影（与服务端 PublishHealthCheck JSON 对应）。
interface PublishHealthCheck {
  id: string
  platform: string
  purpose: string
  state: string
  attempt: number
  requested_at: string
  finished_at?: string
  result: { logged_in?: boolean; online?: boolean; adapter_version?: string }
  error_code: string
  error_message: string
}

const platforms = [
  { id: 'wechat_mp', name: '公众号', code: 'MP' },
  { id: 'xhs', name: '小红书', code: 'XHS' },
  { id: 'toutiao', name: '今日头条', code: 'TT' },
]

function manifestBadge(platform: string, manifest: Manifest | undefined, task: TaskProjection | undefined, work: Work, labels: Record<string, string>) {
  if (!labels.packed) return { text: '读取中…', className: 'bg-mist-100 text-mist-600' }
  // 四态文案只取服务端 labels；只有作品所属平台且 work.status=published 才能显示“已发布”。
  if (work.status === 'published' && platform === work.platform) return { text: labels.published, className: 'bg-ink-100 text-ink-700' }
  if (task && ['submitted', 'scheduled', 'published'].includes(task.state)) {
    return { text: work.platform === 'wechat_mp' ? labels.submitted_wechat_mp : labels.submitted, className: 'bg-ink-100 text-ink-700' }
  }
  if (task?.state === 'awaiting_user') return { text: labels.awaiting_user, className: 'bg-sky-50 text-sky-700' }
  if (task?.state === 'filled') return { text: labels.filled, className: 'bg-sky-50 text-sky-700' }
  if (!manifest) return { text: labels.packed, className: 'bg-mist-100 text-mist-600' }
  if (manifest.validation_state === 'stale') return { text: '已过期', className: 'bg-gamboge-50 text-gamboge-700' }
  if (manifest.validation_state === 'invalid') return { text: '校验未通过', className: 'bg-rose-50 text-rose-700' }
  return { text: labels.packed, className: 'bg-emerald-50 text-emerald-700' }
}

const taskStateCopy: Record<string, string> = {
  ready: '待排队', queued: '待排队', filling: '填写中', filled: '已填入待你点', awaiting_user: '待你点发布',
  submitted: '已提交', scheduled: '已预约', published: '已发布', failed: '失败', not_logged_in: '掉线',
  skipped: '已跳过', stopped: '已停止',
}
// meta 行与 badge 共用同一平台守卫：非作品平台的任务不得出现“已发布”。
function taskMetaCopy(platform: string, work: Work, task: TaskProjection, labels: Record<string, string>): string {
  if (task.state === 'published') {
    return platform === work.platform ? taskStateCopy.published : (labels.submitted || '已交接')
  }
  return taskStateCopy[task.state] || task.state
}
const eventCopy: Record<string, string> = {
  transition: '状态变更', fill: '填写', readback: '回读', drift: '漂移', correction: '修正',
  adopt: '采用', import: '导入', invalidation: '失效', retry: '重试',
}
const eventTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

const readbackLabels: Record<string, string> = { title: '标题', body: '正文', tags: '标签', cover: '封面', schedule: '定时' }

function shortHash(value?: string) {
  if (!value) return '缺失'
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

function readbackLine(name: string, field?: ReadbackField) {
  if (!field) return '缺失'
  switch (name) {
    case 'title':
      return `期望 ${shortHash(field.expected_hash)} / 实际 ${shortHash(field.actual_hash)}`
    case 'body':
      return `期望 ${field.expected_len ?? 0} 字 / 实际 ${field.actual_len ?? 0} 字`
    case 'tags':
      return `期望 ${field.expected_count ?? 0} 个 / 实际 ${field.actual_count ?? 0} 个 · 首项 ${field.first || '无'}`
    case 'cover':
      return `期望 ${field.expected_present ? '有' : '无'} / 实际 ${field.present ? '有' : '无'}${field.actual_ratio ? ` · ${field.actual_ratio}` : ''}`
    case 'schedule':
      return `期望 ${field.expected || '立即'} / 实际 ${field.actual || '立即'}`
    default:
      return '缺失'
  }
}

const channelLabels: Record<string, string> = { api: 'API', desktop: '桌面自动填写', manual: '手动' }

// REF41 P5：体检状态。只读展示在线/未登录/未体检与最近体检时间，可手动重新体检。
function HealthBlock({ accountID, platform, label }: { accountID: string; platform: string; label: string }) {
  const [check, setCheck] = useState<PublishHealthCheck | undefined>()
  const [busy, setBusy] = useState(false)
  const load = () => {
    get<{ checks: PublishHealthCheck[] }>(`/accounts/${accountID}/publish-health`)
      .then((list) => setCheck(list.checks?.find((item) => item.platform === platform)))
      .catch(() => undefined)
  }
  useEffect(load, [accountID, platform])
  const recheck = async () => {
    setBusy(true)
    try {
      await post(`/accounts/${accountID}/publish-health/check`, { platforms: [platform] })
      load()
      toast.success(`${label} 体检已排队`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const state = check ? (check.state === 'succeeded' ? (check.result?.logged_in ? '在线' : '未登录') : check.state === 'failed' || check.state === 'expired' ? '体检失败' : '体检中') : '未体检'
  const tone = state === '在线' ? 'bg-emerald-50 text-emerald-700' : state === '未登录' ? 'bg-gamboge-50 text-gamboge-700' : 'bg-mist-100 text-mist-500'
  return (
    <div data-testid={`publish-health-${platform}`} className="mt-1.5 ml-11 flex items-center gap-2 rounded-lg border border-mist-200 bg-white px-2 py-1.5 text-[10.5px]">
      <span className="font-medium text-mist-700">体检</span>
      <span data-testid={`publish-health-state-${platform}`} className={`rounded px-1.5 py-0.5 ${tone}`}>{state}</span>
      {check?.finished_at && <span className="text-mist-400">{eventTime(check.finished_at)}</span>}
      <button type="button" data-testid={`publish-health-recheck-${platform}`} disabled={busy}
        className="ml-auto rounded border border-mist-200 px-1.5 py-0.5 text-mist-600 hover:bg-mist-50 disabled:opacity-50"
        onClick={() => void recheck()}>
        {busy ? '排队中…' : '重新体检'}
      </button>
    </div>
  )
}

function CapabilityBlock({ platform, capabilities }: { platform: string; capabilities: CapabilityPlatform[] }) {
  const current = capabilities.find((item) => item.platform === platform)
  if (!current) return null
  return (
    <div data-testid={`publish-capability-panel-${platform}`} className="mt-1.5 ml-11 rounded-lg border border-mist-200 bg-white p-2">
      <div className="mb-1 text-[11.5px] font-semibold text-mist-800">平台能力</div>
      <div className="space-y-1">
        {current.channels.map((item) => (
          <div key={item.channel} data-testid={`publish-capability-${platform}-${item.channel}`} className="rounded border border-mist-100 px-1.5 py-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-[10.5px] font-medium text-mist-700">{channelLabels[item.channel] || item.channel}</span>
              <span className="text-[10.5px] text-mist-400">{item.why}</span>
              {item.available ? (
                <span data-testid={`publish-capability-available-${platform}-${item.channel}`} className="ml-auto rounded bg-emerald-50 px-1.5 py-0.5 text-[10.5px] text-emerald-700">
                  可用{item.calibrated ? ' · 已校准' : ''}
                </span>
              ) : (
                <button type="button" disabled data-testid={`publish-capability-disabled-${platform}-${item.channel}`}
                  className="ml-auto rounded bg-mist-100 px-1.5 py-0.5 text-[10.5px] text-mist-500">
                  不可用
                </button>
              )}
            </div>
            {!item.available && (
              <div data-testid={`publish-capability-reason-${platform}-${item.channel}`} className="mt-0.5 text-[10.5px] text-rose-700">
                {item.disabled_reason || '暂不可用'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 桌面形态发布分区：与 Web 独立实现，按桌面窄栏排版；只准备字段，不触发发布。 */
export function PublishManifestPanel({ work }: { work: Work }) {
  const [items, setItems] = useState<Manifest[]>([])
  const [tasks, setTasks] = useState<TaskProjection[]>([])
  const [capabilities, setCapabilities] = useState<CapabilityPlatform[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState('')
  const [pending, setPending] = useState('')
  const [readError, setReadError] = useState('')

  const refresh = async () => {
    const [list, projections, capabilityList, labelResponse] = await Promise.all([
      get<Manifest[]>(`/works/${work.id}/publish-manifests`),
      get<TaskProjection[]>(`/works/${work.id}/publish-tasks`),
      get<CapabilityPlatform[]>(`/publish/capabilities?account_id=${work.account_id}`),
      get<{ labels: Record<string, string> }>('/publish/labels'),
    ])
    setItems(list)
    setTasks(projections)
    setCapabilities(capabilityList)
    setLabels(labelResponse.labels || {})
    setReadError('')
  }

  useEffect(() => {
    let alive = true
    refresh().catch((e: unknown) => { if (alive) setReadError(errorMessage(e)) })
    return () => { alive = false }
  }, [work.id, work.revision])

  const generate = async (platform: string, validateOnly = false) => {
    setPending(`${platform}:${validateOnly ? 'validate' : 'build'}`)
    try {
      await post(`/works/${work.id}/publish-manifests/${platform}${validateOnly ? '/validate' : ''}`)
      await refresh()
      toast.success(validateOnly ? '发布字段已重新校验' : '发布字段已生成')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setPending('')
    }
  }

  const actTask = async (task: TaskProjection, action: 'retry' | 'manual') => {
    setPending(`${task.id}:${action}`)
    try {
      await post(`/publish-tasks/${task.id}/${action}`, {
        expected_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      })
      await refresh()
      toast.success(action === 'retry' ? '已重新排队' : '已改为手动通道')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setPending('')
    }
  }

  return (
    <section data-testid="publish-manifest-panel" className="border-t border-mist-100 bg-white px-5 py-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold text-mist-800">发布</div>
        <div className="text-[12px] text-mist-500">生成只准备字段，不会发布</div>
        {readError && <div className="ml-auto text-[12px] text-rose-600">{readError}</div>}
      </div>
      <div className="mt-2 divide-y divide-mist-100 rounded-xl border border-mist-200 bg-mist-50/40">
        {platforms.map((platform) => {
          const manifest = items.find((item) => item.platform === platform.id)
          const task = tasks.find((item) => item.platform === platform.id)
          const badge = manifestBadge(platform.id, manifest, task, work, labels)
          const failed = manifest?.validation.checks.filter((check) => !check.ok && check.severity === 'block') || []
          const warn = manifest?.validation.checks.filter((check) => check.severity === 'warn') || []
          const open = expanded === platform.id
          const readback = task?.evidence?.readback
          return (
            <div key={platform.id} data-testid={`publish-platform-${platform.id}`} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-[11px] font-semibold tracking-wide text-mist-400">{platform.code}</span>
                <span className="text-[12.5px] font-medium text-mist-800">{platform.name}</span>
                <span data-testid={`publish-status-${platform.id}`} className={`rounded px-1.5 py-0.5 text-[11px] ${badge.className}`}>{badge.text}</span>
                {manifest && (
                  <span className="text-[11px] text-mist-400">r{manifest.revision}</span>
                )}
                {task && (
                  <span data-testid={`publish-task-meta-${platform.id}`} className="text-[11px] text-mist-500">
                    {taskMetaCopy(platform.id, work, task, labels)} · {task.attempt}/{task.max_attempts}
                    {task.last_event_kind ? ` · 最近事件 ${eventCopy[task.last_event_kind] || task.last_event_kind}${task.last_event_at ? ` ${eventTime(task.last_event_at)}` : ''}` : ''}
                  </span>
                )}
                {manifest && (failed.length > 0 || warn.length > 0) && (
                  <button type="button" onClick={() => setExpanded(open ? '' : platform.id)}
                    className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-mist-500 hover:text-mist-800">
                    {failed.length > 0 ? `${failed.length} 个阻断` : `${warn.length} 个提示`}
                    <ChevronDown className={`size-3 transition ${open ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
              <CapabilityBlock platform={platform.id} capabilities={capabilities} />
              <HealthBlock accountID={work.account_id} platform={platform.id} label={platform.name} />
              {task && readback && (
                <div data-testid={`publish-readback-panel-${platform.id}`} className="mt-1.5 ml-11 rounded-lg border border-mist-200 bg-white p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] font-semibold text-mist-800">回读结果</span>
                    <span data-testid={`publish-readback-status-${platform.id}`} className={`ml-auto rounded px-1.5 py-0.5 text-[10.5px] ${readback.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {readback.ok ? '一致' : '不一致'}
                    </span>
                  </div>
                  <div className="mt-1 text-[10.5px] text-mist-400">
                    {readback.checked_at ? eventTime(readback.checked_at) : '时间未知'}
                    {readback.adapter_version ? ` · ${readback.adapter_version}` : ''}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {Object.keys(readbackLabels).map((name) => {
                      const field = readback.fields?.[name]
                      return (
                        <div key={name} data-testid={`publish-readback-field-${platform.id}-${name}`} className="flex gap-1.5 text-[10.5px]">
                          <span className={`mt-0.5 size-1.5 shrink-0 rounded-full ${field?.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                          <span className="w-7 shrink-0 text-mist-500">{readbackLabels[name]}</span>
                          <span className={field?.ok ? 'text-mist-700' : 'text-rose-700'}>{readbackLine(name, field)}</span>
                        </div>
                      )
                    })}
                  </div>
                  {readback.screenshot_asset_id && (
                    <div className="mt-1 flex items-center gap-2">
                      <img
                        data-testid={`publish-readback-shot-${platform.id}`}
                        src={`/api/v1/assets/${readback.screenshot_asset_id}/file?variant=512`}
                        alt="回读截图缩略图"
                        className="h-14 w-10 rounded border border-mist-200 object-cover"
                      />
                      <a href={`/api/v1/assets/${readback.screenshot_asset_id}/file`} target="_blank" rel="noreferrer" className="text-[10.5px] text-ink-600 underline">查看回读截图</a>
                    </div>
                  )}
                  {!readback.ok && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Button size="sm" variant="secondary" loading={pending === `${task.id}:retry`} onClick={() => void actTask(task, 'retry')}>重新填写</Button>
                      <Button size="sm" variant="ghost" loading={pending === `${task.id}:manual`} onClick={() => void actTask(task, 'manual')}>改为手动</Button>
                    </div>
                  )}
                </div>
              )}
              {open && manifest && (
                <div data-testid={`publish-checks-${platform.id}`} className="mt-2 space-y-1 pl-11">
                  {failed.map((check, index) => (
                    <div key={`block-${index}`} className="flex gap-1.5 text-[11.5px] text-rose-700">
                      <CircleAlert className="mt-0.5 size-3 shrink-0" />{check.message}
                    </div>
                  ))}
                  {warn.map((check, index) => (
                    <div key={`warn-${index}`} className="flex gap-1.5 text-[11.5px] text-gamboge-700">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" />{check.message}
                    </div>
                  ))}
                </div>
              )}
              {manifest && failed.length === 0 && !open && (
                <div className="mt-1 flex items-center gap-1 pl-11 text-[11px] text-emerald-700">
                  <CircleCheck className="size-3" />block 项已通过
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-2 pl-11">
                {!manifest || manifest.validation_state === 'stale' ? (
                  <Button size="sm" variant="secondary" loading={pending === `${platform.id}:build`} onClick={() => void generate(platform.id)}>
                    {manifest ? '重新生成' : '生成'}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" loading={pending === `${platform.id}:validate`} onClick={() => void generate(platform.id, true)}>
                    <RefreshCw className="mr-1 size-3.5" />重新校验
                  </Button>
                )}
                {manifest && (manifest.validation_state === 'invalid' || manifest.validation_state === 'stale') && (
                  <Link className="text-[11.5px] text-ink-600 underline" to={`/works/${work.id}`}>去修改</Link>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
