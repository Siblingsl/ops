import { CheckCircle2, CircleAlert, Copy, Globe2, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn, Field, Input, Notice, PlatformMark, platformLabel, Textarea } from '@/components/ui'
import { ApiError, errorMessage, post, put } from '@/lib/api'
import { copyText, fmtTime } from '@/lib/format'
import { useSystemInfo } from '@/lib/session'
import type { Account, ContentFormat, CredState, Platform } from '@/lib/types'

// D-048 首批预设类型（与 ui.tsx platformFormats、后端 formatMatrix 一致）。每个类型都有真实工作流。
const matrix: Record<Platform, { value: ContentFormat; label: string; desc: string }[]> = {
  wechat_mp: [
    { value: 'long_article', label: '长图文', desc: '图文并茂的文章，写入公众号草稿箱' },
    { value: 'qa_article', label: '问答体长图文', desc: '以问题与回答组织全文的深度文章，写入公众号草稿箱' },
    { value: 'briefing', label: '资讯简报', desc: '导语加条目的短篇汇总，篇幅更紧凑，写入公众号草稿箱' },
    { value: 'card_post', label: '图文卡片', desc: '逐卡文案配 AI 生成图片，写入公众号图片消息草稿' },
    { value: 'script', label: '口播脚本', desc: '镜头化脚本文档（镜号/口播/画面），脚本辅助，不含视频制作' },
    { value: 'comic', label: '漫画', desc: '角色卡 + 分镜脚本 + 逐格文案与回传图片' },
  ],
  xhs: [
    { value: 'image_note', label: '图文笔记', desc: '多图 + 短文，生成发布包手动发布' },
    { value: 'list_note', label: '清单合集笔记', desc: '以编号清单组织要点与合集，生成发布包手动发布' },
    { value: 'card_post', label: '图文卡片', desc: '逐卡文案配 AI 生成图片，打包进发布包' },
    { value: 'script', label: '口播脚本', desc: '镜头化脚本文档（镜号/口播/画面），脚本辅助，不含视频制作' },
    { value: 'comic', label: '漫画', desc: '角色卡 + 分镜脚本 + 逐格文案与回传图片' },
  ],
  toutiao: [
    { value: 'long_article', label: '文章', desc: '头条文章，生成发布包后手动发布' },
    { value: 'micro_post', label: '微头条', desc: '短内容，可不配图，生成发布包后手动发布' },
  ],
}

export function AccountCreateForm({
  onCreated,
  submitText = '添加账号',
  defaultPlatform = 'wechat_mp',
  fixedPlatform = false,
  beforeSubmit,
  onSubmitFinished,
  onBusyChange,
}: {
  onCreated: (a: Account) => void
  submitText?: string
  defaultPlatform?: Platform
  fixedPlatform?: boolean
  beforeSubmit?: () => boolean | Promise<boolean>
  onSubmitFinished?: (success: boolean) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [platform, setPlatform] = useState<Platform>(defaultPlatform)
  const [format, setFormat] = useState<ContentFormat>(matrix[defaultPlatform][0].value)
  const [name, setName] = useState('')
  const [typeNote, setTypeNote] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; platform?: string; content_format?: string }>({})
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const pick = (p: Platform) => {
    setPlatform(p)
    setFormat(matrix[p][0].value)
    setFieldErrors((current) => ({ ...current, platform: undefined, content_format: undefined }))
  }
  const submit = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onBusyChange?.(true)
    try {
      if (beforeSubmit && !(await beforeSubmit())) return
      const a = await post<Account>('/accounts', { platform, name, content_format: format, type_note: typeNote.trim() })
      onSubmitFinished?.(true)
      setName('')
      setTypeNote('')
      setPlatform(defaultPlatform)
      setFormat(matrix[defaultPlatform][0].value)
      setBusy(false)
      onBusyChange?.(false)
      onCreated(a)
    } catch (e) {
      onSubmitFinished?.(false)
      if (e instanceof ApiError && Object.keys(e.fields).length > 0) setFieldErrors(e.fields)
      else toast.error(errorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-[13px] font-medium text-mist-700">平台</div>
        {fixedPlatform ? (
          <div className="flex items-center gap-3 rounded-xl border border-mist-200 bg-mist-50/60 p-3.5">
            <PlatformMark platform={platform} size="lg" />
            <div>
              <div className="text-sm font-semibold text-mist-900">{platformLabel[platform]}</div>
              <div className="text-xs text-mist-500">账号将添加到当前工作区</div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['wechat_mp', 'xhs', 'toutiao'] as Platform[]).map((p) => (
              <button key={p} type="button" onClick={() => pick(p)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 text-left transition',
                  platform === p ? 'border-ink-400 bg-ink-50/60 ring-3 ring-ink-100' : 'border-mist-200 hover:border-mist-300')}>
                <PlatformMark platform={p} size="lg" />
                <div>
                  <div className="text-sm font-semibold text-mist-900">{platformLabel[p]}</div>
                  <div className="text-xs text-mist-500">{p === 'wechat_mp' ? '官方接口写入草稿箱' : '人工发布，无需接口凭证'}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        {fieldErrors.platform && <p role="alert" className="mt-1.5 text-xs text-danger">{fieldErrors.platform}</p>}
      </div>
      <Field label="账号名称" hint="只用于区分账号，可以和平台上的名称不同" error={fieldErrors.name}>
        <Input value={name} onChange={(e) => { setName(e.target.value); setFieldErrors((current) => ({ ...current, name: undefined })) }} placeholder={platform === 'wechat_mp' ? '例如：周末读书会' : platform === 'toutiao' ? '例如：小周的阅读笔记' : '例如：小周的生活笔记'} />
      </Field>
      <div>
        <div className="mb-2 text-[13px] font-medium text-mist-700">账号类型</div>
        <div className="space-y-2">
          {matrix[platform].map((f) => (
            <label key={f.value} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 transition',
              format === f.value ? 'border-ink-400 bg-ink-50/50' : 'border-mist-200 hover:border-mist-300')}>
              <input type="radio" className="accent-ink-600" checked={format === f.value} onChange={() => { setFormat(f.value); setFieldErrors((current) => ({ ...current, content_format: undefined })) }} />
              <span className="flex-1">
                <span className="text-sm font-medium text-mist-800">{f.label}</span>
                <span className="ml-2 text-xs text-mist-500">{f.desc}</span>
              </span>
            </label>
          ))}
        </div>
        {fieldErrors.content_format && <p role="alert" className="mt-1.5 text-xs text-danger">{fieldErrors.content_format}</p>}
        <p className="mt-2 text-xs text-mist-400">类型决定这个账号的编辑器、检查和输出方式；创建后可在设置页同平台内更换，已有作品保持原类型。</p>
      </div>
      <Field label="类型补充说明（可选）" hint="最多 200 字。只帮助 AI 理解定位，不改变创作流程。">
        <Textarea rows={2} value={typeNote} maxLength={200} onChange={(e) => setTypeNote(e.target.value)}
          placeholder={format === 'comic' ? '例如：四格职场日常，主角是入职三年的产品助理' : '例如：面向转型工程师，多写可复现的实操步骤'} />
      </Field>
      <Button variant="primary" onClick={submit} loading={busy} disabled={busy} className="w-full">{submitText}</Button>
    </div>
  )
}

export function credTone(c?: CredState) {
  switch (c?.state) {
    case 'ok': return { tone: 'green' as const, label: '正常' }
    case 'error': return { tone: 'red' as const, label: '异常' }
    case 'unchecked': return { tone: 'gamboge' as const, label: '未检测' }
    default: return { tone: 'gray' as const, label: '未配置' }
  }
}

// ST-03：凭证检测失败时的可执行动作。按错误码分流，避免用户只看到一个 40164 不知道下一步。
function CredentialFailureActions({ message }: { message: string }) {
  const { data } = useSystemInfo()
  const ipWhitelist = /40164|ip/i.test(message) && /白名单|whitelist|not in whitelist/i.test(message)
  const invalidSecret = /40001|40125|invalid appsecret|不合法的/i.test(message)
  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="text-ink-700/80">
        {ipWhitelist ? '通常是出口 IP 不在白名单：把下面这个 IP 加到公众号后台「设置与开发 → 基本配置 → IP 白名单」后重新检测。'
          : invalidSecret ? '通常是 AppSecret 不正确：到公众号后台「设置与开发 → 基本配置」重置并重新粘贴。'
            : '按提示修正后点「重新检测」；改完凭证记得再点一次「保存并检测」。'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {ipWhitelist && data?.egress_ip && <Button type="button" size="sm" variant="outline" icon={<Copy className="size-3.5" />} onClick={() => { void copyText(data.egress_ip).then(() => toast.success('已复制出口 IP')) }}>复制出口 IP（{data.egress_ip}）</Button>}
        <a href="https://mp.weixin.qq.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-600 underline"><Globe2 className="size-3.5" />打开公众号后台</a>
      </div>
    </div>
  )
}

export function EgressIP() {
  const { data } = useSystemInfo()
  return (
    <Notice tone="ink" icon={<Globe2 className="size-4" />}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>服务器出口 IP：</span>
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12.5px] text-ink-800">{data?.egress_ip ?? '…'}</code>
        {data && !data.dev && (
          <button className="inline-flex cursor-pointer items-center gap-1 text-xs text-ink-600 hover:underline" onClick={() => copyText(data.egress_ip).then(() => toast.success('已复制'))}>
            <Copy className="size-3" />复制
          </button>
        )}
      </div>
      <div className="mt-1 text-xs text-ink-700/80">请在公众号后台「设置与开发 → 基本配置 → IP 白名单」中加入这个 IP，否则接口会返回 40164。</div>
    </Notice>
  )
}

export function CredentialPanel({ account, onChanged }: { account: Account; onChanged?: () => void }) {
  const c = account.credential
  const [appId, setAppId] = useState(c?.app_id ?? '')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'link' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const save = async () => {
    setBusy('save')
    try {
      await put(`/accounts/${account.id}/wechat-credential`, { app_id: appId.trim(), app_secret: secret.trim() })
      setSecret('')
      toast.success('凭证已加密保存')
      onChanged?.()
      await test()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    try {
      const r = await post<{ ok: boolean; message: string; datacube_state?: string }>(`/accounts/${account.id}/wechat-credential/test`)
      const cube = r.datacube_state === 'ok' ? '数据统计接口可用，复盘页可以同步文章数据。'
        : r.datacube_state === 'no_permission' ? '数据统计接口不可用（通常需要微信认证），复盘数据请用截图识别或手动录入。' : ''
      setResult({ ok: r.ok, message: cube ? `${r.message}；${cube}` : r.message })
      onChanged?.()
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) })
      onChanged?.()
    } finally {
      setBusy(null)
    }
  }
  // DEV-U102（12 文档）：发布链路预检——上传一张测试素材验证完整链路，不写草稿。
  const linkCheck = async () => {
    setBusy('link')
    try {
      const r = await post<{ ok: boolean; message: string }>(`/accounts/${account.id}/wechat/link-check`)
      setResult(r)
      onChanged?.()
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) })
      onChanged?.()
    } finally {
      setBusy(null)
    }
  }
  const tone = credTone(c)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[13px] text-mist-600">
        凭证状态 <Badge tone={tone.tone}>{tone.label}</Badge>
        {c?.last_check_at && <span className="text-xs text-mist-400">最近检测 {fmtTime(c.last_check_at)}</span>}
      </div>
      <EgressIP />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="AppID">
          <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="wx 开头" className="font-mono" />
        </Field>
        <Field label="AppSecret" hint={c?.secret_mask ? `已保存：${c.secret_mask}` : '保存后只显示脱敏值'}>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={c?.secret_mask ? '留空则不修改' : ''} className="font-mono" autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!appId.trim() || !secret.trim()} icon={<ShieldCheck className="size-4" />}>保存并检测</Button>
        {c && c.state !== 'not_configured' && <Button onClick={test} loading={busy === 'test'}>重新检测</Button>}
        {c && c.state !== 'not_configured' && (
          <Button onClick={linkCheck} loading={busy === 'link'} title="上传一张测试素材，验证 access_token 到素材上传的完整链路（不写草稿）">链路预检</Button>
        )}
      </div>
      {(result || c?.last_result) && (
        <Notice tone={(result?.ok ?? c?.state === 'ok') ? 'ink' : 'red'} icon={(result?.ok ?? c?.state === 'ok') ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}>
          {result?.message ?? c?.last_result}
          {/* ST-03：检测失败时不能只给一行错误码，要给出「复制出口 IP / 去公众号后台」这类可执行动作。 */}
          {!(result?.ok ?? c?.state === 'ok') && <CredentialFailureActions message={result?.message ?? c?.last_result ?? ''} />}
        </Notice>
      )}
      <p className="text-xs leading-relaxed text-mist-400">AppSecret 使用 AES-256-GCM 加密后保存在数据库，不会出现在日志和页面中。修改凭证需要再次输入登录密码，并记录在操作日志里。</p>
    </div>
  )
}
