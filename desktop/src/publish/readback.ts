// REF41 P3：桌面侧回读对比。与 server/internal/app/publish_readback.go 保持同一口径：
// 全角转半角、去零宽字符、连续空白折叠、首尾 trim；正文再去除全部空白；
// 标签按集合比较但首项必须一致；封面只比较存在性与宽高比（±0.02）。
import { createHash } from 'node:crypto';

export const PUBLISH_BODY_PROMO_SUFFIXES = ['本文为推广内容', '下载APP查看更多'];

export interface PublishReadbackActual {
  title: string;
  body: string;
  tags: string[];
  cover: { present: boolean; ratio: number };
  schedule: string;
}

export interface PublishReadbackFields {
  title: Record<string, unknown>;
  body: Record<string, unknown>;
  tags: Record<string, unknown>;
  cover: Record<string, unknown>;
  schedule: Record<string, unknown>;
}

export interface PublishReadbackResult {
  ok: boolean;
  fields: PublishReadbackFields;
}

export function normalizePublishText(value: string): string {
  const halfwidth: string[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      halfwidth.push(' ');
    } else if (code >= 0xff01 && code <= 0xff5e) {
      halfwidth.push(String.fromCodePoint(code - 0xfee0));
    } else if ([0x200b, 0x200c, 0x200d, 0xfeff, 0x2060].includes(code)) {
      continue;
    } else {
      halfwidth.push(char);
    }
  }
  return halfwidth.join('').replace(/\s+/g, ' ').trim();
}

export function normalizePublishBody(value: string): string {
  return normalizePublishText(value).replace(/\s+/g, '');
}

/**
 * 小红书真实创作页没有独立话题输入框时，fillFields 会把标签以 `#tag` 形式追加在正文尾部。
 * 回读时标签已经单独解析进 tags，正文比较必须剥离这段回退标签，否则真实页会误判
 * body mismatch。只在确实解析出标签时剥离，且只剥离尾部连续 hashtag。
 */
export function stripTrailingFallbackTags(value: string, tags: string[]): string {
  if (tags.length === 0) return value;
  return value
    .replace(/(?:^|\s)(?:#[^#\s]{1,30})(?:\s+#[^#\s]{1,30})*\s*$/, '')
    .trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareTitle(expected: string, actual: string): Record<string, unknown> {
  const e = normalizePublishText(expected);
  const a = normalizePublishText(actual);
  return { expected_hash: sha256(e), actual_hash: sha256(a), ok: e === a };
}

function compareBody(expected: string, actual: string): Record<string, unknown> {
  const e = normalizePublishBody(expected);
  let a = normalizePublishBody(actual);
  for (const suffix of PUBLISH_BODY_PROMO_SUFFIXES) {
    const normalized = normalizePublishBody(suffix);
    if (normalized && a.endsWith(normalized)) {
      a = a.slice(0, -normalized.length);
      break;
    }
  }
  return {
    expected_len: [...e].length,
    actual_len: [...a].length,
    expected_hash: sha256(e),
    actual_hash: sha256(a),
    ok: e === a,
  };
}

function normalizeTags(tags: string[]): string[] {
  return tags.map(normalizePublishText).filter((tag) => tag !== '');
}

function compareTags(expected: string[], actual: string[]): Record<string, unknown> {
  const e = normalizeTags(expected);
  const a = normalizeTags(actual);
  const sameSet = e.length === a.length
    && e.every((tag) => a.includes(tag))
    && a.every((tag) => e.includes(tag));
  const firstOK = e.length === 0 || a.length === 0 ? sameSet : e[0] === a[0];
  return {
    expected_count: e.length,
    actual_count: a.length,
    first: a[0] ?? '',
    ok: sameSet && firstOK,
  };
}

function formatRatio(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function compareCover(
  expectedPresent: boolean,
  actualPresent: boolean,
  expectedRatio: number,
  actualRatio: number
): Record<string, unknown> {
  let ok = expectedPresent === actualPresent;
  // 0.75 - 0.73 在浮点下是 0.020000000000000018；容差按“含边界”处理，避免恰好 0.02 被判失败。
  if (ok && expectedPresent) ok = Math.abs(expectedRatio - actualRatio) <= 0.02 + 1e-9;
  return {
    expected_present: expectedPresent,
    present: actualPresent,
    expected_ratio: formatRatio(expectedRatio),
    actual_ratio: formatRatio(actualRatio),
    ok,
  };
}

function compareSchedule(expected: string, actual: string): Record<string, unknown> {
  const e = normalizePublishText(expected);
  const a = normalizePublishText(actual);
  return { expected: e, actual: a, ok: e === a };
}

function manifestString(manifest: Record<string, unknown>, key: string): string {
  const fields = manifest.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return '';
  const value = (fields as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function manifestTags(manifest: Record<string, unknown>): string[] {
  const fields = manifest.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const value = (fields as Record<string, unknown>).tags;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function expectedCoverRatio(manifest: Record<string, unknown>): number {
  const assets = manifest.assets;
  if (!Array.isArray(assets)) return 0;
  for (const item of assets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const asset = item as Record<string, unknown>;
    if (asset.role !== 'cover') continue;
    const width = Number(asset.width);
    const height = Number(asset.height);
    if (width > 0 && height > 0) return width / height;
  }
  return 0;
}

/**
 * 用 manifest 的期望值与页面实际值生成五类回读字段。
 * 只做比较，不判断任务状态；调用方用 `ok` 决定是否允许提交。
 */
export function buildPublishReadback(
  manifest: Record<string, unknown>,
  actual: PublishReadbackActual
): PublishReadbackResult {
  const coverRatio = expectedCoverRatio(manifest);
  const fields: PublishReadbackFields = {
    title: compareTitle(manifestString(manifest, 'title'), actual.title),
    body: compareBody(manifestString(manifest, 'body_text'), actual.body),
    tags: compareTags(manifestTags(manifest), actual.tags),
    cover: compareCover(coverRatio > 0, actual.cover.present, coverRatio, actual.cover.ratio),
    schedule: compareSchedule(manifestString(manifest, 'schedule_at'), actual.schedule),
  };
  const ok = Object.values(fields).every((field) => field.ok === true);
  return { ok, fields };
}
