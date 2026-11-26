import { Keyboard } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, CardHeader, cn, Notice, PageHeader, Switch } from '@/components/ui'
import { confirm } from '@/components/dialog'
import { errorMessage } from '@/lib/api'
import { getPlatformCollectionDisabledInfo, useDesktopCapabilities } from '@/lib/desktop-capabilities'
import type { UserPrefs } from '@/lib/types'
import { ghostKeys, usePrefs, useSavePrefs } from '@/lib/v3'
import { useSettingsDraft } from '@/lib/desktop-settings'
import { isElectronDesktop, setDesktopMotion, type DesktopClientHealth, type DesktopUpdateStatus } from '@/lib/desktop-presentation.js'
import { checkDesktopUpdate, getDesktopUpdateStatus, hasDesktopBridgeMethod, invokeDesktopInBrowse, subscribeDesktopClientHealth, subscribeDesktopUpdateStatus } from '@/lib/platform-bridge'
import DesktopUpdateDialog from '@/components/desktop-update-dialog'

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-3.5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-mist-800">{title}</div>
        {desc && <p className="mt-0.5 text-[12.5px] leading-relaxed text-mist-500">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-mist-100 p-1">
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          className={cn('h-7 cursor-pointer rounded-md px-3 text-[12.5px] font-medium transition', value === o.value ? 'bg-white text-mist-900 shadow-sm' : 'text-mist-500 hover:text-mist-800')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Preferences (EX-K-02 / EX-K-03 / S3): per-user editor behaviour, cost tier and the opt-in UX events. */
export default function Preferences() {
  const prefs = usePrefs()
  const save = useSavePrefs()
  const navigate = useNavigate()
  const desktop = isElectronDesktop(navigator.userAgent)
  // OPT-U06（docs/43 §4）：只读能力查询与账号连接卡共用缓存，服务端关闭时在此明确说明原因。
  const capabilitiesQuery = useDesktopCapabilities(desktop)
  const platformDisabled = getPlatformCollectionDisabledInfo(capabilitiesQuery.data)
  const [reducedMotion, setReducedMotion] = useState(() => document.documentElement.dataset.reducedMotion === 'true')
  const [health, setHealth] = useState<DesktopClientHealth | null>(null)
  // OPT-E02（docs/43 §5）：设置页的版本与更新入口。状态来自主进程只读推送/查询，
  // 渲染器不直接请求版本接口，也不发起任何下载。
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  useEffect(() => {
    if (!desktop) return
    const unsubscribe = subscribeDesktopClientHealth(setHealth)
    const syncMotion = (event: Event) => setReducedMotion(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('ops:desktop-motion', syncMotion)
    return () => { unsubscribe(); window.removeEventListener('ops:desktop-motion', syncMotion) }
  }, [desktop])
  useEffect(() => {
    if (!desktop) return
    if (!hasDesktopBridgeMethod('onUpdateStatus')) return
    let alive = true
    const unsubscribe = subscribeDesktopUpdateStatus(setUpdateStatus)
    void getDesktopUpdateStatus().then((result) => {
      if (alive && result.ok) setUpdateStatus(result.status)
    }).catch(() => undefined)
    return () => { alive = false; unsubscribe() }
  }, [desktop])
  useSettingsDraft(false, save.isPending)
  const set = (p: Partial<UserPrefs>) => save.mutate(p, { onError: (e) => toast.error(errorMessage(e)), onSuccess: () => toast.success('已保存', { duration: 1200 }) })
  const updateStatusText = updateStatus
    ? updateStatus.status === 'checking'
      ? '正在检查…'
      : updateStatus.status === 'idle'
        ? '尚未检查'
        : updateStatus.updateAvailable && updateStatus.latestVersion
          ? `发现新版本 v${updateStatus.latestVersion}`
          : updateStatus.status === 'error'
            ? `检查失败：${updateStatus.error || '请稍后重试'}`
            : updateStatus.status === 'unconfigured' || !updateStatus.latestVersion
              ? '服务端未配置更新源'
              : '已是最新版本'
    : '尚未检查'
  const currentVersionText = updateStatus?.currentVersion ? `v${updateStatus.currentVersion}` : '未知'
  const checkUpdate = async () => {
    if (!hasDesktopBridgeMethod('checkUpdate')) {
      toast.info('当前环境不支持客户端更新检查')
      return
    }
    setCheckingUpdate(true)
    try {
      const result = await checkDesktopUpdate()
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      setUpdateStatus(result.status)
      if (result.status.status === 'error') toast.error(result.status.error || '检查更新失败')
      else if (result.status.updateAvailable && result.status.latestVersion) {
        toast.success(`发现新版本 v${result.status.latestVersion}`, { duration: 1500 })
      } else if (result.status.status === 'unconfigured' || !result.status.latestVersion) {
        toast.info('服务端未配置更新源')
      } else {
        toast.success('已是最新版本', { duration: 1200 })
      }
    } catch {
      toast.error('检查更新失败，请稍后重试')
    } finally {
      setCheckingUpdate(false)
    }
  }
  return (
    <div className="max-w-3xl animate-fade-in">
      <PageHeader title="偏好设置" desc="只影响你自己，不影响同一工作区的其他成员。"
        action={<Button icon={<Keyboard className="size-4" />} onClick={() => window.dispatchEvent(new Event('ops:shortcuts'))}>查看快捷键</Button>} />
      {desktop && <Card className="mb-5">
        <CardHeader title="此电脑" desc="以下设置和状态只针对当前客户端。" />
        <div className="divide-y divide-mist-100">
          <Row title="减少动态效果" desc="减少界面动画，设置立即生效。">
            <Switch label="减少动态效果" checked={reducedMotion} onChange={(value) => {
              if (setDesktopMotion(document, window.localStorage, value) === null) return
              setReducedMotion(value)
              window.open(`ops-desktop://ui/motion/${value ? 'reduce' : 'soft'}`, '_blank', 'noopener,noreferrer')
            }} />
          </Row>
          <Row title="平台采集状态" desc={platformDisabled
            ? '服务端平台采集已暂停，本机不会发送采集与状态心跳。'
            : ([health?.presence.message, health?.collection.message].filter(Boolean).join('；') || '等待客户端状态')}>
            <span className={cn('text-sm', platformDisabled ? 'font-medium text-gamboge-700' : 'text-mist-500')}>{platformDisabled
              ? '服务端已暂停采集'
              : health?.collection.status === 'partial' || health?.collection.status === 'failed' ? '采集需处理' : health?.collection.status === 'running' ? '正在采集' : health?.presence.status === 'online' ? '平台在线' : health?.presence.status === 'error' ? '平台异常' : health?.presence.status === 'offline' ? '采集未启用' : '读取中'}</span>
          </Row>
          {platformDisabled && <div className="px-5 py-3">
            <Notice tone="gamboge" data-testid="preferences-platform-disabled-notice">{platformDisabled.hint}</Notice>
          </div>}
          {/* OPT-E02（docs/43 §5）：客户端版本与更新。检查不打断写稿，只有用户点「查看更新」才开弹窗。 */}
          <Row title="客户端版本与更新" desc={`当前版本 ${currentVersionText} · ${updateStatusText}`}>
            <div className="flex flex-wrap justify-end gap-2" data-testid="desktop-update-row">
              {updateStatus?.updateAvailable && updateStatus.latestVersion && (
                <Button size="sm" variant="secondary" onClick={() => setUpdateDialogOpen(true)}>查看更新</Button>
              )}
              <Button size="sm" variant="secondary" loading={checkingUpdate} onClick={checkUpdate}
                data-testid="desktop-check-update-btn">检查更新</Button>
            </div>
          </Row>
          {/* OPT-U04（docs/43 §4）：本机状态与诊断在偏好设置里一键直达，不必再猜设置入口。 */}
          <Row title="本机客户端管理" desc="连接状态、平台登录与诊断信息都在本机设置中查看。">
            <div className="flex flex-wrap justify-end gap-2" data-testid="desktop-local-settings-shortcuts">
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings/local/connection')}>客户端连接</Button>
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings/local/account-device')}>账号与设备</Button>
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings/local/diagnostics')}>诊断与关于</Button>
            </div>
          </Row>
        </div>
      </Card>}
      <Card className="mb-5">
        <CardHeader title="写作" desc="段落起草、续写与检查的默认行为" />
        <div className="divide-y divide-mist-100">
          <Row title="每次生成几个候选" desc="选 3 个时会并排给出三个版本，你挑一个再改；更费 token。">
            <Choice value={prefs.default_variants} onChange={(v) => set({ default_variants: v })} options={[{ value: 1, label: '1 个' }, { value: 3, label: '3 个' }]} />
          </Row>
          <Row title="起草时参考我的历史作品" desc="从本账号过去的作品里找相似段落作为参考，引用会在「本次参考」里列出。">
            <Switch label="起草时参考我的历史作品" checked={prefs.use_history} onChange={(v) => set({ use_history: v })} />
          </Row>
          <Row title="边写边提示敏感词与广告法用语" desc="只做本地规则提示，不会自动修改正文；正式检查仍需在「检查」页逐条确认。">
            <Switch label="边写边提示敏感词与广告法用语" checked={prefs.live_lint} onChange={(v) => set({ live_lint: v })} />
          </Row>
          <Row title="续写建议（灰字）" desc={<>按 <b>{prefs.ghost_key}</b> 获取一小段续写建议，Tab 采纳，Esc 放弃。不会自动出现。</>}>
            <Switch label="续写建议（灰字）" checked={prefs.ghost_text} onChange={(v) => set({ ghost_text: v })} />
          </Row>
          {prefs.ghost_text && (
            <Row title="续写快捷键" desc="和输入法或系统快捷键冲突时换一个。">
              <Choice value={prefs.ghost_key} onChange={(v) => set({ ghost_key: v })} options={ghostKeys.map((k) => ({ value: k, label: k }))} />
            </Row>
          )}
          <Row title="起草完自动跳到下一个空段落">
            <Switch label="起草完自动跳到下一个空段落" checked={prefs.auto_jump_next_empty} onChange={(v) => set({ auto_jump_next_empty: v })} />
          </Row>
          <Row title="打开作品时默认进入专注模式" desc="隐藏侧栏，只留正文。随时可按 Ctrl+Shift+F 切换。">
            <Switch label="打开作品时默认进入专注模式" checked={prefs.focus_default} onChange={(v) => set({ focus_default: v })} />
          </Row>
          <Row title="先写结尾" desc="「现在最值得做的」会优先提示你先写结尾段，适合先定落点再写过程的习惯。">
            <Switch label="先写结尾" checked={prefs.write_ending_first} onChange={(v) => set({ write_ending_first: v })} />
          </Row>
        </div>
      </Card>
      <Card className="mb-5">
        <CardHeader title="AI 档位" desc="影响起草、改写等任务默认用哪一档模型；在模型配置里可为每档指定具体模型。" />
        <div className="px-5 py-4">
          <Choice value={prefs.cost_tier} onChange={(v) => set({ cost_tier: v })} options={[
            { value: 'economy', label: '省钱' }, { value: 'standard', label: '标准' }, { value: 'quality', label: '高质量' },
          ]} />
          <p className="mt-2 text-[12.5px] text-mist-500">
            {prefs.cost_tier === 'economy' ? '优先用便宜、快速的模型，适合整理笔记、打标签等轻任务。' : prefs.cost_tier === 'quality' ? '优先用效果最好的模型，适合重要文章；token 花费更高。' : '默认档位，兼顾质量与花费。'}
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader title="帮助我们改进" />
        <Row title="匿名记录使用体验事件" desc="只记录「打开了哪个功能、点了哪个按钮」这类事件名，不记录任何正文、标题或素材内容。默认关闭。">
          <Switch label="匿名记录使用体验事件" checked={prefs.ux_events} onChange={(v) => set({ ux_events: v })} />
        </Row>
      </Card>
      {desktop && <InBrowseDataCard />}
      {desktop && <DesktopUpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} status={updateStatus} />}
    </div>
  )
}

// DEV-AI27-08g（27 §14.5）：浏览实例数据受控清理——只作用于内置浏览分区
// （persist:ops-inbrowse），不触碰业务登录态；与"OPS 证据"（agent 浏览证据，
// 由工作台/导出入口管理）分开展示，避免误清两类数据。
function InBrowseDataCard() {
  const [stats, setStats] = useState<{ cacheBytes: number | null; cookiesCount: number | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const result = await invokeDesktopInBrowse('inbrowse:data-stats')
      if (result.ok && result.data && typeof result.data === 'object') setStats(result.data as { cacheBytes: number | null; cookiesCount: number | null })
    } catch { /* Web 或旧宿主：卡片本就不渲染 */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const clear = async (kind: 'cache' | 'cookies') => {
    const ok = await confirm({
      title: kind === 'cache' ? '清理浏览缓存？' : '清理浏览 Cookies 与站点数据？',
      desc: kind === 'cache'
        ? '只会清理内置浏览页签的 HTTP 缓存，不影响登录状态。'
        : '会清理内置浏览页签的 Cookies 与站点数据；这些站点需要重新登录。OPS 本身的登录状态不受影响。',
      confirmText: kind === 'cache' ? '清理缓存' : '清理站点数据',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await invokeDesktopInBrowse('inbrowse:clear-data', kind)
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success(kind === 'cache' ? '已清理浏览缓存' : '已清理浏览 Cookies 与站点数据', { duration: 1600 })
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }
  const fmtBytes = (n: number | null) => n === null ? '未知' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
  return <Card className="mt-5">
    <CardHeader title="浏览数据" desc="只清理内置浏览页签的缓存与 Cookies（浏览实例自己的数据）。业务登录态、OPS 浏览证据与作品数据都不在这里，不受影响。要在工作台清理 OPS 浏览证据，请使用对应工作台入口，勿混淆两类数据。" />
    <div className="divide-y divide-mist-100">
      <Row title="浏览缓存" desc={`内置浏览页签的 HTTP 缓存，当前 ${stats ? fmtBytes(stats.cacheBytes) : '读取中'}。清理不影响任何登录状态。`}>
        <Button variant="secondary" disabled={busy} onClick={() => void clear('cache')}>清理缓存</Button>
      </Row>
      <Row title="浏览 Cookies 与站点数据" desc={`内置浏览页签各站点留下的 Cookies/本地存储，当前 ${stats ? `${stats.cookiesCount ?? '未知'} 条 Cookies` : '读取中'}。清理后内置浏览里登录过的站点需要重新登录；OPS 本身的登录不受影响。`}>
        <Button variant="secondary" disabled={busy} onClick={() => void clear('cookies')}>清理站点数据</Button>
      </Row>
    </div>
  </Card>
}
