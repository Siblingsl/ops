import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { api, errorMessage, get, post } from '@/lib/api'
import { Button, Card, CardHeader, Empty } from '@/components/ui'

interface PublishTask {
  id: string
  work_id: string
  platform: string
  state: string
  state_version: number
  mode: string
  attempt: number
  max_attempts: number
  last_error_code: string
  last_error_message: string
  updated_at: string
  plan_at?: string
  platform_schedule_at?: string
}


// REF41 P7-A2：计划 vs 平台定时偏差超过 60 秒视为漂移（与服务端同阈值）。
const P7_DRIFT_MS = 60_000

function publishScheduleDrift(plan?: string, platform?: string): boolean {
  if (!plan || !platform) return false
  return Math.abs(new Date(platform).getTime() - new Date(plan).getTime()) > P7_DRIFT_MS
}

const scheduleTime = (v?: string) => (v ? new Date(v).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未记录')

const platformLabels: Record<string, string> = { wechat_mp: '公众号', xhs: '小红书', toutiao: '今日头条' }
const stateColumns: { key: string; label: string; states: string[] }[] = [
  { key: 'queue', label: '待排队', states: ['ready', 'queued'] },
  { key: 'filling', label: '填写中', states: ['filling'] },
  { key: 'filled', label: '已填入待你点', states: ['filled', 'awaiting_user'] },
  { key: 'submitted', label: '已提交', states: ['submitted'] },
  { key: 'scheduled', label: '已预约', states: ['scheduled'] },
  { key: 'published', label: '已发布', states: ['published'] },
  { key: 'failed', label: '失败', states: ['failed'] },
  { key: 'offline', label: '掉线', states: ['not_logged_in'] },
  { key: 'stopped', label: '已停止/跳过', states: ['stopped', 'skipped'] },
]

export function PublishTaskBoard({ account }: { account: { id: string } }) {  const [tasks, setTasks] = useState<PublishTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setTasks(await get<PublishTask[]>('/publish-tasks'))
      setError('')
    } catch (e: unknown) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    load().catch((e: unknown) => { if (active) setError(errorMessage(e)) })
    return () => { active = false }
  }, [account.id])

  // REF41 P6：登记已发布（adopt）——只登记，不再次上传；走 Idempotency-Key。
  const actAdopt = async (task: PublishTask, url: string, note: string) => {
    setBusy(`${task.id}:adopt`)
    try {
      await api('POST', `/publish-tasks/${task.id}/adopt`, { url, note }, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await load()
      toast.success('已登记为已提交；不会再次上传，只登记平台事实。')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  const act = async (task: PublishTask, action: 'retry' | 'skip' | 'manual') => {
    setBusy(`${task.id}:${action}`)
    try {
      await post(`/publish-tasks/${task.id}/${action}`, action === 'skip'
        ? { expected_version: task.state_version, idempotency_key: crypto.randomUUID(), reason: '从看板跳过' }
        : { expected_version: task.state_version, idempotency_key: crypto.randomUUID() })
      await load()
      toast.success(action === 'retry' ? '已重新排队' : action === 'manual' ? '已改为手动通道' : '已跳过')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  // REF41 P6-A3：submit-now 只是写一次性意图，真正点击由桌面在“恰好 1 个匹配页”时执行；
  // 这里不批量、不代点，用户确认后才发。
  const submitNow = async (task: PublishTask) => {
    if (!window.confirm('桌面会在当前已填入的页面点一次发布；请确认页面就是这一篇。点完不会自动再点。')) return
    setBusy(`${task.id}:submit`)
    try {
      await api('POST', `/publish-tasks/${task.id}/submit-now`, {}, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await load()
      toast.success('已交给桌面提交；匹配页不是恰好 1 个时会自动停，不会重复点击。')
    } catch (e: unknown) {
      toast.error(errorMessage(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <Card data-testid="publish-task-board">
      <CardHeader title="发布任务" desc="只看任务队列，不会批量填写或批量发布；每条任务仍需单独推进。" />
      {error && <p className="px-4 py-3 text-[12.5px] text-rose-600">读取失败：{error}</p>}
      {loading ? <p className="px-4 py-3 text-[12.5px] text-mist-500">读取中…</p> : tasks.length === 0 ? (
        <Empty title="暂无发布任务" desc="在作品发布区生成 manifest 后，可创建单篇任务。" />
      ) : (
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {stateColumns.map((column) => {
            const items = tasks.filter((task) => column.states.includes(task.state))
            return (
              <section key={column.key} className="rounded-xl border border-mist-200 bg-mist-50/40 p-3" data-testid={`publish-task-column-${column.key}`}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[12.5px] font-semibold text-mist-800">{column.label}</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11.5px] text-mist-500">{items.length}</span>
                </div>
                {items.length === 0 ? <p className="text-[11.5px] text-mist-400">暂无</p> : (
                  <div className="space-y-2">
                    {items.map((task) => (
                      <div key={task.id} className="rounded-lg border border-mist-100 bg-white p-2.5" data-testid={`publish-task-${task.id}`}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12px] font-medium text-mist-800">{platformLabels[task.platform] || task.platform}</span>
                          <span className="text-[11px] text-mist-400">v{task.state_version} · 尝试 {task.attempt}/{task.max_attempts}</span>
                          <Link className="ml-auto text-[11px] text-ink-600 underline" to={`/works/${task.work_id}`}>查看作品</Link>
                        </div>
                        {task.last_error_code && <p className="mt-1 text-[11.5px] text-rose-600">{task.last_error_code}{task.last_error_message ? `：${task.last_error_message}` : ''}</p>}
                        {(task.plan_at || task.platform_schedule_at) && (
                          <div className="mt-1 space-y-0.5 text-[11px]" data-testid={`publish-task-schedule-${task.id}`}>
                            <p className={publishScheduleDrift(task.plan_at, task.platform_schedule_at) ? 'text-rose-600' : 'text-mist-500'}>
                              计划 {scheduleTime(task.plan_at)}
                            </p>
                            <p className={publishScheduleDrift(task.plan_at, task.platform_schedule_at) ? 'font-medium text-rose-600' : 'text-mist-500'}>
                              平台 {scheduleTime(task.platform_schedule_at)}
                              {publishScheduleDrift(task.plan_at, task.platform_schedule_at) ? ' · 漂移' : ''}
                            </p>
                          </div>
                        )}
                        {(task.platform === 'xhs' && ['filled', 'awaiting_user'].includes(task.state)) && (
                          <p className="mt-1 text-[11px] text-mist-600" data-testid={`publish-task-xhs-draft-${task.id}`}>
                            小红书任务不会由 OPS 点发布；请到小红书草稿箱确认并人工发布。
                          </p>
                        )}
                        {(task.state === 'failed' || task.state === 'not_logged_in') && (
                          <div className="mt-2 flex gap-1.5">
                            <Button size="sm" variant="secondary" loading={busy === `${task.id}:retry`} onClick={() => void act(task, 'retry')}>重试</Button>
                            <Button size="sm" variant="ghost" loading={busy === `${task.id}:manual`} onClick={() => void act(task, 'manual')}>改为手动</Button>
                            <Button size="sm" variant="ghost" loading={busy === `${task.id}:skip`} onClick={() => void act(task, 'skip')}>跳过</Button>
                          </div>
                        )}
                        {['ready', 'queued', 'failed', 'not_logged_in', 'filled', 'awaiting_user'].includes(task.state) && (
                          <div className="mt-2 flex items-center gap-3">
                            {/* REF41 P6：登记已发布——这条已在平台发过，只登记不重发。 */}
                            <button type="button" data-testid={`publish-task-adopt-${task.id}`} disabled={busy === `${task.id}:adopt`}
                              className="text-[11.5px] text-ink-600 underline disabled:opacity-50"
                              onClick={() => {
                                const url = window.prompt('平台链接（必填）：', '')
                                if (!url) return
                                const note = window.prompt('操作说明（必填，500 字内）：', '这条已经在平台发布过，只登记不重发。')
                                if (!note) return
                                void actAdopt(task, url, note)
                              }}>登记已发布</button>
                            {task.state === 'filled' && task.mode === 'desktop' && task.platform !== 'xhs' && (
                              <button type="button" data-testid={`publish-task-submit-now-${task.id}`}
                                disabled={busy === `${task.id}:submit`}
                                className="text-[11.5px] font-medium text-rose-600 underline disabled:opacity-50"
                                onClick={() => void submitNow(task)}>立即提交</button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </Card>
  )
}
