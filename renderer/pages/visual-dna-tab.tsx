import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Textarea } from '@/components/ui'
import { ApiError, errorMessage, get, post, put } from '@/lib/api'
import { assetUrl } from '@/lib/api-base'
import { useCanWrite, useMe } from '@/lib/session'
import type { Account, AccountLibraryAsset, CXVisualDNAHistoryPage, CXVisualDNATokens, CXVisualDNAVersion } from '@/lib/types'
import { useCustomTheme } from '@/lib/v3'

const newTokens = (): CXVisualDNATokens => ({
  schema: 'ops.visual-dna/v1',
  palette: { primary: '#2F5D62', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
  font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
  watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
  card_template_default: 'editorial', card_ratio_default: '3:4', end_copy: '',
})

const cloneTokens = (tokens: CXVisualDNATokens): CXVisualDNATokens => structuredClone(tokens)
const fontCss = (font: CXVisualDNATokens['font_stack']) => ({
  'system-sans': 'system-ui, sans-serif',
  'system-serif': 'ui-serif, Georgia, serif',
  'system-rounded': 'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif',
  'system-mono': 'ui-monospace, "SFMono-Regular", Consolas, monospace',
}[font])
const fontLabel = (font: CXVisualDNATokens['font_stack']) => ({
  'system-sans': '系统无衬线', 'system-serif': '系统衬线', 'system-rounded': '系统圆体', 'system-mono': '系统等宽',
}[font])

function DnaPreview({ title, tokens, logo }: { title: string; tokens: CXVisualDNATokens | null; logo?: AccountLibraryAsset }) {
  if (!tokens) return <div className="rounded-lg border border-dashed border-mist-200 p-4 text-sm text-mist-500">尚未保存视觉 DNA</div>
  const watermark = tokens.watermark.text.trim()
  return (
    <div className="overflow-hidden rounded-lg border border-mist-200" data-testid={title === '当前已保存 DNA' ? 'visual-dna-current-preview' : 'visual-dna-draft-preview'}>
      <div className="border-b border-mist-100 bg-mist-50 px-3 py-2 text-xs font-medium text-mist-600">{title}</div>
      <div className="relative min-h-36 p-4" style={{ backgroundColor: tokens.palette.background, color: tokens.palette.text, fontFamily: fontCss(tokens.font_stack), borderRadius: tokens.radius, padding: `${16 * Number(tokens.spacing_scale)}px` }}>
        <div className="mb-2 text-[11px]" style={{ color: tokens.palette.muted }}>系统字体：{fontLabel(tokens.font_stack)} · {fontCss(tokens.font_stack)}</div>
        <h4 className="mb-2 font-semibold" style={{ color: tokens.palette.primary }}>把内容讲清楚，再讲漂亮</h4>
        <p className="text-sm leading-relaxed">用清楚的层次承载观点，让读者更容易读完这一段。</p>
        <p className="mt-2 text-xs" style={{ color: tokens.palette.secondary }}>视觉卡片预览 · {tokens.card_template_default} · {tokens.card_ratio_default}</p>
        {tokens.logo_asset_id && (logo
          ? <img src={assetUrl(logo.url)} alt={logo.alt_text || '账号 Logo'} className="mt-2 size-10 rounded object-contain" />
          : <span className="mt-2 inline-block text-xs text-mist-500">Logo 资产：{tokens.logo_asset_id}</span>)}
        {watermark && <span className={`absolute bottom-2 text-[10px] ${tokens.watermark.position === 'bottom-left' ? 'left-3' : 'right-3'}`} style={{ opacity: Number(tokens.watermark.opacity), color: tokens.palette.muted }}>{watermark}</span>}
      </div>
    </div>
  )
}

export default function VisualDNATab({ account }: { account: Account }) {
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  const canWrite = useCanWrite()
  const isOwner = canWrite && me?.role === 'owner'
  const canManage = isOwner && account.status === 'active'
  const path = `/accounts/${account.id}/visual-dna`
  const currentKey = ['cx-visual-dna', account.id]
  const currentQuery = useQuery({ queryKey: currentKey, queryFn: () => get<CXVisualDNAVersion>(path) })
  const history = useInfiniteQuery({
    queryKey: ['cx-visual-dna-history', account.id],
    queryFn: ({ pageParam }) => get<CXVisualDNAHistoryPage>(`${path}/versions?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const assets = useQuery({
    queryKey: ['cx-visual-dna-assets', account.id],
    queryFn: () => get<AccountLibraryAsset[]>(`/assets?scope=account&account_id=${account.id}`),
  })
  const customTheme = useCustomTheme(account.id)
  const [draft, setDraft] = useState<CXVisualDNATokens | null>(null)
  const [baseVersion, setBaseVersion] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (draft || !currentQuery.data) return
    setDraft(cloneTokens(currentQuery.data.tokens ?? newTokens()))
    setBaseVersion(currentQuery.data.version)
  }, [currentQuery.data, draft])

  const current = currentQuery.data
  const currentTokens = current?.tokens ?? null
  const update = (change: (value: CXVisualDNATokens) => CXVisualDNATokens) => {
    setDraft((value) => value ? change(value) : value)
    setDirty(true)
    setNotice('')
  }

  const importTheme = () => {
    if (!canManage || !customTheme.data || !draft || busy) return
    const imported = { ...draft, palette: { ...draft.palette, primary: customTheme.data.primary_color.toUpperCase() } }
    setDraft(imported)
    setDirty(true)
    void save(imported, '旧自定义主题的主色已导入并保存为视觉 DNA 新版本；字号、行距、标题和引用样式未映射，旧自定义主题继续保留。')
  }

  const save = async (tokens = draft, successMessage?: string) => {
    if (!canManage || !tokens || baseVersion === null || busy) return
    setBusy(true)
    setNotice('')
    try {
      const result = await put<{ version: number; tokens_hash: string }>(path, { base_version: baseVersion, tokens })
      setBaseVersion(result.version)
      setDirty(false)
      setConflict(false)
      queryClient.setQueryData<CXVisualDNAVersion>(currentKey, { version: result.version, tokens: cloneTokens(tokens), tokens_hash: result.tokens_hash })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentKey }),
        queryClient.invalidateQueries({ queryKey: ['cx-visual-dna-history', account.id] }),
      ])
      setNotice(successMessage ? `${successMessage}（v${result.version}）` : `已保存视觉 DNA v${result.version}。`)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setConflict(true)
        setNotice('其他窗口已保存新版本。你的本地编辑仍保留；请比较当前与本地预览后，再选择以最新版本为基础继续保存。')
        void queryClient.invalidateQueries({ queryKey: currentKey })
        void queryClient.invalidateQueries({ queryKey: ['cx-visual-dna-history', account.id] })
      } else setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const rollback = async (item: CXVisualDNAVersion) => {
    if (!canManage || baseVersion === null || busy) return
    setBusy(true)
    setNotice('')
    try {
      const result = await post<{ version: number; tokens_hash: string }>(`${path}/rollback`, { base_version: baseVersion, target_version: item.version })
      if (item.tokens) setDraft(cloneTokens(item.tokens))
      setBaseVersion(result.version)
      setDirty(false)
      setConflict(false)
      queryClient.setQueryData<CXVisualDNAVersion>(currentKey, { version: result.version, tokens: item.tokens, tokens_hash: result.tokens_hash })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentKey }),
        queryClient.invalidateQueries({ queryKey: ['cx-visual-dna-history', account.id] }),
      ])
      setNotice(`已将 v${item.version} 复制为新版本 v${result.version}。`)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setConflict(true)
        setNotice('其他窗口已保存新版本。历史回滚未覆盖本地内容；请读取最新版本并确认后重试。')
        void queryClient.invalidateQueries({ queryKey: currentKey })
      } else setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const adoptLatestBase = () => {
    if (current) {
      setBaseVersion(current.version)
      setConflict(false)
      setDirty(true)
      setNotice(`本地编辑仍保留，下一次保存将以当前 v${current.version} 为 base_version。`)
    }
  }

  const pages = history.data?.pages ?? []
  const versions = pages.flatMap((page) => page.items)
  const lockedReason = account.status !== 'active' ? '账号已停用，不能修改视觉 DNA' : !isOwner ? '只有工作区所有者可以修改' : ''
  const logoMissing = !!draft?.logo_asset_id && !assets.data?.some((asset) => asset.id === draft.logo_asset_id)

  if (!draft || currentQuery.isLoading) return <div className="rounded-xl border border-mist-200 bg-white p-5 text-sm text-mist-500">正在读取账号视觉 DNA…</div>

  return (
    <div className="space-y-4" data-testid="visual-dna-tab">
      <Card>
        <CardHeader title="账号视觉 DNA" desc="按账号保存版本化的配色、字体和组图默认值。这里只改令牌，不覆盖旧自定义主题、作者样式或已完成产物。" />
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={current?.version ? 'green' : 'gray'}>{current?.version ? `当前版本 v${current.version}` : '当前版本 v0 · 尚未保存'}</Badge>
            {current?.tokens_hash && <span className="break-all font-mono text-xs text-mist-500">SHA-256 {current.tokens_hash}</span>}
          </div>
          {account.status !== 'active' && <Notice tone="red">账号已停用，视觉 DNA 仍可查看，不能保存或回滚。</Notice>}
          {!isOwner && <Notice>工作区观察者和编辑者可以查看视觉 DNA，只有工作区所有者可以保存或回滚。</Notice>}
          <div className="grid gap-3 lg:grid-cols-2">
            <DnaPreview title="当前已保存 DNA" tokens={currentTokens} logo={assets.data?.find((asset) => asset.id === currentTokens?.logo_asset_id)} />
            <DnaPreview title="本地编辑预览" tokens={draft} logo={assets.data?.find((asset) => asset.id === draft.logo_asset_id)} />
          </div>
          {customTheme.data && (
            <div className="rounded-lg border border-mist-200 p-3" data-testid="visual-dna-custom-theme">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm"><span className="size-5 rounded border border-mist-200" style={{ backgroundColor: customTheme.data.primary_color }} />
                  <span>旧自定义主题仍保留</span><span className="font-mono text-xs text-mist-500">{customTheme.data.primary_color}</span></div>
                <Button variant="secondary" size="sm" disabled={!canManage || busy} title={lockedReason || undefined} onClick={importTheme}>从当前自定义主题导入</Button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-mist-500">导入只把主色放入 DNA 草稿。字号、行距、段距、标题和引用样式不能映射，会继续保留在旧主题中；点击保存前不会写入。</p>
            </div>
          )}
          {notice && <Notice tone={conflict ? 'gamboge' : 'gray'}>{notice}</Notice>}
          {conflict && <Button variant="secondary" size="sm" onClick={adoptLatestBase} disabled={!current || currentQuery.isFetching}>保留本地编辑并以 v{current?.version ?? '…'} 为基础继续</Button>}

          <div className="grid gap-4 md:grid-cols-2">
            {(['primary', 'secondary', 'background', 'text', 'muted'] as const).map((key) => (
              <Field key={key} label={{ primary: '主色', secondary: '辅色', background: '背景色', text: '正文色', muted: '辅助文字色' }[key]}>
                <div className="flex gap-2"><Input aria-label={`${{ primary: '主色', secondary: '辅色', background: '背景色', text: '正文色', muted: '辅助文字色' }[key]}颜色`} type="color" className="w-14 px-1" value={draft.palette[key].toLowerCase()} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, palette: { ...value.palette, [key]: event.target.value.toUpperCase() } }))} />
                  <Input aria-label={`${{ primary: '主色', secondary: '辅色', background: '背景色', text: '正文色', muted: '辅助文字色' }[key]}十六进制`} value={draft.palette[key]} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, palette: { ...value.palette, [key]: event.target.value.toUpperCase() } }))} /></div>
              </Field>
            ))}
            <Field label="系统字体族" hint={`界面使用的回退栈：${fontCss(draft.font_stack)}`}>
              <Select aria-label="系统字体族" value={draft.font_stack} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, font_stack: event.target.value as CXVisualDNATokens['font_stack'] }))}>
                <option value="system-sans">系统无衬线</option><option value="system-serif">系统衬线</option><option value="system-rounded">系统圆体</option><option value="system-mono">系统等宽</option>
              </Select>
            </Field>
            <Field label="卡片圆角" hint="0–32 的整数像素">
              <Input aria-label="卡片圆角" type="number" min={0} max={32} step={1} value={draft.radius} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, radius: Number(event.target.value) }))} />
            </Field>
            <Field label="间距比例" hint="0.80–1.40，保留两位小数">
              <Input aria-label="间距比例" type="number" min={0.8} max={1.4} step={0.01} value={draft.spacing_scale} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, spacing_scale: Number(event.target.value).toFixed(2) }))} />
            </Field>
            <Field label="Logo（账号级图片）" hint={logoMissing ? '当前版本引用的图片已不在可用列表中；保存前请选择仍可用的账号级图片或清空。' : '只显示当前工作区、当前账号的账号级图片。没有账号级图片时留空。'}>
              <Select aria-label="Logo 账号级图片" value={draft.logo_asset_id ?? ''} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, logo_asset_id: event.target.value || null }))}>
                <option value="">不设置 Logo</option>
                {(assets.data ?? []).map((asset) => <option key={asset.id} value={asset.id}>{asset.alt_text || asset.id} · {asset.width}×{asset.height}</option>)}
              </Select>
              {!assets.data?.length && <p className="mt-1 text-xs text-mist-500">暂无账号级图片；此页不新增上传入口。</p>}
            </Field>
            <Field label="水印文字" hint="最多 40 个字符">
              <Input aria-label="水印文字" maxLength={40} value={draft.watermark.text} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, watermark: { ...value.watermark, text: event.target.value } }))} />
            </Field>
            <Field label="水印位置">
              <Select aria-label="水印位置" value={draft.watermark.position} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, watermark: { ...value.watermark, position: event.target.value as CXVisualDNATokens['watermark']['position'] } }))}>
                <option value="bottom-left">左下</option><option value="bottom-right">右下</option>
              </Select>
            </Field>
            <Field label="水印透明度" hint="0.00–1.00">
              <Input aria-label="水印透明度" type="number" min={0} max={1} step={0.01} value={draft.watermark.opacity} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, watermark: { ...value.watermark, opacity: Number(event.target.value).toFixed(2) } }))} />
            </Field>
            <Field label="默认卡片模板">
              <Select aria-label="默认卡片模板" value={draft.card_template_default} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, card_template_default: event.target.value as CXVisualDNATokens['card_template_default'] }))}>
                <option value="editorial">Editorial</option><option value="swiss">Swiss</option>
              </Select>
            </Field>
            <Field label="默认卡片比例">
              <Select aria-label="默认卡片比例" value={draft.card_ratio_default} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, card_ratio_default: event.target.value as CXVisualDNATokens['card_ratio_default'] }))}>
                <option value="1:1">1:1</option><option value="3:4">3:4</option><option value="9:16">9:16</option>
              </Select>
            </Field>
            <Field label="结尾文案" hint="最多 80 个字符">
              <Textarea aria-label="结尾文案" rows={2} maxLength={80} value={draft.end_copy} disabled={!canManage || busy} title={lockedReason || undefined} onChange={(event) => update((value) => ({ ...value, end_copy: event.target.value }))} />
            </Field>
          </div>
          {logoMissing && <Notice tone="gamboge">Logo 当前不可用。历史令牌保持原样；请在本地草稿中清空或选择当前账号级图片后再保存。</Notice>}
          <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!canManage || !dirty || conflict || logoMissing} title={lockedReason || undefined} onClick={() => void save()}>保存为新版本</Button></div>
        </div>
      </Card>

      <Card>
        <CardHeader title="视觉 DNA 历史" desc="历史令牌保持完整；回滚会复制所选版本并创建一个新版本。" />
        {history.isLoading ? <div className="p-5 text-sm text-mist-500">正在读取历史版本…</div> : versions.length === 0 ? <div className="p-5 text-sm text-mist-500">尚无历史版本。</div> : (
          <ol className="divide-y divide-mist-100" data-testid="visual-dna-history">
            {versions.map((item) => (
              <li key={item.version} data-testid={`visual-dna-version-${item.version}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div><div className="text-sm font-medium text-mist-800">v{item.version}{item.version === current?.version && <Badge className="ml-2" tone="green">当前</Badge>}</div>
                  <div className="mt-1 font-mono text-xs text-mist-500">{item.tokens_hash}</div><div className="mt-1 text-xs text-mist-500">{item.created_at ? new Date(item.created_at).toLocaleString() : ''}</div></div>
                {canManage && item.version !== current?.version && <Button variant="secondary" size="sm" disabled={busy || !item.tokens} title={lockedReason || undefined} onClick={() => void rollback(item)}>回滚为新版本</Button>}
              </li>
            ))}
          </ol>
        )}
        {history.hasNextPage && <div className="flex justify-center border-t border-mist-100 p-3"><Button variant="ghost" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>加载更早版本</Button></div>}
      </Card>
    </div>
  )
}
