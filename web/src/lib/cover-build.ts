import type { CropBox } from '@/lib/types'

// DEV-CX10 / FR-CX-09：多比例封面交付包（cover_images）。
// 预设以平台+像素标识，两种 1:1（383×383 与 1080×1080）不共用尺寸或文件名。
// 坐标沿用 cover_crops；扩展比例（3:4、9:16）按中心裁剪给建议坐标，不回写库；
// 安全区中心 80% 只是设计提醒，不保证平台不裁切。

export interface CoverPreset {
  id: string
  platform: 'wechat_mp' | 'xhs'
  width: number
  height: number
  label: string
}

// 顺序即交付包条目顺序（与服务端 cxCoverPresets 一致）。
export const coverPresets: CoverPreset[] = [
  { id: 'wechat_235', platform: 'wechat_mp', width: 900, height: 383, label: '公众号头条大图 2.35:1' },
  { id: 'wechat_square', platform: 'wechat_mp', width: 383, height: 383, label: '公众号转发小图 1:1' },
  { id: 'xhs_34', platform: 'xhs', width: 1080, height: 1440, label: '小红书 3:4' },
  { id: 'xhs_square', platform: 'xhs', width: 1080, height: 1080, label: '小红书 1:1' },
  { id: 'xhs_916', platform: 'xhs', width: 1080, height: 1920, label: '小红书 9:16' },
]

export function coverPresetsFor(platform: string): CoverPreset[] {
  return coverPresets.filter((preset) => preset.platform === platform)
}

// 与服务端 cxCoverFileName 一致：平台+像素防重名。
export function coverFileName(preset: CoverPreset): string {
  return `cover-${preset.id}-${preset.width}x${preset.height}.png`
}

// 中心裁剪：在 0..1 归一化坐标里取最大居中框，宽高比等于目标比例。
function centerBox(targetAspect: number, sourceWidth: number, sourceHeight: number): CropBox {
  const sourceAspect = sourceWidth / sourceHeight
  let boxWidth = 1
  let boxHeight = 1
  if (sourceAspect > targetAspect) boxWidth = targetAspect / sourceAspect
  else boxHeight = sourceAspect / targetAspect
  return { x1: (1 - boxWidth) / 2, y1: (1 - boxHeight) / 2, x2: (1 + boxWidth) / 2, y2: (1 + boxHeight) / 2 }
}

// 每个预设使用的裁剪框：公众号两个比例沿用 cover_crops（与推送共用同一坐标），
// 小红书 1:1 优先复用已保存的 1:1 裁剪，其余扩展比例取中心裁剪建议。
export function coverCropBox(preset: CoverPreset, crops: Record<string, CropBox> | null, sourceWidth: number, sourceHeight: number): CropBox {
  const targetAspect = preset.width / preset.height
  if (preset.id === 'wechat_235') {
    const stored = crops?.['2.35_1']
    if (stored) return stored
  }
  if (preset.id === 'wechat_square' || preset.id === 'xhs_square') {
    const stored = crops?.['1_1']
    if (stored) return stored
  }
  return centerBox(targetAspect, sourceWidth, sourceHeight)
}

// 低分辨率估算：目标边长超过裁剪区像素的倍率。>1 意味着要放大，需要用户明确确认。
export function coverUpscaleFactor(preset: CoverPreset, crops: Record<string, CropBox> | null, sourceWidth: number, sourceHeight: number): number {
  const box = coverCropBox(preset, crops, sourceWidth, sourceHeight)
  const cropWidth = Math.max(1, Math.round((box.x2 - box.x1) * sourceWidth))
  const cropHeight = Math.max(1, Math.round((box.y2 - box.y1) * sourceHeight))
  return Math.max(preset.width / cropWidth, preset.height / cropHeight)
}

export interface CoverRenderResult {
  preset: CoverPreset
  name: string
  dataUrl: string
  /** 放大倍率：>1 表示源裁剪区像素少于目标尺寸（低分辨率，需要用户确认）。 */
  upscale: number
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

export async function renderCoverImages(
  assetPath: string,
  assetWidth: number,
  assetHeight: number,
  presets: CoverPreset[],
  crops: Record<string, CropBox> | null,
  onProgress?: (done: number, total: number) => void,
): Promise<CoverRenderResult[]> {
  const image = await loadImage(assetPath)
  const width = image.naturalWidth || assetWidth
  const height = image.naturalHeight || assetHeight
  const results: CoverRenderResult[] = []
  for (let index = 0; index < presets.length; index++) {
    const preset = presets[index]
    const box = coverCropBox(preset, crops, width, height)
    const cropWidth = Math.max(1, Math.round((box.x2 - box.x1) * width))
    const cropHeight = Math.max(1, Math.round((box.y2 - box.y1) * height))
    const canvas = document.createElement('canvas')
    canvas.width = preset.width
    canvas.height = preset.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建封面画布')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, preset.width, preset.height)
    ctx.drawImage(image, (box.x1 * width) | 0, (box.y1 * height) | 0, cropWidth, cropHeight, 0, 0, preset.width, preset.height)
    results.push({
      preset,
      name: coverFileName(preset),
      dataUrl: canvas.toDataURL('image/png'),
      // 低分辨率提醒：任一方向需要放大即提示（安全区中心 80% 仅为设计参考）。
      upscale: Math.max(preset.width / cropWidth, preset.height / cropHeight),
    })
    onProgress?.(index + 1, presets.length)
  }
  return results
}
