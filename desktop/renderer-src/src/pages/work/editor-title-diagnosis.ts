export interface TitleRuleDimension {
  score: number | null
  max: number
  state: 'available' | 'unavailable'
}

export interface TitleRuleResult {
  ruleScore: number
  ruleMax: number
  coverage: 'complete' | 'partial'
  dimensions: Record<'length' | 'keywords' | 'specificity' | 'curiosity' | 'cleanliness' | 'structure', TitleRuleDimension>
}

// Keep this list in step with checks.go's shared M9 adWords definition.
const adWords = ['最', '第一', '唯一', '首个', '顶级', '极致', '绝对', '100%', '永久', '国家级', '世界级']
const numericPattern = /[0-9０-９一二三四五六七八九十百千万亿]+/u
const timedNumberPattern = /[0-9０-９一二三四五六七八九十百千万亿]+(?:年|月|日|天|小时|分钟|秒)/u
const curiosityWords = ['为什么', '为何', '如何', '怎么', '竟然', '原来', '却', '但']
const timeWords = ['今天', '昨天', '明天', '本周', '本月', '今年', '去年', '明年']

export function scoreTitleRules(platform: string, title: string, positioningTags: string[]): TitleRuleResult {
  const dimensions = {} as TitleRuleResult['dimensions']
  let ruleScore = 0
  let ruleMax = 0
  let coverage: TitleRuleResult['coverage'] = 'complete'
  const set = (key: keyof TitleRuleResult['dimensions'], score: number, max: number) => {
    dimensions[key] = { score, max, state: 'available' }
    ruleScore += score
    ruleMax += max
  }
  const unavailable = (key: keyof TitleRuleResult['dimensions'], max: number) => {
    dimensions[key] = { score: null, max, state: 'unavailable' }
    coverage = 'partial'
  }
  const runes = Array.from(title)
  if (platform === 'wechat_mp') set('length', runes.length > 0 && runes.length <= 32 ? 10 : 0, 10)
  else if (platform === 'xhs') set('length', runes.length <= 20 ? 10 : runes.length <= 30 ? 6 : 3, 10)
  else unavailable('length', 10)

  const tags = positioningTags.map(tag => tag.trim()).filter(Boolean)
  if (tags.length === 0) unavailable('keywords', 10)
  else {
    const offsets = tags.flatMap(tag => {
      const at = title.indexOf(tag)
      return at < 0 ? [] : [Array.from(title.slice(0, at)).length]
    })
    const first = offsets.length > 0 ? Math.min(...offsets) : -1
    set('keywords', first >= 0 && first <= 7 ? 10 : first >= 8 && first <= 13 ? 6 : 2, 10)
  }

  let classes = 0
  if (numericPattern.test(title)) classes++
  if (timedNumberPattern.test(title) || timeWords.some(word => title.includes(word))) classes++
  if (tags.some(tag => title.includes(tag))) classes++
  set('specificity', classes >= 2 ? 10 : classes === 1 ? 5 : 2, 10)
  set('curiosity', curiosityWords.some(word => title.includes(word)) ? 10 : 4, 10)

  let cleanliness = adWords.some(word => title.includes(word)) ? 0 : 10
  const exclamationCount = runes.filter(char => char === '!' || char === '！').length
  const emojiCount = runes.filter(char => {
    const point = char.codePointAt(0)!
    return (point >= 0x1f300 && point <= 0x1faff || point >= 0x2600 && point <= 0x27bf) && !(point >= 0x1f3fb && point <= 0x1f3ff)
  }).length
  cleanliness = Math.max(0, cleanliness - Math.max(0, exclamationCount - 2) * 2 - Math.max(0, emojiCount - 3))
  set('cleanliness', cleanliness, 10)

  let structure = 10
  if (runes.length < 8 || runes.length > 24) structure -= 4
  if (hasRepeatedFourRuneSequence(runes)) structure -= 4
  if (isAllUppercaseLatin(runes)) structure -= 4
  if (isAllSymbols(runes)) structure -= 4
  set('structure', Math.max(0, structure), 10)
  return { ruleScore, ruleMax, coverage, dimensions }
}

function hasRepeatedFourRuneSequence(runes: string[]) {
  for (let i = 0; i + 8 <= runes.length; i++) {
    if (runes.slice(i, i + 4).join('') === runes.slice(i + 4, i + 8).join('')) return true
  }
  return false
}

function isAllUppercaseLatin(runes: string[]) {
  let count = 0
  for (const char of runes) {
    if (char >= 'a' && char <= 'z') return false
    if (char >= 'A' && char <= 'Z') count++
  }
  return count >= 2
}

function isAllSymbols(runes: string[]) {
  let hasContent = false
  for (const char of runes) {
    if (/\s/u.test(char)) continue
    hasContent = true
    if (/[\p{L}\p{N}]/u.test(char)) return false
  }
  return hasContent
}
