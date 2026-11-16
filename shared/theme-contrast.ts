/** 校验自定义主题中用于正文链接和标题的主色。背景由渲染器固定为白色。 */
export function customThemeContrastError(color: string): string | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '主色需要是 #RRGGBB 格式'
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  if (1.05 / (luminance + 0.05) < 4.5) return '主色与白色背景的文字对比度不足 4.5:1，请选择更深的颜色'
  return null
}
