import { toPng } from 'html-to-image'
import { get, rawRequest } from '@/lib/api'
import type { AccountLibraryAsset, Asset, CXVisualDNATokens, Work } from '@/lib/types'

export type CXVisualCard = {
  card_id: string
  type: 'cover' | 'point' | 'quote' | 'compare' | 'end'
  section_ids: string[]
  headline: string
  body: string | { left: string; right: string }
  asset_ids: string[]
  source_refs: string[]
}

export type CXVisualCardPreview = {
  basis_revision: number
  params_hash: string
  template: 'editorial' | 'swiss'
  ratio: '1:1' | '3:4' | '9:16'
  dna_version: number | null
  cards: CXVisualCard[]
}

export type RenderedCXVisualCard = {
  name: string
  dataUrl: string
  width: 1080
  height: number
  overflow: string[]
}

const cardDimensions: Record<CXVisualCardPreview['ratio'], { width: 1080; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
  '9:16': { width: 1080, height: 1920 },
}

const fontFamilies: Record<CXVisualDNATokens['font_stack'], string> = {
  'system-sans': 'system-ui, sans-serif',
  'system-serif': 'ui-serif, Georgia, serif',
  'system-rounded': 'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif',
  'system-mono': 'ui-monospace, "SFMono-Regular", Consolas, monospace',
}

const defaultTokens: CXVisualDNATokens = {
  schema: 'ops.visual-dna/v1',
  palette: { primary: '#2F5D62', secondary: '#1565C0', background: '#FFFFFF', text: '#212121', muted: '#555555' },
  font_stack: 'system-sans', radius: 12, spacing_scale: '1.00', logo_asset_id: null,
  watermark: { text: '', position: 'bottom-right', opacity: '0.00' },
  card_template_default: 'editorial', card_ratio_default: '3:4', end_copy: '',
}

function px(value: number) { return `${value}px` }

function textElement(text: string, className: string) {
  const element = document.createElement('div')
  element.dataset.cxText = className
  element.textContent = text
  element.style.whiteSpace = 'pre-wrap'
  element.style.overflowWrap = 'anywhere'
  element.style.overflow = 'hidden'
  element.style.lineHeight = '1.35'
  return element
}

function appendImage(root: HTMLElement, src: string, alt: string, isCover: boolean) {
  const image = document.createElement('img')
  image.src = src
  image.alt = alt
  image.decoding = 'async'
  image.style.display = 'block'
  image.style.width = '100%'
  image.style.height = px(isCover ? 480 : 240)
  image.style.objectFit = isCover ? 'cover' : 'contain'
  image.style.borderRadius = '16px'
  image.style.backgroundColor = '#F2F4F3'
  root.append(image)
}

function buildSurface(card: CXVisualCard, index: number, preview: CXVisualCardPreview, tokens: CXVisualDNATokens,
  imageURLs: string[], ordinal: number, logoURL?: string) {
  const { width, height } = cardDimensions[preview.ratio]
  const root = document.createElement('article')
  root.dataset.cxCard = card.type
  root.style.cssText = [
    'position:fixed', 'left:-12000px', 'top:0', 'display:flex', 'flex-direction:column', 'justify-content:space-between',
    'box-sizing:border-box', `width:${width}px`, `height:${height}px`, `padding:${Math.round(88 * Number(tokens.spacing_scale))}px`,
    `border-radius:${tokens.radius}px`, `background:${tokens.palette.background}`, `color:${tokens.palette.text}`,
    `font-family:${fontFamilies[tokens.font_stack]}`, 'overflow:hidden',
  ].join(';')
  if (preview.template === 'swiss') {
    root.style.borderTop = `18px solid ${tokens.palette.primary}`
  } else {
    root.style.borderTop = `2px solid ${tokens.palette.primary}`
  }

  const top = document.createElement('div')
  top.style.display = 'flex'
  top.style.flexDirection = 'column'
  top.style.gap = '42px'
  const eyebrow = document.createElement('div')
  eyebrow.textContent = `${String(index + 1).padStart(2, '0')}  /  ${card.type.toUpperCase()}`
  eyebrow.style.cssText = `font-size:24px;letter-spacing:4px;color:${tokens.palette.muted};font-weight:600`
  top.append(eyebrow)

  if (card.type === 'point') {
    const marker = document.createElement('div')
    marker.textContent = String(ordinal).padStart(2, '0')
    marker.style.cssText = `font-size:92px;line-height:1;color:${tokens.palette.secondary};font-weight:700`
    top.append(marker)
  }

  const title = textElement(card.headline, 'headline')
  title.dataset.maxLines = String(card.type === 'cover' ? 3 : 4)
  title.style.cssText += `;color:${tokens.palette.primary};font-weight:${preview.template === 'swiss' ? 800 : 700};letter-spacing:${preview.template === 'swiss' ? '-3px' : '-1px'}`
  top.append(title)
  root.append(top)

  const bodyWrap = document.createElement('div')
  bodyWrap.style.display = 'flex'
  bodyWrap.style.flexDirection = 'column'
  bodyWrap.style.gap = '30px'
  const bodyHeight = Math.round(height * (card.type === 'compare' ? 0.48 : card.type === 'cover' ? 0.32 : 0.43))
  if (typeof card.body === 'string') {
    const body = textElement(card.type === 'quote' ? `“${card.body}”` : card.body, 'body')
    body.style.color = card.type === 'quote' ? tokens.palette.secondary : tokens.palette.text
    body.style.maxHeight = px(bodyHeight)
    bodyWrap.append(body)
  } else {
    const compare = document.createElement('div')
    compare.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:24px;max-height:${bodyHeight}px`
    for (const [label, text] of [['A', card.body.left], ['B', card.body.right]]) {
      const column = document.createElement('div')
      column.style.cssText = `box-sizing:border-box;padding:24px;border:2px solid ${tokens.palette.secondary};border-radius:16px;max-height:${bodyHeight}px`
      const key = document.createElement('div')
      key.textContent = label
      key.style.cssText = `margin-bottom:16px;color:${tokens.palette.secondary};font-size:24px;font-weight:700`
      const body = textElement(text, `compare-${label.toLowerCase()}`)
      body.style.maxHeight = px(bodyHeight - 82)
      body.style.color = tokens.palette.text
      column.append(key, body)
      compare.append(column)
    }
    bodyWrap.append(compare)
  }

  if (imageURLs.length) {
    const images = document.createElement('div')
    images.style.cssText = `display:grid;grid-template-columns:repeat(${Math.min(2, imageURLs.length)},1fr);gap:20px;max-height:${Math.round(height * 0.35)}px;overflow:hidden`
    imageURLs.forEach((src, imageIndex) => appendImage(images, src, `用户选择图片 ${imageIndex + 1}`, card.type === 'cover' && imageIndex === 0))
    bodyWrap.append(images)
  }
  root.append(bodyWrap)

  const footer = document.createElement('div')
  footer.style.cssText = `display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-top:2px solid ${tokens.palette.secondary};padding-top:24px;color:${tokens.palette.muted};font-size:24px;line-height:1.4`
  const source = document.createElement('span')
  source.textContent = card.type === 'end' ? tokens.end_copy : '内容计划 · 已保存来源'
  source.style.flex = '1'
  footer.append(source)
  if (logoURL) {
    const logo = document.createElement('img')
    logo.src = logoURL
    logo.alt = '账号视觉 DNA Logo'
    logo.decoding = 'async'
    logo.style.cssText = 'display:block;width:120px;height:72px;object-fit:contain;object-position:right bottom;flex:none'
    footer.append(logo)
  }
  footer.style.position = 'relative'
  root.style.position = 'fixed'
  if (tokens.watermark.text.trim()) {
    const mark = document.createElement('span')
    mark.textContent = tokens.watermark.text
    mark.dataset.testid = 'visual-card-watermark'
    mark.style.cssText = `position:absolute;bottom:24px;${tokens.watermark.position === 'bottom-left' ? 'left' : 'right'}:88px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${tokens.palette.muted};font-size:22px;line-height:1.2;opacity:${tokens.watermark.opacity};pointer-events:none`
    root.append(mark)
  }
  root.append(footer)

  const textNodes = [...root.querySelectorAll<HTMLElement>('[data-cx-text]')]
  for (const node of textNodes) {
    const initial = node.dataset.cxText?.startsWith('headline') ? 66 : node.dataset.cxText?.startsWith('compare') ? 36 : 42
    node.dataset.baseFontSize = String(initial)
    node.style.fontSize = px(initial)
  }
  return { root, textNodes, width: width as 1080, height, filename: cardFilename(card.type, index, ordinal) }
}

export function cardFilename(type: CXVisualCard['type'], index: number, ordinal = 1) {
  const part = type === 'cover' ? 'cover' : type === 'end' ? 'end' : `${type}-${ordinal}`
  return `${String(index + 1).padStart(2, '0')}-${part}.png`
}

export function visualCardDimensions(ratio: CXVisualCardPreview['ratio']) {
  return cardDimensions[ratio]
}

function imageDecoded(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败，组图预览已停止。'))
    image.src = url
  })
}

async function assetObjectURL(id: string, work: Work, logoAssets: AccountLibraryAsset[]) {
  const workAsset: Asset | undefined = work.assets.find((asset) => asset.id.toLowerCase() === id.toLowerCase())
  const logoAsset = logoAssets.find((asset) => asset.id.toLowerCase() === id.toLowerCase())
  const asset = workAsset ?? logoAsset
  if (!asset || !asset.mime.startsWith('image/') || asset.bytes < 1) throw new Error('组图引用的图片不在当前作品或视觉 DNA 账号范围内。')
  const response = await rawRequest('GET', `/assets/${encodeURIComponent(id)}/file`)
  const blob = await response.blob()
  if (blob.size !== asset.bytes) throw new Error('组图图片与来源元数据大小不一致，未生成预览。')
  const localURL = URL.createObjectURL(new Blob([blob], { type: asset.mime }))
  try { await imageDecoded(localURL) } catch (error) { URL.revokeObjectURL(localURL); throw error }
  return localURL
}

async function pngDecoded(url: string, width: number, height: number) {
  const image = await imageDecoded(url)
  if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('组图 PNG 尺寸与选择的比例不一致。')
}

export async function renderCXVisualCards(preview: CXVisualCardPreview, work: Work,
  onProgress?: (done: number, total: number) => void): Promise<RenderedCXVisualCard[]> {
  if (preview.cards.length < 1 || preview.cards.length > 9) throw new Error('组图卡片数量无效，未生成预览。')
  const startedAt = performance.now()
  const checkDeadline = () => {
    if (performance.now() - startedAt > 30_000) throw new Error('组图预览超过 30 秒，已停止本次渲染。')
  }
  await document.fonts.ready
  checkDeadline()

  let tokens = defaultTokens
  if (preview.dna_version !== null) {
    const version = await get<{ version: number; tokens: CXVisualDNATokens | null }>(`/accounts/${work.account_id}/visual-dna/versions/${preview.dna_version}`)
    if (version.version !== preview.dna_version || !version.tokens) throw new Error('已选视觉 DNA 版本不可读，未生成预览。')
    tokens = version.tokens
  }
  let logoAssets: AccountLibraryAsset[] = []
  if (tokens.logo_asset_id) {
    logoAssets = await get<AccountLibraryAsset[]>(`/assets?scope=account&account_id=${encodeURIComponent(work.account_id)}`)
    if (!logoAssets.some((asset) => asset.id.toLowerCase() === tokens.logo_asset_id?.toLowerCase())) {
      throw new Error('视觉 DNA 的 Logo 不在当前账号资产范围内，未生成预览。')
    }
  }

  const rendered: RenderedCXVisualCard[] = []
  const typeOrdinals = new Map<CXVisualCard['type'], number>()
  for (let index = 0; index < preview.cards.length; index++) {
    checkDeadline()
    const card = preview.cards[index]
    const ids = [...new Set(card.asset_ids)]
    const urls: string[] = []
    let logoURL: string | undefined
    let surface: ReturnType<typeof buildSurface> | null = null
    try {
      for (const id of ids) {
        checkDeadline()
        urls.push(await assetObjectURL(id, work, logoAssets))
      }
      if (tokens.logo_asset_id) logoURL = await assetObjectURL(tokens.logo_asset_id, work, logoAssets)
      const { width, height } = visualCardDimensions(preview.ratio)
      const ordinal = (typeOrdinals.get(card.type) ?? 0) + 1
      typeOrdinals.set(card.type, ordinal)
      surface = buildSurface(card, index, preview, tokens, urls, ordinal, logoURL)
      document.body.append(surface.root)
      await Promise.all([...surface.root.querySelectorAll('img')].map((image) => (image as HTMLImageElement).decode()))

      let fits = false
      for (let sizeAttempt = 0; sizeAttempt < 3; sizeAttempt++) {
        checkDeadline()
        for (const node of surface.textNodes) {
          const base = Number(node.dataset.baseFontSize)
          const size = base - sizeAttempt * 4
          node.style.fontSize = px(size)
          if (node.dataset.maxLines) node.style.maxHeight = px(Math.round(size * 1.35 * Number(node.dataset.maxLines)))
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        fits = surface.root.scrollHeight <= surface.root.clientHeight + 1
          && surface.root.scrollWidth <= surface.root.clientWidth + 1
          && surface.textNodes.every((node) => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1)
        if (fits) break
      }

      // html-to-image 会把节点计算样式整体内联进 SVG foreignObject，离屏定位（left:-12000px，
      // 计算样式展开为 inset-inline）会让克隆体落在画布之外，产出"尺寸正确但只有背景色"的空白图。
      // 捕获时把克隆根节点的逻辑 inset 归零（克隆体不挂载文档，不影响页面布局）。
      const dataUrl = await toPng(surface.root, { width, height, pixelRatio: 1, backgroundColor: tokens.palette.background,
        cacheBust: false, style: { position: 'relative', insetInline: '0', insetBlock: '0' } })
      checkDeadline()
      await pngDecoded(dataUrl, width, height)
      rendered.push({ name: surface.filename, dataUrl, width, height, overflow: fits ? [] : ['缩小三档字号后仍有文字超出卡片区域'] })
      onProgress?.(index + 1, preview.cards.length)
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error('组图渲染失败，未生成本次预览。')
    } finally {
      surface?.root.remove()
      for (const url of [...urls, ...(logoURL ? [logoURL] : [])]) URL.revokeObjectURL(url)
    }
  }
  return rendered
}
