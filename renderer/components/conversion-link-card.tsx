import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Link2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Field, Input, Notice, Select } from '@/components/ui'
import { errorMessage, get, post } from '@/lib/api'
import { copyText } from '@/lib/format'
import type { ConversionLink, ConversionPlatform, ConversionSummary, Work } from '@/lib/types'

const platforms: { value: ConversionPlatform; label: string }[] = [
  { value: 'wechat_mp', label: '公众号“阅读原文”' },
  { value: 'site', label: '自有站点' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'x', label: 'X' },
  { value: 'other', label: '其他站点' },
]

// REF41 I7：作品发布页的转化链接卡。只对公众号作品开放外链；
// 小红书/抖音/头条等平台只显示禁止提示，不提供生成入口。
export function ConversionLinkCard({ work, canManage }: { work: Work; canManage: boolean }) {
  const qc = useQueryClient()
  const [platform, setPlatform] = useState<ConversionPlatform>('wechat_mp')
  const [target, setTarget] = useState('')
  const [campaign, setCampaign] = useState('')
  const [copied, setCopied] = useState('')
  const [saving, setSaving] = useState(false)
  const links = useQuery({
    queryKey: ['conversion-links', work.id],
    queryFn: () => get<{ links: ConversionLink[] }>(`/works/${work.id}/conversion-links`),
    enabled: work.platform === 'wechat_mp',
  })

  if (work.platform !== 'wechat_mp') {
    return (
      <Card className="p-5" data-testid="i7-conversion-card">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-mist-700"><Link2 className="size-4" />转化链接</div>
        <div data-testid="i7-conversion-forbidden">
          <Notice tone="gray">
            小红书、抖音、头条等平台默认不生成外链。外链只允许公众号“阅读原文”和自有站点，避免平台规则风险。
          </Notice>
        </div>
      </Card>
    )
  }

  const create = async () => {
    if (!canManage) return
    if (!target.trim()) {
      toast.error('请填写目标 URL')
      return
    }
    setSaving(true)
    try {
      const link = await post<ConversionLink>(`/works/${work.id}/conversion-links`, {
        platform, target_url: target.trim(), campaign: campaign.trim(),
      })
      setTarget('')
      setCampaign('')
      toast.success('转化链接已生成')
      await qc.invalidateQueries({ queryKey: ['conversion-links', work.id] })
      await copy(link)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const copy = async (link: ConversionLink) => {
    await copyText(link.url)
    setCopied(link.id)
    toast.success('推广链接已复制')
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <Card className="p-5" data-testid="i7-conversion-card">
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="size-4 text-mist-500" />
        <span className="text-[13px] font-semibold text-mist-700">转化链接</span>
        <Badge tone="gray">UTM</Badge>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-mist-500">
        为这一期生成唯一的 UTM 链接；外部站点回传注册/付费/留资后，复盘页按作品归因。不会自动发布或群发。
      </p>
      {canManage ? <div className="space-y-3">
        <Field label="投放位置">
          <Select data-testid="i7-conversion-platform" value={platform} onChange={(e) => setPlatform(e.target.value as ConversionPlatform)}>
            {platforms.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="目标 URL" hint="必须是 http(s) 完整地址；小红书/抖音/头条不提供外链">
          <Input data-testid="i7-conversion-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://example.com/article" />
        </Field>
        <Field label="campaign（可选）" hint="留空按作品 ID + 标题生成，≤64 字符">
          <Input value={campaign} onChange={(e) => setCampaign(e.target.value)} maxLength={64} placeholder="w-xxxxxxxx-slug" />
        </Field>
        <Button data-testid="i7-conversion-generate" variant="primary" loading={saving} onClick={create} icon={<Link2 className="size-4" />}>生成并复制</Button>
      </div> : <Notice tone="gray" data-testid="i7-conversion-readonly">当前角色只读：可查看并复制已有链接，生成与修改仅所有者或编辑可见。</Notice>}
      <div className="mt-4 space-y-2">
        {(links.data?.links ?? []).length === 0 ? (
          <p className="text-xs text-mist-400">还没有转化链接。</p>
        ) : (links.data?.links ?? []).map((link) => (
          <div key={link.id} className="rounded-lg border border-mist-100 px-3 py-2">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-[11.5px] text-mist-700" data-testid="i7-conversion-url">{link.url}</code>
              <Badge tone={link.status === 'active' ? 'green' : 'gray'}>{link.status === 'active' ? '启用' : '已禁用'}</Badge>
              <Button size="sm" variant="ghost" data-testid="i7-conversion-copy" onClick={() => copy(link)} icon={copied === link.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
                {copied === link.id ? '已复制' : '复制'}
              </Button>
            </div>
            <div className="mt-1 text-[11px] text-mist-400">utm_campaign: {link.utm_campaign}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// Review 页转化卡：按作品显示注册/付费/留资与转化率；没有事件时明确“未接入回传”。
export function ConversionCard({ accountId }: { accountId: string }) {
  const summary = useQuery({
    queryKey: ['conversions', accountId],
    queryFn: () => get<ConversionSummary>(`/accounts/${accountId}/conversions`),
  })
  const works = summary.data?.works ?? []
  const connected = !!summary.data?.connected
  return (
    <Card className="p-5" data-testid="i7-conversions-card">
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="size-4 text-mist-500" />
        <span className="text-[13px] font-semibold text-mist-700">转化归因</span>
        <Badge tone={connected ? 'green' : 'gray'}>{connected ? '已接入回传' : '未接入回传'}</Badge>
      </div>
      {summary.isLoading ? <div className="text-xs text-mist-400">加载中…</div> : works.length === 0 ? (
        <p className="text-xs text-mist-500">还没有生成转化链接。作品发布页生成后，外部站点回传即可在这里归因。</p>
      ) : (
        <div className="space-y-2">
          {!connected && <p className="text-xs text-mist-500" data-testid="i7-conversion-unconnected">链接已生成，但还没有收到回传；当前显示“未接入回传”。</p>}
          {works.map((w) => (
            <div key={w.work_id + w.platform} className="rounded-lg border border-mist-100 px-3 py-2.5" data-testid="i7-conversion-row">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-mist-800">
                <span className="min-w-0 flex-1 truncate">{w.work_title || '未命名作品'}</span>
                <span className="text-[11px] text-mist-400">{w.platform}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mist-600">
                <span>注册 <b data-testid="i7-conversion-register">{w.register}</b></span>
                <span>付费 <b data-testid="i7-conversion-paid">{w.paid}</b></span>
                <span>留资 <b data-testid="i7-conversion-lead">{w.lead}</b></span>
                <span>转化率 <b data-testid="i7-conversion-rate">{w.conversion_rate == null ? '—' : `${w.conversion_rate.toFixed(2)}%`}</b></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export function ConversionLinkPreview({ link }: { link: ConversionLink }) {
  return <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ink-600 hover:underline"><ExternalLink className="size-3" />预览</a>
}
