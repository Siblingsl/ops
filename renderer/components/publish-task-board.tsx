import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { api, errorMessage, get, post } from '@/lib/api'
import { Badge, Button, Card, CardHeader, Empty, Notice } from '@/components/ui'

interface TaskRow {
  plan_at?: string
  platform_schedule_at?: string
  /** P6：行内“登记已发布”表单是否展开（纯 UI 状态，不落库）。 */
  adoptOpen?: boolean
  id: string
  work_id: string
  platform: string
  mode: string
  state: string
  state_version: number
  attempt: number
  max_attempts: number
  last_error_code?: string
  last_error_message?: string
}


// REF41 P7-A2：计划 vs 平台定时偏差超过 60 秒视为漂移（与服务端同阈值）。
const P7_DRIFT_MS = 60_000

function publishScheduleDrift(plan?: string, platform?: string): boolean {
  if (!plan || !platform) return false
  return Math.abs(new Date(platform).getTime() - new Date(plan).getTime()) > P7_DRIFT_MS
}

const p7ScheduleTime = (v?: string) => (v ? new Date(v).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未记录')

const platformName: Record<string, string> = { wechat_mp: '公众号', xhs: '小红书', toutiao: '今日头条' }
const boardGroups = [
  { key: 'waiting', name: '待排队', states: ['ready', 'queued'] },
  { key: 'filling', name: '填写中', states: ['filling'] },
  { key: 'filled', name: '已填入待你点', states: ['filled', 'awaiting_user'] },
  { key: 'submitted', name: '已提交', states: ['submitted'] },
  { key: 'scheduled', name: '已预约', states: ['scheduled'] },
  { key: 'published', name: '已发布', states: ['published'] },
  { key: 'failed', name: '失败', states: ['failed'] },
  { key: 'offline', name: '掉线', states: ['not_logged_in'] },
  { key: 'stopped', name: '已停止/跳过', states: ['stopped', 'skipped'] },
] as const

function badgeTone(state: string): 'gray' | 'green' | 'gamboge' | 'red' | 'ink' {
  if (state === 'published') return 'green'
  if (state === 'failed' || state === 'not_logged_in') return 'red'
  if (state === 'filling' || state === 'queued' || state === 'ready') return 'gamboge'
  return 'ink'
}

export function PublishTaskBoard({ account }: { account: { id: string } }) {
  const [rows, setRows] = useState<TaskRow[]>([])
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [adoptOpenId, setAdoptOpenId] = useState('')

  const refresh = async () => {
    try {
      const data = await get<TaskRow[]>('/publish-tasks')
      setRows(data)
      setError('')
    } catch (e: unknown) {
      setError(errorMessage(e))
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => { void refresh() }, [account.id])

  // REF41 P6：登记已发布（adopt）——这条已在平台发过，只登记不重发；桌面用行内表单弹层由 Dialog 完成，这里先用两个 prompt 等价交互。
  const adopt = async (row: TaskRow, url: string, note: string) => {
    setPending(row.id + 'adopt')
    try {
      await api('POST', `/publish-tasks/${row.id}/adopt`, { url, note }, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await refresh()
      toast.success('已登记为已提交；不会再次上传，只登记平台事实。')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setPending('')
    }
  }

  const change = async (row: TaskRow, action: 'retry' | 'skip' | 'manual') => {
    setPending(row.id + action)
    try {
      await post(`/publish-tasks/${row.id}/${action}`, action === 'skip'
        ? { expected_version: row.state_version, idempotency_key: crypto.randomUUID(), reason: '桌面看板手动跳过' }
        : { expected_version: row.state_version, idempotency_key: crypto.randomUUID() })
      await refresh()
      toast.success(action === 'retry' ? '任务已重新排队' : action === 'manual' ? '任务已改为手动通道' : '任务已跳过')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setPending('')
    }
  }

  // REF41 P6-A3：只登记“可以点一次发布”的意图；桌面领到后先复核回读，匹配页不是恰好 1 个就停。
  const submitNow = async (row: TaskRow) => {
    if (!window.confirm('桌面会在当前已填入的页面点一次发布；请确认页面就是这一篇。点完不会自动再点。')) return
    setPending(row.id + 'submit')
    try {
      await api('POST', `/publish-tasks/${row.id}/submit-now`, {}, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await refresh()
      toast.success('已交给桌面提交；回读不一致或匹配页不是 1 个时会自动停。')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setPending('')
    }
  }

  return (
    <Card data-testid="publish-task-board">
      <CardHeader title="发布任务看板" desc="任务状态只读可见；重试、跳过都是逐条操作。" />
      <Notice tone="gamboge">这里没有批量填写、批量提交或全部执行入口；已发布状态只由作品公开回填同步。</Notice>
      {error && <p className="px-4 pt-2 text-[12.5px] text-rose-600">任务读取失败：{error}</p>}
      {!loaded ? <p className="px-4 py-3 text-[12.5px] text-mist-500">正在同步任务队列…</p> : rows.length === 0 ? (
        <Empty title="暂无发布任务" desc="先在作品发布区准备 manifest，再按单篇创建任务。" />
      ) : (
        <div className="grid gap-2 p-4 lg:grid-cols-3">
          {boardGroups.map((group) => {
            const items = rows.filter((row) => (group.states as readonly string[]).includes(row.state))
            return (
              <div key={group.key} className="rounded-xl border border-mist-200 p-2.5" data-testid={`publish-task-column-${group.key}`}>
                <div className="mb-2 flex items-center justify-between">
                  <strong className="text-[12.5px]">{group.name}</strong>
                  <Badge tone="gray">{items.length}</Badge>
                </div>
                {items.length === 0 ? <p className="text-[11.5px] text-mist-400">空</p> : items.map((row) => (
                  <div key={row.id} className="mb-2 rounded-lg bg-mist-50 p-2.5 last:mb-0" data-testid={`publish-task-${row.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium">{platformName[row.platform] || row.platform}</span>
                      <Badge tone={badgeTone(row.state)}>v{row.state_version}</Badge>
                      <span className="text-[11px] text-mist-500">{row.attempt}/{row.max_attempts}</span>
                      <Link className="ml-auto text-[11px] text-ink-600 underline" to={`/works/${row.work_id}`}>打开</Link>
                    </div>
                    {row.last_error_code && <p className="mt-1 text-[11.5px] text-rose-600">{row.last_error_code}</p>}
                    {(row.plan_at || row.platform_schedule_at) && (
                      <div className="mt-1 space-y-0.5 text-[11px]" data-testid={`publish-task-schedule-${row.id}`}>
                        <p className={publishScheduleDrift(row.plan_at, row.platform_schedule_at) ? 'text-rose-600' : 'text-mist-500'}>
                          计划 {p7ScheduleTime(row.plan_at)}
                        </p>
                        <p className={publishScheduleDrift(row.plan_at, row.platform_schedule_at) ? 'font-medium text-rose-600' : 'text-mist-500'}>
                          平台 {p7ScheduleTime(row.platform_schedule_at)}
                          {publishScheduleDrift(row.plan_at, row.platform_schedule_at) ? ' · 漂移' : ''}
                        </p>
                      </div>
                    )}
                    {(row.platform === 'xhs' && ['filled', 'awaiting_user'].includes(row.state)) && (
                      <p className="mt-1 text-[11px] text-mist-600" data-testid={`publish-task-xhs-draft-${row.id}`}>
                        小红书任务不会由 OPS 点发布；请到小红书草稿箱确认并人工发布。
                      </p>
                    )}
                    {(row.state === 'failed' || row.state === 'not_logged_in') && (
                      <div className="mt-2 flex gap-1">
                        <Button size="sm" variant="secondary" loading={pending === row.id + 'retry'} onClick={() => void change(row, 'retry')}>重试</Button>
                        <Button size="sm" variant="ghost" loading={pending === row.id + 'manual'} onClick={() => void change(row, 'manual')}>改为手动</Button>
                        <Button size="sm" variant="ghost" loading={pending === row.id + 'skip'} onClick={() => void change(row, 'skip')}>跳过</Button>
                      </div>
                    )}
                    {['ready', 'queued', 'failed', 'not_logged_in', 'filled', 'awaiting_user'].includes(row.state) && (
                      adoptOpenId === row.id ? (
                        <div className="mt-1.5 space-y-1" data-testid={`publish-task-adopt-form-${row.id}`}>
                          <input data-testid={`publish-task-adopt-url-${row.id}`} defaultValue="" placeholder="平台链接（必填）"
                            className="h-7 w-full rounded border border-mist-200 px-2 text-[11px]" />
                          <input data-testid={`publish-task-adopt-note-${row.id}`} defaultValue="这条已经在平台发布过，只登记不重发。"
                            className="h-7 w-full rounded border border-mist-200 px-2 text-[11px]" />
                          <div className="flex gap-1">
                            <Button size="sm" variant="secondary" loading={pending === row.id + 'adopt'}
                              onClick={() => {
                                const root = document.querySelector(`[data-testid="publish-task-adopt-form-${row.id}"]`)
                                const url = (root?.querySelector('[data-testid="' + `publish-task-adopt-url-${row.id}` + '"]') as HTMLInputElement | null)?.value?.trim() ?? ''
                                const note = (root?.querySelector('[data-testid="' + `publish-task-adopt-note-${row.id}` + '"]') as HTMLInputElement | null)?.value?.trim() ?? ''
                                if (!url || !note) { toast.error('平台链接与说明都不能为空'); return }
                                void adopt(row, url, note)
                                setAdoptOpenId('')
                              }}>确认登记</Button>
                            <Button size="sm" variant="ghost" onClick={() => setAdoptOpenId('')}>取消</Button>
                          </div>
                          <p className="text-[10.5px] text-mist-500">不会再次上传，只登记平台事实。</p>
                        </div>
                      ) : (
                        <div className="mt-1.5 flex items-center gap-3">
                          <button type="button" data-testid={`publish-task-adopt-${row.id}`}
                            className="text-[11px] text-ink-600 underline"
                            onClick={() => setAdoptOpenId(row.id)}>登记已发布</button>
                          {row.state === 'filled' && row.mode === 'desktop' && row.platform !== 'xhs' && (
                            <button type="button" data-testid={`publish-task-submit-now-${row.id}`}
                              disabled={pending === row.id + 'submit'}
                              className="text-[11px] font-medium text-rose-600 underline disabled:opacity-50"
                              onClick={() => void submitNow(row)}>立即提交</button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
