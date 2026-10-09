import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cpu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AccountCreateForm, CredentialPanel } from '@/components/account-forms'
import { Badge, Button, cn, Field, Input, Notice, Textarea } from '@/components/ui'
import { errorMessage, get, post, put, setCsrf } from '@/lib/api'
import { runeLen } from '@/lib/format'
import type { Account, Me, Profile, Provider } from '@/lib/types'
import { AuthFrame } from './Login'

type Step = 'password' | 'account' | 'credential' | 'profile' | 'samples' | 'model'

const steps: { id: Step; label: string }[] = [
  { id: 'password', label: '设置密码' },
  { id: 'account', label: '添加账号' },
  { id: 'credential', label: '公众号凭证' },
  { id: 'profile', label: '定位档案' },
  { id: 'samples', label: '风格样本' },
  { id: 'model', label: '模型' },
]

function PasswordStep({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const short = pw.length > 0 && runeLen(pw) < 12
  const mismatch = pw2.length > 0 && pw !== pw2
  const submit = async () => {
    setBusy(true)
    try {
      await post('/auth/setup', { username: username.trim(), password: pw })
      const me = await get<Me>('/auth/me')
      setCsrf(me.csrf_token)
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Field label="用户名"><Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="登录密码" error={short ? '密码至少需要 12 位' : undefined} hint="至少 12 位。系统只有你一个用户，忘记密码需要在服务器上执行重置命令。">
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" invalid={short} />
      </Field>
      <Field label="再输入一次" error={mismatch ? '两次输入不一致' : undefined}>
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" invalid={mismatch} />
      </Field>
      <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!username.trim() || runeLen(pw) < 12 || pw !== pw2} onClick={submit}>
        创建并继续
      </Button>
    </div>
  )
}

function ProfileStep({ account, onDone }: { account: Account; onDone: () => void }) {
  const [tags, setTags] = useState('')
  const [audience, setAudience] = useState('')
  const [tone, setTone] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const p = await get<Profile>(`/accounts/${account.id}/profile`)
      await put(`/accounts/${account.id}/profile`, {
        ...p,
        positioning_tags: tags.split(/[,，、\s]+/).filter(Boolean),
        target_audience: audience,
        persona_tone: tone,
      })
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-mist-500">AI 每次生成都会参考这份档案。先填最少的三项，之后可以在「账号档案」里补充禁用词和文章默认设置。</p>
      <Field label="定位标签" hint="用逗号或空格分隔，例如：职场 效率 新人成长"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      <Field label="目标读者"><Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="例如：工作 1–3 年、想提升效率的年轻人" /></Field>
      <Field label="人设与语气"><Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="例如：真诚、克制，像朋友聊天，不说教" /></Field>
      <Button variant="primary" className="w-full" loading={busy} onClick={submit} disabled={!tags.trim() && !audience.trim() && !tone.trim()}>保存并继续</Button>
    </div>
  )
}

function SamplesStep({ account, onDone }: { account: Account; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    try {
      await post(`/accounts/${account.id}/style-samples`, { title, content_md: content })
      setCount((c) => c + 1)
      setTitle('')
      setContent('')
      toast.success('已添加一篇风格样本')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-mist-500">粘贴 3 篇以上你过去写的作品，AI 会模仿其中的语气和结构（不复用其中的事实）。也可以跳过，之后在账号档案里补充。</p>
      <div className="flex items-center gap-2 text-[13px] text-mist-600">已添加 <Badge tone={count >= 3 ? 'green' : 'gamboge'}>{count} 篇</Badge><span className="text-xs text-mist-400">建议 3–10 篇</span></div>
      <Field label="标题"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="正文" counter={{ value: runeLen(content), max: 20000 }}>
        <Textarea rows={7} value={content} onChange={(e) => setContent(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" loading={busy} disabled={!title.trim() || !content.trim()} onClick={add}>添加这一篇</Button>
        <Button variant="primary" className="flex-1" onClick={onDone}>{count > 0 ? '完成，继续' : '跳过'}</Button>
      </div>
    </div>
  )
}

function ModelStep({ onDone }: { onDone: () => void }) {
  const { data } = useQuery({ queryKey: ['providers'], queryFn: () => get<Provider[]>('/model-providers') })
  return (
    <div className="space-y-4">
      {data && data.length > 0 ? (
        <Notice tone="ink" icon={<Cpu className="size-4" />}>
          已配置 {data.length} 个模型供应商：{data.map((p) => p.name).join('、')}。可以随时在「设置 → 模型配置」中修改。
        </Notice>
      ) : (
        <Notice tone="gamboge">还没有配置模型。AI 按钮会暂时不可用，写作、检查和推送不受影响。</Notice>
      )}
      <p className="text-[13px] leading-relaxed text-mist-500">请只添加服务条款明确「API 数据不用于训练」的模型供应商。</p>
      <div className="flex gap-2">
        <Link to="/settings/models" className="flex-1"><Button className="w-full">去配置模型</Button></Link>
        <Button variant="primary" className="flex-1" onClick={onDone}>进入工作台</Button>
      </div>
    </div>
  )
}

export default function Setup() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ needs_setup: boolean }>('/auth/status') })
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), retry: false, enabled: status.data?.needs_setup === false })
  const [step, setStep] = useState<Step>('password')
  const [account, setAccount] = useState<Account | null>(null)

  useEffect(() => {
    if (status.data?.needs_setup === false) {
      if (me.isError) nav('/login', { replace: true })
      else if (me.data) {
        setCsrf(me.data.csrf_token)
        setStep((s) => (s === 'password' ? 'account' : s))
      }
    }
  }, [status.data, me.data, me.isError, nav])

  const finish = async () => {
    await qc.invalidateQueries()
    nav(account ? `/a/${account.id}` : '/', { replace: true })
  }
  const visible = steps.filter((s) => s.id !== 'credential' || !account || account.platform === 'wechat_mp')
  const idx = visible.findIndex((s) => s.id === step)

  return (
    <AuthFrame aside={
      <ol className="mt-10 space-y-3">
        {visible.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3 text-sm">
            <span className={cn('flex size-6 items-center justify-center rounded-full text-xs font-bold',
              i < idx ? 'bg-ink-600 text-white' : i === idx ? 'bg-gamboge-400 text-mist-900' : 'bg-mist-200 text-mist-500')}>
              {i < idx ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={i === idx ? 'font-semibold text-mist-900' : 'text-mist-500'}>{s.label}</span>
          </li>
        ))}
      </ol>
    }>
      <div className="w-full max-w-[440px] animate-fade-in" key={step}>
        <div className="mb-1 text-xs font-medium text-ink-600">首次使用 · 第 {idx + 1} / {visible.length} 步</div>
        <h1 className="mb-6 font-display text-[26px] font-bold text-mist-900">
          {{ password: '设置登录密码', account: '添加第一个平台账号', credential: '连接公众号', profile: '账号定位档案', samples: '风格样本', model: '模型配置' }[step]}
        </h1>
        {step === 'password' && <PasswordStep onDone={() => { qc.invalidateQueries(); setStep('account') }} />}
        {step === 'account' && (
          <AccountCreateForm submitText="添加并继续" onCreated={(a) => { setAccount(a); qc.invalidateQueries({ queryKey: ['accounts'] }); setStep(a.platform === 'wechat_mp' ? 'credential' : 'profile') }} />
        )}
        {step === 'credential' && account && (
          <div className="space-y-4">
            <CredentialPanel account={account} onChanged={async () => setAccount(await get<Account>(`/accounts/${account.id}`))} />
            <div className="flex justify-between border-t border-mist-100 pt-4">
              <Button variant="ghost" onClick={() => setStep('profile')}>稍后配置</Button>
              <Button variant="primary" onClick={() => setStep('profile')} disabled={account.credential?.state !== 'ok'}>继续</Button>
            </div>
            <p className="text-xs text-mist-400">稍后配置时可以正常创作，只是暂时不能写入公众号草稿箱。</p>
          </div>
        )}
        {step === 'profile' && account && <ProfileStep account={account} onDone={() => setStep('samples')} />}
        {step === 'samples' && account && <SamplesStep account={account} onDone={() => setStep('model')} />}
        {step === 'model' && <ModelStep onDone={finish} />}
        {(step === 'profile' || step === 'samples') && !account && <Button onClick={() => setStep('account')}>先添加账号</Button>}
      </div>
    </AuthFrame>
  )
}
