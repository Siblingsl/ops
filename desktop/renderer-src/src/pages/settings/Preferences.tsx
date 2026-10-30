import { Keyboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button, Card, CardHeader, cn, PageHeader, Switch } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import type { UserPrefs } from '@/lib/types'
import { ghostKeys, usePrefs, useSavePrefs } from '@/lib/v3'
import { useSettingsDraft } from '@/lib/desktop-settings'
import { isElectronDesktop, setDesktopMotion, type DesktopClientHealth } from '@/lib/desktop-presentation.js'

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
  const desktop = isElectronDesktop(navigator.userAgent)
  const [reducedMotion, setReducedMotion] = useState(() => document.documentElement.dataset.reducedMotion === 'true')
  const [health, setHealth] = useState<DesktopClientHealth | null>(null)
  useEffect(() => {
    if (!desktop) return
    const unsubscribe = window.opsDesktopUI?.onClientHealth(setHealth)
    const syncMotion = (event: Event) => setReducedMotion(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('ops:desktop-motion', syncMotion)
    return () => { unsubscribe?.(); window.removeEventListener('ops:desktop-motion', syncMotion) }
  }, [desktop])
  useSettingsDraft(false, save.isPending)
  const set = (p: Partial<UserPrefs>) => save.mutate(p, { onError: (e) => toast.error(errorMessage(e)), onSuccess: () => toast.success('已保存', { duration: 1200 }) })
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
          <Row title="平台采集状态" desc={[health?.presence.message, health?.collection.message].filter(Boolean).join('；') || '等待客户端状态'}>
            <span className="text-sm text-mist-500">{health?.collection.status === 'partial' || health?.collection.status === 'failed' ? '采集需处理' : health?.collection.status === 'running' ? '正在采集' : health?.presence.status === 'online' ? '平台在线' : health?.presence.status === 'error' ? '平台异常' : health?.presence.status === 'offline' ? '采集未启用' : '读取中'}</span>
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
            <Switch checked={prefs.use_history} onChange={(v) => set({ use_history: v })} />
          </Row>
          <Row title="边写边提示敏感词与广告法用语" desc="只做本地规则提示，不会自动修改正文；正式检查仍需在「检查」页逐条确认。">
            <Switch checked={prefs.live_lint} onChange={(v) => set({ live_lint: v })} />
          </Row>
          <Row title="续写建议（灰字）" desc={<>按 <b>{prefs.ghost_key}</b> 获取一小段续写建议，Tab 采纳，Esc 放弃。不会自动出现。</>}>
            <Switch checked={prefs.ghost_text} onChange={(v) => set({ ghost_text: v })} />
          </Row>
          {prefs.ghost_text && (
            <Row title="续写快捷键" desc="和输入法或系统快捷键冲突时换一个。">
              <Choice value={prefs.ghost_key} onChange={(v) => set({ ghost_key: v })} options={ghostKeys.map((k) => ({ value: k, label: k }))} />
            </Row>
          )}
          <Row title="起草完自动跳到下一个空段落">
            <Switch checked={prefs.auto_jump_next_empty} onChange={(v) => set({ auto_jump_next_empty: v })} />
          </Row>
          <Row title="打开作品时默认进入专注模式" desc="隐藏侧栏，只留正文。随时可按 Ctrl+Shift+F 切换。">
            <Switch checked={prefs.focus_default} onChange={(v) => set({ focus_default: v })} />
          </Row>
          <Row title="先写结尾" desc="「现在最值得做的」会优先提示你先写结尾段，适合先定落点再写过程的习惯。">
            <Switch checked={prefs.write_ending_first} onChange={(v) => set({ write_ending_first: v })} />
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
          <Switch checked={prefs.ux_events} onChange={(v) => set({ ux_events: v })} />
        </Row>
      </Card>
    </div>
  )
}
