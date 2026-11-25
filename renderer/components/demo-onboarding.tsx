import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowRight, CheckCircle2, Cpu, Lightbulb, Sparkles, UserPlus, X } from 'lucide-react'
import { Badge, Button, Card, cn, Notice, platformLabel } from '@/components/ui'
import { confirm } from '@/components/dialog'
import { del, errorMessage, post } from '@/lib/api'
import { DESKTOP_ACCOUNT_CREATE_REQUEST, DESKTOP_ACCOUNT_SWITCHER_REQUEST } from '@/lib/desktop-settings'
import { isElectronDesktop } from '@/lib/desktop-presentation.js'
import { forgetAccount, rememberAccount, useAccounts, useInvalidate, useMe } from '@/lib/session'
import type { Account } from '@/lib/types'

// OPT-U01（docs/43 §4）：零账号可直接进入“5 分钟演示工作区”。
// 演示数据只在当前工作区生效，服务端对 is_demo 账号硬拦真实写入；这里只负责引导与显式标识。

export type DemoCreateResult = {
  account_id: string
  xhs_account_id?: string
  account_ids?: string[]
}

/** 首启 3 步卡是否展示：示例账号、未配模型或还没有作品时提示；用户手动收起后保持安静。 */
export function isOnboardingGuideVisible({ isDemo, modelReady, totalWorks, dismissed }: {
  isDemo: boolean
  modelReady: boolean
  totalWorks: number
  dismissed: boolean
}): boolean {
  if (dismissed) return false
  return isDemo || !modelReady || totalWorks === 0
}

/** 在公众号示例与小红书示例之间互切：返回另一个仍在使用的示例账号。 */
export function pickPeerDemoAccount(accounts: Account[] | undefined, currentAccountId: string): Account | undefined {
  return (accounts ?? []).find((account) => account.is_demo && account.status === 'active' && account.id !== currentAccountId)
}

/** 工作区里是否已有真实活跃账号（用于第 3 步“已绑定真实账号”和清空后的落点）。 */
export function hasRealActiveAccount(accounts: Account[] | undefined): boolean {
  return (accounts ?? []).some((account) => account.status === 'active' && !account.is_demo)
}

/** 创建双平台示例工作区并落到公众号示例账号。所有入口共用同一 POST /demo 契约。 */
export function useEnterDemoWorkspace() {
  const nav = useNavigate()
  const inv = useInvalidate()
  const { data: me } = useMe()
  const [busy, setBusy] = useState(false)
  const enter = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await post<DemoCreateResult>('/demo')
      await inv(['accounts'])
      rememberAccount(res.account_id, me?.user_id ?? me?.username, me?.workspace.id)
      toast.success('示例工作区已创建，可以开始试写了')
      nav(`/a/${res.account_id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return { enter, busy }
}

/** 一键清空示例账号与示例稿件；只影响 is_demo 数据，清完优先落到真实账号。 */
export function useClearDemoWorkspace() {
  const nav = useNavigate()
  const inv = useInvalidate()
  const { data: me } = useMe()
  const { data: accounts } = useAccounts()
  const [busy, setBusy] = useState(false)
  const clear = async (): Promise<boolean> => {
    const confirmed = await confirm({
      title: '清空所有示例账号与示例稿件？',
      desc: '会删除所有示例账号、示例选题、示例素材与示例稿件，不影响你后续自己新建的真实账号和作品。',
      confirmText: '清空示例数据',
      danger: true,
    })
    if (!confirmed) return false
    setBusy(true)
    try {
      await del('/demo')
      const list = accounts ?? []
      for (const account of list) {
        if (account.is_demo) forgetAccount(account.id, me?.user_id ?? me?.username, me?.workspace.id)
      }
      await inv(['accounts'])
      toast.success('示例账号与示例稿件已清空')
      const real = list.find((account) => account.status === 'active' && !account.is_demo)
      if (real) {
        rememberAccount(real.id, me?.user_id ?? me?.username, me?.workspace.id)
        nav(`/a/${real.id}`)
      } else {
        nav('/')
      }
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { clear, busy }
}

/** 示例徽标：工作台标题与账号摘要共用，确保演示号在任何页面一眼可辨。 */
export function DemoBadge() {
  return <span data-testid="demo-account-badge" className="shrink-0"><Badge tone="gamboge">示例</Badge></span>
}

/** 零活跃账号时的欢迎页：不强制跳设置，直接给出示例体验/绑定真实账号两条路。 */
export function ColdStartWelcome() {
  const { data: me } = useMe()
  const nav = useNavigate()
  const desktop = isElectronDesktop(navigator.userAgent)
  const owner = me?.role === 'owner'
  const { enter, busy } = useEnterDemoWorkspace()
  return (
    <Card className="mx-auto mt-8 max-w-2xl space-y-5 p-7" data-testid="cold-start-welcome">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-gamboge-50 text-gamboge-700">
          <Sparkles className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-mist-900">先不用绑定平台账号，也能完整走一遍写作流程</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-mist-600">
            示例工作区里有 1 个公众号示例 + 1 个小红书示例，带着定位档案、风格样本、选题、素材和草稿。可以体验快写、检查、预览与复盘，但不会写入任何真实平台。
          </p>
        </div>
      </div>
      {owner ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" data-testid="cold-start-enter-demo" loading={busy} onClick={() => void enter()}>
              先用示例账号体验 5 分钟写作（无需绑定真实号）
            </Button>
            <Button variant="secondary" onClick={() => {
              if (desktop) window.dispatchEvent(new Event(DESKTOP_ACCOUNT_SWITCHER_REQUEST))
              else nav('/settings/accounts?new=1')
            }}>绑定我的真实账号</Button>
            <Button variant="ghost" onClick={() => nav('/agent')}>先打开 AI 对话</Button>
          </div>
          <ul className="grid gap-2 text-[12.5px] text-mist-600 sm:grid-cols-3">
            <li className="flex items-start gap-1.5"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />示例账号随时可一键清空</li>
            <li className="flex items-start gap-1.5"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />示例数据不会写入真实平台</li>
            <li className="flex items-start gap-1.5"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />不影响你自己新建的真实账号与作品</li>
          </ul>
        </>
      ) : (
        <>
          <p className="rounded-lg bg-mist-50 px-3.5 py-3 text-[13px] leading-relaxed text-mist-600">
            当前工作区还没有真实平台账号。请联系工作区所有者添加真实账号，或由所有者开启示例体验。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => nav('/agent')}>先打开 AI 对话</Button>
            <Button variant="secondary" onClick={() => nav('/settings/members')}>查看工作区成员</Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** 工作台顶部固定提示条：仅示例账号出现，含互切与 owner 一键清空。 */
export function DemoModeBanner({ account }: { account: Account }) {
  const nav = useNavigate()
  const { data: accounts } = useAccounts()
  const { data: me } = useMe()
  const { clear, busy } = useClearDemoWorkspace()
  if (!account.is_demo) return null
  const peer = pickPeerDemoAccount(accounts, account.id)
  const owner = me?.role === 'owner'
  return (
    <Notice tone="gamboge" className="mb-5" data-testid="demo-mode-banner" icon={<Sparkles className="size-4" aria-hidden="true" />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <strong className="font-semibold">当前处于示例体验模式 · 不可对外推送 · 随时可一键清空</strong>
        {peer && (
          <button type="button" className="cursor-pointer text-[12.5px] font-medium underline underline-offset-2"
            onClick={() => {
              rememberAccount(peer.id, me?.user_id ?? me?.username, me?.workspace.id)
              nav(`/a/${peer.id}`)
            }}>
            切到{platformLabel[peer.platform]}示例
          </button>
        )}
        {owner && <Button size="sm" variant="ghost" data-testid="demo-clear-button" loading={busy} onClick={() => void clear()}>清空所有示例账号与示例稿件</Button>}
      </div>
    </Notice>
  )
}

/** 3 步首启卡：模型 → 试写 → 绑定真实账号并清空示例；收起状态按账号记入 localStorage。 */
export function OnboardingStepsCard({ account, modelReady, totalWorks, sampleWorkId, onCreateWork }: {
  account: Account
  modelReady: boolean
  totalWorks: number
  sampleWorkId?: string
  onCreateWork: () => void
}) {
  const nav = useNavigate()
  const { data: accounts } = useAccounts()
  const { data: me } = useMe()
  const { clear, busy } = useClearDemoWorkspace()
  const storageKey = `ops.onboarding.3steps.v1:${account.id}`
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1' } catch { return false }
  })
  useEffect(() => {
    try { setDismissed(localStorage.getItem(storageKey) === '1') } catch { setDismissed(false) }
  }, [storageKey])
  if (!isOnboardingGuideVisible({ isDemo: !!account.is_demo, modelReady, totalWorks, dismissed })) return null
  const realBound = hasRealActiveAccount(accounts)
  const hasDemo = (accounts ?? []).some((item) => item.is_demo)
  const bind = (platform: 'wechat_mp' | 'xhs') => {
    if (isElectronDesktop(navigator.userAgent)) {
      window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_CREATE_REQUEST, { detail: { platform } }))
    } else {
      nav(`/settings/accounts?new=1&platform=${platform}`)
    }
  }
  const dismiss = () => {
    setDismissed(true)
    try { localStorage.setItem(storageKey, '1') } catch { /* 本机存储不可用时只影响本次收起 */ }
  }
  const step = 'flex items-start gap-3 rounded-lg border border-mist-200 bg-white px-3.5 py-3'
  return (
    <Card className="mb-5" data-testid="onboarding-3-steps">
      <div className="flex items-center gap-2 border-b border-mist-100 px-4 py-3">
        <Lightbulb className="size-4 text-ink-600" aria-hidden="true" />
        <h2 className="text-[13.5px] font-semibold text-mist-900">3 步开始写作</h2>
        <span className="text-[12px] text-mist-400">不需要先绑定平台账号</span>
        <button type="button" aria-label="收起首启引导" title="收起首启引导" onClick={dismiss}
          className="ml-auto cursor-pointer rounded p-1 text-mist-400 transition hover:bg-mist-100 hover:text-mist-700">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="grid gap-2 p-4 sm:grid-cols-3">
        <div className={step}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-50 text-[12px] font-bold text-ink-700">1</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-mist-900"><Cpu className="size-3.5 text-mist-400" aria-hidden="true" />配好 1 个真实 AI 模型</div>
            <div className="mt-2">
              {modelReady ? <Badge tone="green">已就绪</Badge> : <Link to="/settings/models"><Button size="sm" variant="secondary">去配置</Button></Link>}
            </div>
          </div>
        </div>
        <div className={step}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-50 text-[12px] font-bold text-ink-700">2</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-mist-900"><Lightbulb className="size-3.5 text-mist-400" aria-hidden="true" />试写 1 篇稿子</div>
            <div className="mt-2">
              {sampleWorkId
                ? <Link to={`/works/${sampleWorkId}`}><Button size="sm" variant="secondary">打开示例稿试写 <ArrowRight className="size-3.5" /></Button></Link>
                : <Button size="sm" variant="secondary" onClick={onCreateWork}>新建试写</Button>}
            </div>
          </div>
        </div>
        <div className={step}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-50 text-[12px] font-bold text-ink-700">3</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-mist-900"><UserPlus className="size-3.5 text-mist-400" aria-hidden="true" />绑定真实账号并清空示例</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {realBound
                ? <Badge tone="green">已绑定真实账号</Badge>
                : me?.role === 'owner'
                  ? <>
                    <Button size="sm" variant="secondary" onClick={() => bind('wechat_mp')}>绑定公众号</Button>
                    <Button size="sm" variant="secondary" onClick={() => bind('xhs')}>绑定小红书</Button>
                  </>
                  : <span className="text-[12px] text-mist-500">请联系工作区所有者绑定真实账号</span>
              }
              {hasDemo && me?.role === 'owner' && <Button size="sm" variant="ghost" loading={busy} onClick={() => void clear()}>一键清空示例</Button>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}

/** 兼容旧入口的轻量示例导入行：真实账号工作区可在折叠区导入示例。 */
export function DemoImportRow({ className }: { className?: string }) {
  const { data: accounts } = useAccounts()
  const { data: me } = useMe()
  const { enter, busy } = useEnterDemoWorkspace()
  if (me?.role !== 'owner' || (accounts ?? []).some((item) => item.is_demo)) return null
  return (
    <button type="button" disabled={busy} onClick={() => void enter()}
      className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl border border-dashed border-mist-300 px-5 py-3 text-left text-[13px] text-mist-600 transition hover:border-ink-300 hover:bg-ink-50/40 disabled:opacity-45', className)}>
      <Sparkles className="size-4 text-gamboge-500" aria-hidden="true" />
      <span className="flex-1">想先看看完整流程？导入双平台示例账号（含档案、风格样本、素材、选题和一篇作品），随时可一键清除。</span>
      <ArrowRight className="size-4 text-mist-400" aria-hidden="true" />
    </button>
  )
}
