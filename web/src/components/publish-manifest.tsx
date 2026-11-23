import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage, get, post } from '@/lib/api'
import type { Work } from '@/lib/types'
import { Button } from './ui'

interface PublishCheck {
  code: string
  ok: boolean
  severity: 'block' | 'warn'
  field: string
  message: string
}

interface PublishManifest {
  platform: string
  revision: number
  content_hash: string
  validation_state: 'pending' | 'valid' | 'invalid' | 'stale'
  validation: { checks: PublishCheck[] }
  payload: {
    fields: { title: string; body_text: string; tags: string[]; cover_asset_id: string | null }
  }
  updated_at: string
}

interface PublishReadbackField {
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

interface PublishReadback {
  checked_at?: string
  adapter_version?: string
  ok?: boolean
  fields?: Record<string, PublishReadbackField>
  screenshot_asset_id?: string
  tab_ref?: string
}

interface PublishTask {
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
  evidence?: { readback?: PublishReadback }
}

interface PublishCapabilityChannel {
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

interface PublishCapabilityPlatform {
  platform: string
  channels: PublishCapabilityChannel[]
}

interface PublishLabelsResponse {
  labels: Record<string, string>
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

const platformMeta: Record<string, { label: string; short: string }> = {
  wechat_mp: { label: '公众号', short: '公众号' },
  xhs: { label: '小红书', short: '小红书' },
  toutiao: { label: '今日头条', short: '头条' },
}

function statusCopy(platform: string, manifest: PublishManifest | undefined, task: PublishTask | undefined, work: Work, labels: Record<string, string>) {
  if (!labels.packed) return { label: '读取中…', tone: 'idle' as const }
  // 四态文案只从服务端 labels 取；只有作品所属平台且 work.status=published 才能出现“已发布”。
  if (work.status === 'published' && platform === work.platform) return { label: labels.published, tone: 'done' as const }
  if (task?.state === 'submitted' || task?.state === 'scheduled' || task?.state === 'published') {
    const key = work.platform === 'wechat_mp' ? 'submitted_wechat_mp' : 'submitted'
    return { label: labels[key], tone: 'done' as const }
  }
  if (task?.state === 'awaiting_user') return { label: labels.awaiting_user, tone: 'ready' as const }
  if (task?.state === 'filled') return { label: labels.filled, tone: 'ready' as const }
  if (!manifest) return { label: labels.packed, tone: 'idle' as const }
  if (manifest.validation_state === 'stale') return { label: '已过期', tone: 'stale' as const }
  if (manifest.validation_state === 'invalid') return { label: '校验未通过', tone: 'bad' as const }
  return { label: labels.packed, tone: 'ok' as const }
}

const toneClass = {
  idle: 'bg-mist-100 text-mist-600',
  ok: 'bg-emerald-50 text-emerald-700',
  ready: 'bg-sky-50 text-sky-700',
  done: 'bg-ink-100 text-ink-700',
  stale: 'bg-gamboge-50 text-gamboge-700',
  bad: 'bg-rose-50 text-rose-700',
}

const taskStateText: Record<string, string> = {
  ready: '待排队', queued: '待排队', filling: '填写中', filled: '已填入待你点', awaiting_user: '待你点发布',
  submitted: '已提交', scheduled: '已预约', published: '已发布', failed: '失败', not_logged_in: '掉线',
  skipped: '已跳过', stopped: '已停止',
}
// meta 行与 badge 共用同一平台守卫：非作品平台的任务不得出现“已发布”。
function taskMetaText(platform: string, work: Work, task: PublishTask, labels: Record<string, string>): string {
  if (task.state === 'published') {
    return platform === work.platform ? taskStateText.published : (labels.submitted || '已交接')
  }
  return taskStateText[task.state] || task.state
}
const eventText: Record<string, string> = {
  transition: '状态变更', fill: '填写', readback: '回读', drift: '发现漂移', correction: '修正',
  adopt: '采用', import: '导入', invalidation: '失效', retry: '重试',
}

function shortHash(value: string | undefined) {
  if (!value) return '缺失'
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

function readbackFieldLine(name: string, field: PublishReadbackField | undefined) {
  if (!field) return '缺失'
  switch (name) {
    case 'title':
      return `期望 hash ${shortHash(field.expected_hash)} / 实际 hash ${shortHash(field.actual_hash)}`
    case 'body':
      return `期望 ${field.expected_len ?? 0} 字 / 实际 ${field.actual_len ?? 0} 字`
    case 'tags':
      return `期望 ${field.expected_count ?? 0} 个 / 实际 ${field.actual_count ?? 0} 个 · 首项 ${field.first || '无'}`
    case 'cover':
      return `期望 ${field.expected_present ? '有封面' : '无封面'} / 实际 ${field.present ? '有封面' : '无封面'}${field.actual_ratio ? ` · 比例 ${field.actual_ratio}` : ''}`
    case 'schedule':
      return `期望 ${field.expected || '立即'} / 实际 ${field.actual || '立即'}`
    default:
      return '缺失'
  }
}

const readbackFieldLabels: Record<string, string> = {
  title: '标题', body: '正文', tags: '标签', cover: '封面', schedule: '定时',
}

function ReadbackPanel({ task, busy, onAction }: {
  task: PublishTask
  busy: string
  onAction: (action: 'retry' | 'manual') => void
}) {
  const readback = task.evidence?.readback
  if (!readback) return null
  const ok = readback.ok === true
  return (
    <div data-testid={`publish-readback-panel-${task.platform}`} className="mt-2 rounded-lg border border-mist-200 bg-white p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-mist-800">回读结果</span>
        <span data-testid={`publish-readback-status-${task.platform}`} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
          {ok ? '一致' : '不一致'}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-mist-400">
        {readback.checked_at ? new Date(readback.checked_at).toLocaleString('zh-CN') : '时间未知'}
        {readback.adapter_version ? ` · ${readback.adapter_version}` : ''}
      </div>
      <div className="mt-1.5 space-y-1">
        {Object.keys(readbackFieldLabels).map((name) => {
          const field = readback.fields?.[name]
          return (
            <div key={name} data-testid={`publish-readback-field-${task.platform}-${name}`} className="flex items-start gap-1.5 text-[11.5px]">
              <span className={`mt-0.5 size-2 shrink-0 rounded-full ${field?.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
              <span className="w-8 shrink-0 text-mist-500">{readbackFieldLabels[name]}</span>
              <span className={field?.ok ? 'text-mist-700' : 'text-rose-700'}>{readbackFieldLine(name, field)}</span>
            </div>
          )
        })}
      </div>
      {readback.screenshot_asset_id && (
        <div className="mt-1.5 flex items-center gap-2">
          <img
            data-testid={`publish-readback-shot-${task.platform}`}
            src={`/api/v1/assets/${readback.screenshot_asset_id}/file?variant=512`}
            alt="回读截图缩略图"
            className="h-16 w-12 rounded border border-mist-200 object-cover"
          />
          <a href={`/api/v1/assets/${readback.screenshot_asset_id}/file`} target="_blank" rel="noreferrer" className="text-[11.5px] text-ink-600 underline">
            查看回读截图
          </a>
        </div>
      )}
      {!ok && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" loading={busy === `${task.id}:retry`} onClick={() => onAction('retry')}>重新填写</Button>
          <Button size="sm" variant="ghost" loading={busy === `${task.id}:manual`} onClick={() => onAction('manual')}>改为手动</Button>
        </div>
      )}
    </div>
  )
}

const channelMeta: Record<string, string> = {
  api: 'API', desktop: '桌面自动填写', manual: '手动',
}

function CapabilityPanel({ platform, capabilities }: {
  platform: string
  capabilities: PublishCapabilityPlatform[]
}) {
  const platformCapability = capabilities.find((item) => item.platform === platform)
  if (!platformCapability) return null
  return (
    <div data-testid={`publish-capability-panel-${platform}`} className="mt-2 rounded-lg border border-mist-200 bg-white p-2.5">
      <div className="mb-1 text-[12px] font-semibold text-mist-800">平台能力</div>
      <div className="space-y-1.5">
        {platformCapability.channels.map((item) => (
          <div key={item.channel} data-testid={`publish-capability-${platform}-${item.channel}`} className="rounded border border-mist-100 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[11.5px] font-medium text-mist-700">{channelMeta[item.channel] || item.channel}</span>
              <span className="text-[11px] text-mist-400">{item.why}</span>
              {item.available ? (
                <span data-testid={`publish-capability-available-${platform}-${item.channel}`} className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                  可用{item.calibrated ? ' · 已校准' : ''}
                </span>
              ) : (
                <button
                  type="button"
                  disabled
                  data-testid={`publish-capability-disabled-${platform}-${item.channel}`}
                  className="ml-auto rounded-full bg-mist-100 px-2 py-0.5 text-[11px] text-mist-500"
                >
                  不可用
                </button>
              )}
            </div>
            {!item.available && (
              <div data-testid={`publish-capability-reason-${platform}-${item.channel}`} className="mt-0.5 text-[11px] text-rose-700">
                {item.disabled_reason || '暂不可用'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** REF41 P5：账号×平台体检状态。只读展示在线/未登录/未体检与最近体检时间，可手动重新体检。 */
function HealthStrip({ accountID, platforms }: { accountID: string; platforms: string[] }) {
  const [checks, setChecks] = useState<PublishHealthCheck[]>([])
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const list = await get<{ checks: PublishHealthCheck[] }>(`/accounts/${accountID}/publish-health`)
    setChecks(list.checks ?? [])
  }, [accountID])
  useEffect(() => { load().catch(() => undefined) }, [load])
  const recheck = async (platform: string) => {
    setBusy(platform)
    try {
      await post(`/accounts/${accountID}/publish-health/check`, { platforms: [platform] })
      await load()
      toast.success(`${platformMeta[platform]?.label || platform} 体检已排队`)
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }
  if (!platforms.length) return null
  return (
    <div data-testid="publish-health-strip" className="mt-2 rounded-lg border border-mist-200 bg-white p-2.5">
      <div className="mb-1 text-[12px] font-semibold text-mist-800">通道体检</div>
      <div className="space-y-1">
        {platforms.map((platform) => {
          const latest = checks.find((c) => c.platform === platform)
          const state = latest ? (latest.state === 'succeeded' ? (latest.result?.logged_in ? '在线' : '未登录') : latest.state === 'failed' || latest.state === 'expired' ? '体检失败' : '体检中') : '未体检'
          const tone = state === '在线' ? 'bg-emerald-50 text-emerald-700' : state === '未登录' ? 'bg-gamboge-50 text-gamboge-700' : 'bg-mist-100 text-mist-500'
          return (
            <div key={platform} data-testid={`publish-health-${platform}`} className="flex items-center gap-2 text-[11.5px]">
              <span className="font-medium text-mist-700">{platformMeta[platform]?.label || platform}</span>
              <span data-testid={`publish-health-state-${platform}`} className={`rounded-full px-2 py-0.5 text-[11px] ${tone}`}>{state}</span>
              {latest?.finished_at && <span className="text-[11px] text-mist-400">{new Date(latest.finished_at).toLocaleString()}</span>}
              <button type="button" data-testid={`publish-health-recheck-${platform}`} disabled={busy === platform}
                className="ml-auto rounded border border-mist-200 px-2 py-0.5 text-[11px] text-mist-600 hover:bg-mist-50 disabled:opacity-50"
                onClick={() => void recheck(platform)}>
                {busy === platform ? '排队中…' : '重新体检'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** REF41 P1：作品详情发布分区。生成 manifest 只准备字段，不触发任何平台发布。 */
export function PublishManifestPanel({ work }: { work: Work }) {
  const [manifests, setManifests] = useState<PublishManifest[]>([])
  const [tasks, setTasks] = useState<PublishTask[]>([])
  const [capabilities, setCapabilities] = useState<PublishCapabilityPlatform[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [list, taskList, capabilitiesList, labelsResponse] = await Promise.all([
      get<PublishManifest[]>(`/works/${work.id}/publish-manifests`),
      get<PublishTask[]>(`/works/${work.id}/publish-tasks`),
      get<PublishCapabilityPlatform[]>(`/publish/capabilities?account_id=${work.account_id}`),
      get<PublishLabelsResponse>('/publish/labels'),
    ])
    setManifests(list)
    setTasks(taskList)
    setCapabilities(capabilitiesList)
    setLabels(labelsResponse.labels || {})
    setError('')
  }, [work.id, work.account_id])

  useEffect(() => {
    let active = true
    setLoading(true)
    load().catch((e: unknown) => { if (active) setError(errorMessage(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load, work.revision])

  const run = async (platform: string, action: 'build' | 'validate') => {
    setBusy(`${platform}:${action}`)
    try {
      await post(`/works/${work.id}/publish-manifests/${platform}${action === 'validate' ? '/validate' : ''}`)
      await load()
      toast.success(action === 'build' ? `${platformMeta[platform]?.label || platform} manifest 已生成` : '已重新校验')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const actTask = async (task: PublishTask, action: 'retry' | 'manual') => {
    setBusy(`${task.id}:${action}`)
    try {
      await post(`/publish-tasks/${task.id}/${action}`, {
        expected_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      })
      await load()
      toast.success(action === 'retry' ? '已重新排队' : '已改为手动通道')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <section data-testid="publish-manifest-panel" className="border-t border-mist-100 bg-white px-5 py-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold text-mist-800">发布</h2>
        <p className="text-[12px] text-mist-500">先准备并校验发布字段；生成不会触发发布，公开事实仍以作品回填为准。</p>
        {error && <span className="text-[12px] text-rose-600">读取失败：{error}</span>}
        {!error && loading && <span className="text-[12px] text-mist-400">读取中…</span>}
      </div>
      <div className="grid gap-2 lg:grid-cols-3">
        {Object.entries(platformMeta).map(([platform, meta]) => {
          const manifest = manifests.find((item) => item.platform === platform)
          const task = tasks.find((item) => item.platform === platform)
          const status = statusCopy(platform, manifest, task, work, labels)
          const failed = manifest?.validation.checks.filter((check) => !check.ok && check.severity === 'block') || []
          const warnings = manifest?.validation.checks.filter((check) => check.severity === 'warn') || []
          return (
            <div key={platform} data-testid={`publish-platform-${platform}`} className="rounded-xl border border-mist-200 bg-mist-50/50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-mist-800">{meta.label}</span>
                <span data-testid={`publish-status-${platform}`} className={`ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-medium ${toneClass[status.tone]}`}>
                  {status.label}
                </span>
              </div>
              {manifest ? (
                <div className="mt-1 text-[11.5px] text-mist-500">
                  修订 {manifest.revision} · {manifest.validation_state === 'stale' ? '内容已变化' : manifest.validation_state === 'invalid' ? '存在 block 项' : manifest.validation_state === 'pending' ? '尚未校验' : 'block 项已通过'}
                </div>
              ) : (
                <div className="mt-1 text-[11.5px] text-mist-500">尚未生成发布字段快照</div>
              )}
              {task && (
                <div data-testid={`publish-task-meta-${platform}`} className="mt-1 text-[11.5px] text-mist-500">
                  任务 {taskMetaText(platform, work, task, labels)} · 尝试 {task.attempt}/{task.max_attempts}
                  {task.last_event_kind ? ` · 最近事件 ${eventText[task.last_event_kind] || task.last_event_kind}${task.last_event_at ? ` ${new Date(task.last_event_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}` : ''}
                  {task.last_error_code ? ` · 错误 ${task.last_error_code}` : ''}
                </div>
              )}
              <CapabilityPanel platform={platform} capabilities={capabilities} />
              <HealthStrip accountID={work.account_id} platforms={[platform]} />
              {task && <ReadbackPanel task={task} busy={busy} onAction={(action) => void actTask(task, action)} />}
              {(failed.length > 0 || warnings.length > 0) && (
                <ul data-testid={`publish-checks-${platform}`} className="mt-2 space-y-1">
                  {failed.map((check, index) => (
                    <li key={`block-${check.code}-${index}`} className="flex items-start gap-1.5 text-[12px] text-rose-700">
                      <XCircle className="mt-0.5 size-3.5 shrink-0" />
                      <span>{check.message}</span>
                    </li>
                  ))}
                  {warnings.map((check, index) => (
                    <li key={`warn-${check.code}-${index}`} className="flex items-start gap-1.5 text-[12px] text-gamboge-700">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>{check.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {manifest && failed.length === 0 && (
                <div className="mt-2 flex items-center gap-1.5 text-[12px] text-emerald-700">
                  <CheckCircle2 className="size-3.5" />全部 block 项通过
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {!manifest || manifest.validation_state === 'stale' ? (
                  <Button size="sm" variant="secondary" loading={busy === `${platform}:build`} onClick={() => void run(platform, 'build')}>
                    {manifest ? '重新生成' : '生成'}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" loading={busy === `${platform}:validate`} onClick={() => void run(platform, 'validate')}>
                    <RefreshCw className="mr-1 size-3.5" />重新校验
                  </Button>
                )}
                {(manifest?.validation_state === 'invalid' || manifest?.validation_state === 'stale') && (
                  <Link to={`/works/${work.id}`} className="text-[12px] font-medium text-ink-600 underline">去修改</Link>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
