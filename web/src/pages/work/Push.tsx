import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle, Copy, ExternalLink, Loader2, Send, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { BackfillForm, PlatformBinding, PostPushTodos } from '@/components/backfill'
import { useMe } from '@/lib/session'
import { CropPreview } from '@/components/cover-crop'
import { confirm, Dialog } from '@/components/dialog'
import { Badge, Button, Card, cn, Field, HumanGate, Input, Notice, PageState, Switch } from '@/components/ui'
import { ApiError, errorMessage, get, post, stream } from '@/lib/api'
import { assetHtml, assetUrl } from '@/lib/api-base'
import { runeLen } from '@/lib/format'
import { HTML_BYTE_LIMIT, HTML_CHAR_LIMIT } from '@/lib/render'
import { useCanWrite } from '@/lib/session'
import type { CredState, CropBox, WechatDefaults, Work } from '@/lib/types'
import { useWechatHtml } from '@/lib/wechat-html'
import { useWork, WorkHeaderAction } from './WorkLayout'

interface PushPreview {
  mode: 'new' | 'overwrite'
  today_count: number
  daily_limit: number
  fields: WechatDefaults
  credential: CredState | null
  status: Work['status']
  revision: number
  backend_url: string
  can_push: boolean
  material_basis_stale: boolean
  check_revision_stale: boolean
  asset_count: number
  cover_asset: string | null
  cover_crops: Record<string, CropBox> | null
  title: string
  summary: string
  content_format?: Work['content_format']
  panel_images?: number
}

type StepState = { status: 'idle' | 'running' | 'done' | 'failed'; current?: number; total?: number }
const stepLabels: { key: string; label: string; overwriteOnly?: boolean; newsOnly?: boolean }[] = [
  { key: 'check_backend', label: '检查后台是否修改过', overwriteOnly: true },
  { key: 'upload_images', label: '上传图片素材' },
  { key: 'upload_cover', label: '上传封面', newsOnly: true },
  { key: 'write_draft', label: '写入草稿箱' },
]

const backendTodos = [
  '在后台预览，检查排版是否正常',
  '按需设置原创声明（接口不支持，只能在后台设置）',
  '内容使用了 AI 辅助时，按平台要求做 AI 内容声明',
  '发表后回到这里回填链接',
]

export default function Push() {
  const { work, setWork, refresh } = useWork()
  const nav = useNavigate()
  const canWrite = useCanWrite()
  const { data: me } = useMe()
  const canManage = me?.role === 'owner' || me?.role === 'editor'
  // D-048：图文卡片与漫画一样写入图片消息草稿。
  const comic = work.content_format === 'comic' || work.content_format === 'card_post'
  const pv = useQuery({ queryKey: ['push-preview', work.id, work.status, work.revision], queryFn: () => get<PushPreview>(`/works/${work.id}/wechat/push-preview`), enabled: work.platform === 'wechat_mp' })
  const { html, chars, bytes } = useWechatHtml(work)
  const htmlTooLarge = !comic && (chars >= HTML_CHAR_LIMIT || bytes >= HTML_BYTE_LIMIT)
  const [fields, setFields] = useState<WechatDefaults | null>(null)
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<{ step: string; message: string } | null>(null)
  const [choice, setChoice] = useState<{ reason: 'modified' | 'missing'; message: string } | null>(null)
  const [result, setResult] = useState<{ action: string; backend_url: string; today_count: number } | null>(null)
  const [syncingDraft, setSyncingDraft] = useState(false)
  const [todos, setTodos] = useState<boolean[]>(backendTodos.map(() => false))

  // 小红书作品没有公众号草稿接口：直接给出说明和出口，避免把 422 渲染成「加载失败」。
  if (work.platform !== 'wechat_mp') {
    return (
      <>
        <WorkHeaderAction><Button size="sm" variant="primary" onClick={() => nav(`/works/${work.id}/pack`)}>去发布包</Button></WorkHeaderAction>
        <div className="mx-auto max-w-2xl px-6 py-12">
          <Notice tone="gray">
            这是{work.platform === 'xhs' ? '小红书' : '当前平台'}作品，不能写入公众号草稿。
            请到「发布包」导出图文，按顺序手动发布；发布后可以回来回填链接。
          </Notice>
        </div>
      </>
    )
  }
  if (pv.isLoading || !pv.data) return <PageState loading={pv.isLoading} error={pv.error ?? pv.failureReason} retrying={pv.isFetching} onRetry={() => void pv.refetch()} emptyTitle="暂无推送预览数据" />
  const p = pv.data
  const f = fields ?? p.fields
  const setF = (patch: Partial<WechatDefaults>) => setFields({ ...f, ...patch })
  const cover = work.assets.find((a) => a.id === p.cover_asset)
  const credOk = p.credential?.state === 'ok' || p.credential?.state === 'unchecked'
  // PB-03：按钮禁用时必须能就地看到原因，不能只靠 disabled 猜。
  const blockers: string[] = []
  if (!canWrite) blockers.push('观察者只读，不能写入草稿')
  if (!credOk) blockers.push('公众号凭证不可用，需要先在「设置 → 平台账号」重新授权')
  if (htmlTooLarge) blockers.push('排版后正文超出公众号体积上限，需要缩短正文或减少排版')
  if (runeLen(f.author) > 16) blockers.push(`作者名 ${runeLen(f.author)} 字，超过 16 字上限`)
  if (!comic && !cover) blockers.push('还没有设置封面')
  if (comic && !(p.panel_images && p.panel_images > 0)) blockers.push('图片消息还没有任何图片')
  const canPushNow = blockers.length === 0

  const push = async (overwrite: '' | 'overwrite' | 'new' = '', confirmOver = false): Promise<void> => {
    setRunning(true)
    setFailure(null)
    setChoice(null)
    setSteps({})
    let lastStep = ''
    try {
      const done = await stream<{ action: string; backend_url: string; today_count: number }>(`/works/${work.id}/wechat/push`,
        { html, revision: p.revision, fields: f, overwrite_choice: overwrite, confirm_over_limit: confirmOver },
        {
          onEvent: (name, data) => {
            if (name === 'step') {
              lastStep = data.name
              setSteps((s) => ({ ...s, [data.name]: { status: data.status, current: data.current, total: data.total } }))
            } else if (name === 'need_choice') setChoice(data)
          },
        })
      if (done) {
        setResult(done)
        await refresh()
        pv.refetch()
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'push_limit_reached') {
        setRunning(false)
        if (await confirm({ title: '今天的写入次数已达上限', desc: e.message, confirmText: '仍然写入', danger: true })) return push(overwrite, true)
        return
      }
      const step = (e instanceof ApiError && (e.detail as { step?: string })?.step) || lastStep
      if (step) setSteps((s) => ({ ...s, [step]: { ...s[step], status: 'failed' } }))
      setFailure({ step, message: errorMessage(e) })
    } finally {
      setRunning(false)
    }
  }

  const copyHTML = async () => {
    // 只改剪贴板内容，不改发往后端的 html（后端按相对路径解析资产）。
    await navigator.clipboard.writeText(assetHtml(html))
    toast.success('已复制 HTML，可以粘贴到公众号编辑器')
  }

  const syncDraft = async () => {
    if (syncingDraft) return
    setSyncingDraft(true)
    try {
      const r = await post<{ message: string }>(`/works/${work.id}/wechat/sync-draft`)
      toast.message(r.message)
      await refresh()
    } catch (e) { toast.error(errorMessage(e)) }
    finally { setSyncingDraft(false) }
  }

  if (!p.can_push && work.status !== 'published' && !result) {
    return (
      <>
        <WorkHeaderAction>
          <div className="flex items-center gap-2">
            <Link to={`/works/${work.id}/preview`} className="inline-flex items-center rounded-lg border border-mist-200 px-3 py-2 text-xs font-medium text-mist-700 hover:bg-mist-50">看排版</Link>
            <Button size="sm" variant="primary" onClick={() => nav(`/works/${work.id}/check`)}>去检查</Button>
          </div>
        </WorkHeaderAction>
        <div className="mx-auto max-w-2xl px-6 py-12">
          {p.material_basis_stale
            ? <Notice tone="gamboge">素材依据已变化，需重新检查后才能写入草稿。</Notice>
            : p.check_revision_stale
              ? <Notice tone="gamboge">作品内容已变化，需重新检查后才能写入草稿。</Notice>
            : <HumanGate code="H-04">发布前检查还没有全部确认，不能写入草稿。</HumanGate>}
        </div>
      </>
    )
  }

  const showSteps = running || Object.keys(steps).length > 0 || failure
  return (
    <div className="mx-auto grid w-full max-w-[1280px] gap-6 px-6 py-8 lg:grid-cols-[1fr_380px] 2xl:max-w-[1480px]">
      <WorkHeaderAction>
        <div className="flex items-center gap-2">
          <Link to={`/works/${work.id}/preview`} className="inline-flex items-center rounded-lg border border-mist-200 px-3 py-2 text-xs font-medium text-mist-700 hover:bg-mist-50">看排版</Link>
          {!result && work.status !== 'published' ? (
            <Button size="sm" variant="human" loading={running}
              disabled={!canPushNow}
              onClick={() => push()} icon={<Send className="size-4" />}>
              {p.mode === 'overwrite' ? '更新草稿' : comic ? '写入图片消息草稿' : '写入草稿箱'}
            </Button>
          ) : result && work.status !== 'published' ? (
            <Button size="sm" variant="primary" disabled={htmlTooLarge} onClick={async () => {
              // PB-07：再次写入会覆盖平台原草稿，点击前先说清覆盖范围。
              if (!(await confirm({
                title: '覆盖公众号里的原草稿？',
                desc: '会用当前正文、标题、封面和文章设置覆盖作品关联的那篇草稿；草稿箱里的其它草稿不受影响。如果你想保留原草稿，请到公众号后台另存。',
                confirmText: '覆盖原草稿',
                danger: true,
              }))) return
              setResult(null)
              setSteps({})
            }}>再次写入（覆盖原草稿）</Button>
          ) : null}
        </div>
      </WorkHeaderAction>
      <div className="space-y-5">
        {result ? (
          <Card className="overflow-hidden">
            <div className="flex items-center gap-3 bg-ink-600 px-6 py-5 text-white">
              <CheckCircle2 className="size-7" />
              <div>
                <div className="font-display text-[19px] font-bold">已写入公众号草稿箱</div>
                <div className="text-[13px] text-ink-100">{result.action === 'update' ? '覆盖了原草稿' : comic ? '新建了图片消息草稿' : '新建了一篇草稿'} · 今日第 {result.today_count} 次</div>
              </div>
              <a href={result.backend_url} target="_blank" rel="noreferrer" className="ml-auto">
                <Button variant="secondary" icon={<ExternalLink className="size-4" />}>去公众号后台</Button>
              </a>
            </div>
            <div className="p-6">
              {(work.post_push_todos ?? []).length > 0 ? <PostPushTodos work={work} setWork={setWork} /> : (
                <>
                  <div className="mb-3 text-[13px] font-semibold text-mist-700">在后台还需要你完成</div>
                  <ul className="space-y-2">
                    {backendTodos.map((t, i) => (
                      <li key={t}>
                        <label className="flex cursor-pointer items-start gap-2.5 text-[14px] text-mist-700">
                          <input type="checkbox" className="mt-1 accent-ink-600" checked={todos[i]} onChange={(e) => setTodos(todos.map((x, j) => (j === i ? e.target.checked : x)))} />
                          <span className={cn(todos[i] && 'text-mist-400 line-through')}>{t}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="mt-4 text-xs text-mist-400">系统只写入草稿，不会自动发表或群发。</p>
              {/* PB-01：写入成功只是"去后台发表"，发表后要能一键回到回填。 */}
              {work.status !== 'published' && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-mist-50 px-3 py-2.5">
                  <span className="text-[12.5px] text-mist-600">在后台发表完成后：</span>
                  <Button size="sm" variant="primary" onClick={() => nav(`/a/${work.account_id}/review?work=${work.id}`)}>我已发布，去回填</Button>
                </div>
              )}
            </div>
          </Card>
        ) : (
          <Card className="p-6">
            <div className="mb-5 flex items-center gap-2">
              <h2 className="font-display text-[18px] font-bold text-mist-900">写入草稿箱</h2>
              <Badge tone={p.mode === 'overwrite' ? 'blue' : 'ink'}>{p.mode === 'overwrite' ? '覆盖已有草稿' : '新建草稿'}</Badge>
              <span className={cn('ml-auto text-[13px] tabular-nums', p.today_count >= p.daily_limit ? 'font-semibold text-danger' : 'text-mist-500')}>
                今日已写入 {p.today_count} / {p.daily_limit}
              </span>
            </div>
            {htmlTooLarge && <Notice tone="red" className="mb-4">
              排版后的正文超出公众号限制：{chars.toLocaleString()} / {HTML_CHAR_LIMIT.toLocaleString()} 字符，{bytes.toLocaleString()} / {HTML_BYTE_LIMIT.toLocaleString()} 字节（1 MiB）。请缩短正文或减少排版内容后重试。<Link to={`/works/${work.id}/preview`} className="ml-1 underline">查看排版</Link>
            </Notice>}
            {/* PB-03：写入按钮禁用时就地列出全部原因，并给出对应出口。 */}
            {blockers.length > 0 && (
              <Notice tone="gamboge" className="mb-4">
                <div className="font-medium">还不能写入草稿，先处理这几项：</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
                <div className="mt-2 flex flex-wrap gap-3 text-[12.5px]">
                  {!credOk && <Link to="/settings/accounts" className="underline">去重新授权公众号</Link>}
                  {!comic && !cover && <Link to={`/works/${work.id}#step-images`} className="underline">去设置封面</Link>}
                  {htmlTooLarge && <Link to={`/works/${work.id}/preview`} className="underline">查看排版体积</Link>}
                </div>
              </Notice>
            )}
            {/* PB-04：已写入/已发布后作品默认只读，这里直接给"改错了"的出口。 */}
            {work.locked && (
              <Notice tone="gray" className="mb-4">
                这篇作品已在平台上发表，作品页默认只读。需要修改时先解锁编辑，再重新检查、写入草稿；
                <span className="font-medium">解锁后修改不会同步到平台上已发表的内容。</span>
                <Link to={`/works/${work.id}`} className="ml-1 underline">去作品页解锁编辑</Link>
              </Notice>
            )}
            <div className="flex gap-5">
              {comic ? (
                <div className="w-56 shrink-0">
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-mist-200 p-1.5">
                    {work.panels.slice(0, 6).map((panel) => {
                      const a = work.assets.find((x) => x.id === panel.asset_id)
                      return a ? <img key={panel.id} src={assetUrl(a.url)} alt="" className="aspect-square rounded object-cover" /> : (
                        <div key={panel.id} className="aspect-square rounded bg-mist-100" />
                      )
                    })}
                  </div>
                  <p className="mt-2 text-xs text-mist-500">首图为封面 · 共 {p.panel_images ?? 0} 张（永久素材）</p>
                </div>
              ) : cover && p.cover_crops ? (
                <div className="w-56 shrink-0 space-y-2">
                  <div className="overflow-hidden rounded-lg border border-mist-200">
                    <CropPreview src={assetUrl(cover.url)} box={p.cover_crops['2.35_1']} aspect={2.35} />
                    <div className="line-clamp-2 px-2.5 py-2 text-[13px] font-semibold leading-snug text-mist-800">{p.title}</div>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-mist-200 p-2">
                    <div className="line-clamp-2 flex-1 text-[11.5px] text-mist-600">{p.title}</div>
                    <CropPreview src={assetUrl(cover.url)} box={p.cover_crops['1_1']} aspect={1} className="w-10 rounded" />
                  </div>
                </div>
              ) : (
                <Notice tone="red" className="w-56 shrink-0">还没有设置封面。<Link to={`/works/${work.id}#step-images`} className="underline">去设置</Link></Notice>
              )}
              <dl className="min-w-0 flex-1 space-y-2.5 text-[13.5px]">
                <Row label="标题"><span className="font-medium text-mist-900">{p.title}</span> <span className="text-xs text-mist-400">{runeLen(p.title)}/32</span></Row>
                {!comic && <Row label="摘要">{p.summary || <span className="text-mist-400">（留空，微信自动抓取正文前 54 字）</span>}</Row>}
                <Row label="正文">{comic
                  ? <>图片消息 · {p.panel_images ?? 0} 张图 · 纯文本旁白/对白</>
                  : <>{work.sections.length} 段 · {p.asset_count} 张图片 · HTML {chars.toLocaleString()} 字符 / {bytes.toLocaleString()} 字节</>}</Row>
                <Row label="凭证">{credOk ? <span className="text-ink-700">AppID {p.credential?.app_id}</span> : <span className="text-danger">凭证不可用，<Link to="/settings/accounts" className="underline">去设置</Link></span>}</Row>
              </dl>
            </div>
            <div className="mt-6 border-t border-mist-100 pt-5">
              <div className="mb-3 text-[13px] font-semibold text-mist-700">文章设置 <span className="font-normal text-mist-400">· 默认取账号档案，本次修改不会改动默认值</span></div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="作者" counter={{ value: runeLen(f.author), max: 16 }}><Input value={f.author} onChange={(e) => setF({ author: e.target.value })} invalid={runeLen(f.author) > 16} /></Field>
                <Field label="阅读原文链接"><Input value={f.source_url} onChange={(e) => setF({ source_url: e.target.value })} placeholder="可选" /></Field>
              </div>
              <div className="mt-4 flex flex-wrap gap-6 text-[13.5px] text-mist-700">
                <label className="flex items-center gap-2"><Switch checked={f.open_comment} onChange={(v) => setF({ open_comment: v, fans_only_comment: v && f.fans_only_comment })} />开启评论</label>
                <label className={cn('flex items-center gap-2', !f.open_comment && 'opacity-50')}><Switch checked={f.fans_only_comment} disabled={!f.open_comment} onChange={(v) => setF({ fans_only_comment: v })} />仅粉丝可评论</label>
              </div>
            </div>
          </Card>
        )}

        {showSteps && (
          <Card className="p-5">
            <div className="mb-3 text-[13px] font-semibold text-mist-700">写入进度</div>
            <ol className="space-y-2.5">
              {stepLabels.filter((s) => (!s.overwriteOnly || steps[s.key]) && !(comic && s.newsOnly)).map((s) => {
                const st = steps[s.key]
                return (
                  <li key={s.key} className="flex items-center gap-2.5 text-[14px]">
                    {st?.status === 'done' ? <CheckCircle2 className="size-4 text-ink-500" /> : st?.status === 'failed' ? <XCircle className="size-4 text-danger" />
                      : st?.status === 'running' ? <Loader2 className="size-4 animate-spin text-ink-500" /> : <Circle className="size-4 text-mist-300" />}
                    <span className={cn(st?.status === 'failed' ? 'text-danger' : st ? 'text-mist-800' : 'text-mist-400')}>{s.label}</span>
                    {s.key === 'upload_images' && st?.total ? <span className="text-xs tabular-nums text-mist-400">{st.current} / {st.total}</span> : null}
                  </li>
                )
              })}
            </ol>
            {failure && (
              <Notice tone="red" className="mt-4">
                <div className="font-medium">写入失败：{failure.message}</div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => push()}>重试</Button>
                  {!comic && <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={copyHTML}>复制 HTML 手动粘贴</Button>}
                </div>
              </Notice>
            )}
          </Card>
        )}

        {!result && (work.status === 'pushed' || work.status === 'published') && (work.post_push_todos ?? []).length > 0 && (
          <Card className="p-5"><PostPushTodos work={work} setWork={setWork} /></Card>
        )}
        {(work.status === 'pushed' || work.status === 'published') && (<div id="backfill" className="space-y-4"><BackfillForm work={work} setWork={setWork} /><PlatformBinding work={work} setWork={setWork} canManage={canManage} /></div>)}
        {work.status === 'pushed' && work.wechat_draft_media_id && (
          <Card className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1 text-[13px] text-mist-600">同步草稿箱状态：检查这篇草稿是否仍在公众号草稿箱（不会自动改作品状态）。</div>
            <Button size="sm" variant="secondary" loading={syncingDraft} onClick={syncDraft}>同步状态</Button>
          </Card>
        )}
      </div>

      <aside className="space-y-4">
        {!result && work.status !== 'published' && (
          <Card className="p-5">
            <HumanGate code="H-05">每次只写入这一篇，由你亲自点击。系统不会发表或群发。</HumanGate>
            {!canWrite && <Notice tone="gray" className="mt-4">观察者只读，不能写入草稿。</Notice>}
            {!comic && <Button variant="ghost" className="mt-2 w-full" icon={<Copy className="size-4" />} onClick={copyHTML}>复制 HTML（兜底）</Button>}
            {comic && <p className="mt-2 text-center text-xs text-mist-400">每张图会上传为永久素材（占用素材额度），正文为纯文本。</p>}
          </Card>
        )}
        <Notice tone="gray">写入草稿只是把内容放进公众号后台的草稿箱，正式发表需要你在后台操作。每日写入上限可在「设置 → 平台账号」中调整。</Notice>
      </aside>

      <Dialog open={!!choice} onClose={() => setChoice(null)} title={choice?.reason === 'missing' ? '原草稿已不在草稿箱' : '草稿在后台被修改过'} desc={choice?.message}
        footer={choice?.reason === 'missing' ? (
          <>
            <Button variant="ghost" onClick={() => { setChoice(null); document.getElementById('backfill')?.scrollIntoView() }}>它已经发表了</Button>
            <Button variant="human" onClick={() => push('new')}>新建一篇草稿</Button>
          </>
        ) : (
          <>
            <Button onClick={() => push('new')}>另存为新草稿</Button>
            <Button variant="human" onClick={() => push('overwrite')}>仍然覆盖</Button>
          </>
        )}>
        <p className="text-[13px] leading-relaxed text-mist-600">
          {choice?.reason === 'missing' ? '如果已经在后台发表，请在页面下方回填已发布。新建草稿会计入今天的写入次数。' : '另存为新草稿时，旧草稿保留在草稿箱，作品改为关联新草稿。'}
        </p>
      </Dialog>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-10 shrink-0 text-mist-400">{label}</dt>
      <dd className="min-w-0 text-mist-700">{children}</dd>
    </div>
  )
}
