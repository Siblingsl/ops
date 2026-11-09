import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage, get, post } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { Asset, Metric, Work } from '@/lib/types'
import { Button, Card, Field, Input, Notice, Select, Textarea } from './ui'

interface PublishStateEvent {
  id: string
  event_kind: 'transition' | 'correction' | 'import' | 'invalidation'
  from_state: string | null
  to_state: string
  state_version: number
  evidence: Record<string, unknown>
  note: string
  at: string
}

interface PublishState {
  state: 'submitted' | 'scheduled' | 'public' | 'registered' | null
  version: number
  submitted_ref: { platform?: string; kind?: string; handoff_note?: string; recorded_at?: string } | null
  scheduled_at: string | null
  schedule_evidence: { kind?: string; url?: string; asset_id?: string; confirmed_screenshot?: boolean } | null
  publication: { url: string | null; at: string | null; publish_revision: number }
  registration: { metric_id: string | null; revision: number | null; valid: boolean }
  history: PublishStateEvent[]
}

const stateLabel: Record<string, string> = { submitted: '已交接', scheduled: '已预约', public: '已公开', registered: '已登记基线' }
const eventLabel: Record<PublishStateEvent['event_kind'], string> = {
  transition: '进度变更', correction: '更正发布记录', import: '导入既有公开事实', invalidation: '登记基线失效',
}
const formalMetricSources = new Set(['wechat_api', 'wechat_browser', 'xhs_browser', 'file', 'screenshot', 'paste', 'manual'])

function metricIsEligible(metric: Metric) {
  return metric.quality_state === 'approved' && formalMetricSources.has(metric.source) && (
    (metric.reads !== null && metric.read_unit !== 'unknown') ||
    (metric.shares !== null && metric.share_unit !== 'unknown') ||
    metric.likes !== null || metric.wows !== null || metric.favorites !== null || metric.comments !== null ||
    metric.follows_gained !== null || metric.impressions !== null
  )
}

function metricLabel(metric: Metric) {
  const values = [
    metric.reads === null ? null : `阅读 ${metric.reads}`,
    metric.likes === null ? null : `赞 ${metric.likes}`,
    metric.favorites === null ? null : `收藏 ${metric.favorites}`,
    metric.comments === null ? null : `评论 ${metric.comments}`,
    metric.shares === null ? null : `分享 ${metric.shares}`,
  ].filter(Boolean)
  return `${fmtTime(metric.captured_at)} · ${metric.source} · ${values.join('，')}`
}

function imageAssets(work: Work): Asset[] {
  return work.assets.filter((asset) => asset.mime.startsWith('image/'))
}

/** 发布台账只记录人工交接、预约和正式基线；公开事实仍由 BackfillForm 的原入口写入。 */
export function PublishStatePanel({ work, canManage }: { work: Work; canManage: boolean }) {
  const [data, setData] = useState<PublishState | null>(null)
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [handoffNote, setHandoffNote] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [evidenceKind, setEvidenceKind] = useState<'asset' | 'url'>('asset')
  const [assetId, setAssetId] = useState('')
  const [backendUrl, setBackendUrl] = useState('')
  const [confirmedScreenshot, setConfirmedScreenshot] = useState(false)
  const [reason, setReason] = useState('')
  const [metricId, setMetricId] = useState('')
  const assets = useMemo(() => imageAssets(work), [work.assets])
  const eligibleMetrics = useMemo(() => metrics.filter(metricIsEligible), [metrics])

  const refresh = useCallback(async () => {
    const [state, workMetrics] = await Promise.all([
      get<PublishState>(`/works/${work.id}/publish-state`),
      get<Metric[]>(`/works/${work.id}/metrics`),
    ])
    setData(state)
    setMetrics(workMetrics)
    setMetricId((current) => workMetrics.some((metric) => metric.id === current && metricIsEligible(metric))
      ? current : workMetrics.find(metricIsEligible)?.id || '')
    return state
  }, [work.id])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([get<PublishState>(`/works/${work.id}/publish-state`), get<Metric[]>(`/works/${work.id}/metrics`)]).then(([state, workMetrics]) => {
      if (!active) return
      setData(state)
      setMetrics(workMetrics)
      setMetricId((current) => current || workMetrics.find(metricIsEligible)?.id || '')
    }).catch((error: unknown) => {
      if (active) toast.error(`读取发布进度失败：${errorMessage(error)}`)
    }).finally(() => { if (active) setLoading(false) })
    const onPublished = (event: Event) => {
      const detail = (event as CustomEvent<{ workId?: string }>).detail
      if (detail?.workId !== work.id) return
      void refresh().catch((error: unknown) => toast.error(`刷新发布进度失败：${errorMessage(error)}`))
    }
    window.addEventListener('ops:published', onPublished)
    return () => {
      active = false
      window.removeEventListener('ops:published', onPublished)
    }
  }, [refresh, work.id])

  const transition = async (to: string, extra: Record<string, unknown> = {}) => {
    if (!data) return
    setBusy(true)
    try {
      const next = await post<PublishState>(`/works/${work.id}/publish-state/transition`, {
        base_version: data.version,
        idempotency_key: crypto.randomUUID(),
        to,
        ...extra,
      })
      setData(next)
      window.dispatchEvent(new CustomEvent('ops:publish-state-changed', {
        detail: { workId: work.id, scheduledAt: next.scheduled_at },
      }))
      setHandoffNote('')
      setReason('')
      setConfirmedScreenshot(false)
      toast.success('发布进度已记录')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try { setData(await refresh()) } catch { /* Keep current fields visible when refresh also fails. */ }
      }
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Card className="p-4 text-[13px] text-mist-500" aria-busy="true">正在读取发布进度…</Card>
  if (!data) return <Card className="p-4"><Notice tone="gamboge">发布进度暂不可用，请检查网络后重新打开作品。</Notice></Card>

  const submitHandoff = () => transition('submitted', { submitted_ref: { handoff_note: handoffNote.trim() } })
  const submitSchedule = () => {
    const evidence = evidenceKind === 'asset'
      ? { asset_id: assetId, confirmed_screenshot: confirmedScreenshot }
      : { backend_url: backendUrl.trim() }
    return transition('scheduled', { scheduled_at: new Date(scheduledAt).toISOString(), evidence })
  }
  const eligible = eligibleMetrics.find((metric) => metric.id === metricId)
  const stateName = data.state ? stateLabel[data.state] : '未交接'
  const handoffReady = work.platform === 'wechat_mp' ? work.status === 'pushed' && !!work.wechat_draft_media_id : work.status === 'packed'

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-[16px] font-bold text-mist-900">发布进度</h3>
          <p className="mt-1 text-[13px] text-mist-500">记录你在平台完成的交接和预约。作品公开状态仍由下方“回填已发布”登记。</p>
        </div>
        <span className="rounded-full bg-mist-100 px-2.5 py-1 text-[12px] font-medium text-mist-700">{stateName} · v{data.version}</span>
      </div>

      {data.state === null && (
        <div className="mt-4 space-y-3">
          {handoffReady ? <>
            <Field label="交接说明" hint={work.platform === 'wechat_mp' ? '将关联本作品当前成功的公众号草稿回执。' : '只有当前有效发布包可登记；生成发布包本身不代表已在平台提交。'}>
              <Textarea value={handoffNote} onChange={(event) => setHandoffNote(event.target.value)} rows={2} maxLength={500} placeholder="例如：已在平台后台核对内容并交给发布人" />
            </Field>
            {canManage && <Button loading={busy} onClick={submitHandoff} disabled={!handoffNote.trim()}>记录已交接</Button>}
          </> : <Notice tone="gray">完成{work.platform === 'wechat_mp' ? '公众号草稿写入' : '当前发布包生成'}后，才能记录人工交接。</Notice>}
        </div>
      )}

      {data.state === 'submitted' && (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-mist-600">交接说明：{data.submitted_ref?.handoff_note || '未填写'} · {fmtTime(data.submitted_ref?.recorded_at)}</p>
          <Field label="平台预约时间" hint="仅记录你在平台后台完成的预约，不会创建自动发布任务。">
            <Input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </Field>
          <Field label="预约凭证">
            <Select aria-label="预约凭证类型" value={evidenceKind} onChange={(event) => setEvidenceKind(event.target.value as 'asset' | 'url')}>
              <option value="asset">本作品图片资产（平台预约截图）</option>
              <option value="url">平台后台 HTTPS 链接</option>
            </Select>
          </Field>
          {evidenceKind === 'asset' ? <>
            <Field label="截图图片" hint="只选择能证明平台预约完成的截图。">
              <Select aria-label="预约截图图片" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                <option value="">选择图片</option>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.alt_text || asset.id}</option>)}
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-[13px] text-mist-600">
              <input type="checkbox" checked={confirmedScreenshot} onChange={(event) => setConfirmedScreenshot(event.target.checked)} />
              我确认这张图片是平台预约完成后的截图
            </label>
          </> : <Field label="平台后台链接" hint="只接受该平台的 HTTPS 后台域名，不含查询参数。">
            <Input value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="https://" />
          </Field>}
          {canManage && <Button loading={busy} onClick={submitSchedule} disabled={!scheduledAt || (evidenceKind === 'asset' ? !assetId || !confirmedScreenshot : !backendUrl.trim())}>记录已预约</Button>}
        </div>
      )}

      {data.state === 'scheduled' && (
        <div className="mt-4 space-y-3">
          <Notice tone="ink">预约时间：{fmtTime(data.scheduled_at)}。系统不会在该时间自动发布。</Notice>
          {data.schedule_evidence?.url && <p className="break-all text-[13px] text-mist-500">后台凭证：{data.schedule_evidence.url}</p>}
          {data.schedule_evidence?.asset_id && <p className="text-[13px] text-mist-500">预约截图资产：{data.schedule_evidence.asset_id}</p>}
          {canManage && <Field label="取消预约原因"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} placeholder="说明为什么取消预约" /></Field>}
          {canManage && <Button variant="secondary" loading={busy} onClick={() => transition('submitted', { reason: reason.trim() })} disabled={!reason.trim()}>取消预约并退回已交接</Button>}
        </div>
      )}

      {(data.state === 'public' || data.state === 'registered') && (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-mist-600">公开记录来自原发布回填入口：{data.publication.at ? fmtTime(data.publication.at) : '时间未知'}{data.publication.url ? ` · ${data.publication.url}` : ' · 未填写链接'}</p>
          {data.state === 'registered' && data.registration.valid ? <Notice tone="ink">已登记正式指标基线，指标修订或质量状态变化后会自动失效。</Notice> : <>
            <Field label="正式指标基线" hint="只列出当前 approved 且包含至少一个可用指标的正式快照；未知单位不用于阅读数或分享数。">
              <Select aria-label="正式指标基线" value={metricId} onChange={(event) => setMetricId(event.target.value)}>
                <option value="">选择一条正式指标</option>
                {eligibleMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metricLabel(metric)}</option>)}
              </Select>
            </Field>
            {canManage && <Button loading={busy} onClick={() => eligible && transition('registered', { metric_id: eligible.id, metric_revision: eligible.revision })} disabled={!eligible}>登记正式基线</Button>}
          </>}
        </div>
      )}

      {!canManage && <p className="mt-4 text-[12px] text-mist-500">当前角色只读；需要工作区编辑者或所有者记录进度。</p>}

      {data.history.length > 0 && <div className="mt-5 border-t border-mist-100 pt-4">
        <h4 className="mb-2 text-[13px] font-semibold text-mist-700">进度记录</h4>
        <ol className="space-y-2">
          {data.history.map((event) => <li key={event.id} className="text-[12px] text-mist-500">
            <span className="font-medium text-mist-700">{eventLabel[event.event_kind]}</span> · {event.from_state ? `${stateLabel[event.from_state] || event.from_state} → ` : ''}{stateLabel[event.to_state] || event.to_state} · {fmtTime(event.at)}
            {event.note && <span> · {event.note}</span>}
          </li>)}
        </ol>
      </div>}
    </Card>
  )
}
