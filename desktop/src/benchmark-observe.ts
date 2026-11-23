// REF41 I1-A5：竞对公开页只读采集的纯解析层。
//
// 这里不碰 Electron，也不发网络请求，只把「一个已经在无登录态窗口里加载完成的
// 公开页面快照」解析成服务端 benchmark.observe.result 需要的字段。页面可能来自
// 小红书主页/笔记、头条主页/文章或公众号文章；平台结构随时会变，所以解析顺序是：
//   1) 页面里可识别的笔记 ID（URL 或 JSON）
//   2) 公开 JSON（__INITIAL_STATE__ / _SSR_HYDRATED_DATA / RENDER_DATA 等）
//   3) meta / 可见文本兜底
// 缺字段时如实返回 partial，绝不把缺失值补成 0；页面打不开、登录墙、风控页时
// 由调用方写 failed，本层只负责识别。

import { createHash } from 'node:crypto';

export type BenchmarkQuality = 'ok' | 'partial' | 'failed';
export type BenchmarkMetric = 'likes' | 'comments' | 'favorites' | 'shares' | 'views';

export interface PublicPageSnapshot {
  finalUrl: string;
  title: string;
  meta: Record<string, string>;
  globals: Record<string, unknown>;
  links: string[];
  text: string;
  labeledCounts?: Array<{ label: string; text: string }>;
}

export interface PublicPageRead {
  snapshot: PublicPageSnapshot;
  noteUrl: string;
}

export interface PublicBenchmarkNote {
  externalId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  values: Partial<Record<BenchmarkMetric, number>>;
  quality: BenchmarkQuality;
  errorCode?: 'login_wall' | 'risk_control' | 'no_public_note' | 'empty_page';
}

const METRIC_ALIASES: Record<string, BenchmarkMetric> = {
  like: 'likes', likes: 'likes', likecount: 'likes', likedcount: 'likes', likescount: 'likes',
  praisecount: 'likes', praiselikecount: 'likes', diggcount: 'likes',
  comment: 'comments', comments: 'comments', commentcount: 'comments', commentscount: 'comments',
  replycount: 'comments', replies: 'comments',
  favorite: 'favorites', favorites: 'favorites', favoritecount: 'favorites', collectcount: 'favorites',
  collectedcount: 'favorites', collectioncount: 'favorites', favoritescount: 'favorites',
  share: 'shares', shares: 'shares', sharecount: 'shares', sharedcount: 'shares', sharescount: 'shares',
  forwardcount: 'shares',
  view: 'views', views: 'views', viewcount: 'views', viewscount: 'views', playcount: 'views',
  readcount: 'views', readnum: 'views', watchcount: 'views'
};

const NOTE_PATH_MARKERS = ['/explore/', '/discovery/item/', '/article/', '/video/', '/note/', '/status/'];

const LOGIN_WALL_PHRASES = ['登录后查看', '请先登录', '请登录后', '登录以继续', '扫码登录', '密码登录'];
const RISK_PHRASES = ['安全验证', '访问异常', '操作频繁', '账号异常', '人机验证', '验证码'];

function normalizeMetricKey(raw: string): BenchmarkMetric | null {
  const key = raw.replace(/[_\-\s]/g, '').toLowerCase();
  return METRIC_ALIASES[key] ?? null;
}

// 小红书/头条公开页常见「1.2万」「3.4w」「10万+」；只接受有限非负数。
export function parsePublicCount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/,/g, '').replace(/\+$/, '');
  if (!text) return null;
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|w|W|亿)?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2];
  const multiplier = unit === '亿' ? 100_000_000 : unit === '万' || unit === 'w' || unit === 'W' ? 10_000 : 1;
  return Math.round(base * multiplier);
}

export function noteIDFromPublicURL(raw: string, platform: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname;
  for (const marker of NOTE_PATH_MARKERS) {
    const index = path.indexOf(marker);
    if (index < 0) continue;
    const rest = path.slice(index + marker.length).split('/')[0] ?? '';
    const id = rest.replace(/\.(html|htm)$/i, '').trim();
    if (id) return decodeURIComponent(id);
  }
  if (platform === 'wechat_mp') {
    // 公众号文章没有稳定的 path id，优先用 sn；没有 sn 时用完整 URL 的 hash，
    // 保证同一篇文章每次采集得到同一个 external_id。
    const sn = url.searchParams.get('sn')?.trim();
    if (sn) return sn;
    const segment = path.split('/').filter(Boolean).pop();
    if (segment && segment !== 's') return segment;
  }
  return null;
}

export function externalIDForPublicURL(raw: string, platform: string): string {
  const id = noteIDFromPublicURL(raw, platform);
  if (id) return id;
  const digest = createHash('sha256').update(`${platform}:${raw}`).digest('hex').slice(0, 24);
  return `public-url-${digest}`;
}

export function benchmarkURLAllowed(platform: string, raw: string, allowLocal: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (allowLocal && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
  if (platform === 'xhs') return host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
  if (platform === 'toutiao') return host === 'toutiao.com' || host.endsWith('.toutiao.com');
  if (platform === 'wechat_mp') return host === 'mp.weixin.qq.com';
  return false;
}

// 从主页快照的链接里挑第一条可识别为作品的公开 URL。主页本身是作品页时返回 null，
// 由调用方直接解析主页快照。
export function discoverNoteURL(snapshot: PublicPageSnapshot, platform: string): string | null {
  for (const link of snapshot.links) {
    let url: URL;
    try {
      url = new URL(link, snapshot.finalUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (noteIDFromPublicURL(url.toString(), platform)) return url.toString();
  }
  return null;
}

function walkJson(value: unknown, visit: (object: Record<string, unknown>) => void, depth: number): void {
  if (depth <= 0 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) walkJson(item, visit, depth - 1);
    return;
  }
  const object = value as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) walkJson(child, visit, depth - 1);
}

// 在公开 JSON 里找指标最完整的一个对象；只在同一对象内合并别名，避免把主页的
// 粉丝数、导航栏数字和作品指标混在一起。
export function metricsFromGlobals(globals: Record<string, unknown>): Partial<Record<BenchmarkMetric, number>> {
  let best: Partial<Record<BenchmarkMetric, number>> = {};
  let bestCount = 0;
  walkJson(globals, (object) => {
    const bag: Partial<Record<BenchmarkMetric, number>> = {};
    for (const [key, raw] of Object.entries(object)) {
      const metric = normalizeMetricKey(key);
      if (!metric || bag[metric] !== undefined) continue;
      const parsed = parsePublicCount(raw);
      if (parsed !== null) bag[metric] = parsed;
    }
    const count = Object.keys(bag).length;
    if (count > bestCount) {
      best = bag;
      bestCount = count;
    }
  }, 7);
  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTextMetric(text: string, labels: string[]): number | null {
  for (const label of labels) {
    // 只接受同一行内“数字 + 标签”的顺序；公开页的“数字换行后跟收藏/分享”
    // 是按钮排布，不代表该指标，不能把 360\n收藏 误读成收藏数。
    const re = new RegExp(`([0-9]+(?:\\.[0-9]+)?[ \\t]*(?:万|w|W|亿)?)[ \\t]*(?:${escapeRegExp(label)})`, 'i');
    const match = text.match(re);
    if (match) {
      const parsed = parsePublicCount(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export function metricsFromText(text: string): Partial<Record<BenchmarkMetric, number>> {
  const bag: Partial<Record<BenchmarkMetric, number>> = {};
  const likes = readTextMetric(text, ['点赞', '赞', 'likes', 'like']);
  if (likes !== null) bag.likes = likes;
  const comments = readTextMetric(text, ['评论', 'comments', 'comment']);
  if (comments !== null) bag.comments = comments;
  const favorites = readTextMetric(text, ['收藏', 'favorites', 'favorite', 'collect']);
  if (favorites !== null) bag.favorites = favorites;
  const shares = readTextMetric(text, ['分享', 'shares', 'share']);
  if (shares !== null) bag.shares = shares;
  const views = readTextMetric(text, ['浏览', '阅读', '播放', 'views', 'view', 'play']);
  if (views !== null) bag.views = views;
  return bag;
}

function metricFromLabel(label: string): BenchmarkMetric | null {
  const text = label.trim().toLowerCase();
  if (!text) return null;
  if (/评论|comment/.test(text)) return 'comments';
  if (/点赞|赞|like/.test(text)) return 'likes';
  if (/收藏|favorite|collect/.test(text)) return 'favorites';
  if (/分享|share/.test(text)) return 'shares';
  if (/浏览|阅读|播放|view|play/.test(text)) return 'views';
  return null;
}

// 部分公开页把计数放在图标按钮的 aria-label/内部文本里：
// 头条移动页的「125评论」「点赞 360」就是这种结构。按标签取值，避免把
// “分享 / 收藏”这类无数字动作误当计数。
export function metricsFromLabeledCounts(
  items: Array<{ label: string; text: string }> | undefined
): Partial<Record<BenchmarkMetric, number>> {
  const bag: Partial<Record<BenchmarkMetric, number>> = {};
  for (const item of items ?? []) {
    const label = item.label.trim();
    const metric = metricFromLabel(label);
    if (!metric || bag[metric] !== undefined) continue;
    const parsed = parsePublicCount(item.text) ?? parsePublicCount(label);
    if (parsed !== null) bag[metric] = parsed;
  }
  return bag;
}

function parseTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = raw > 1_000_000_000_000 ? raw : raw > 1_000_000_000 ? raw * 1000 : null;
    if (millis === null) return null;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^[0-9]{10,13}$/.test(text)) return parseTimestamp(Number(text));
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const localMatch = text.match(/^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})\s+([0-9]{1,2}):([0-9]{2})/);
  if (localMatch) {
    const [, year, month, day, hour, minute] = localMatch;
    const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00+08:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function findTimestamp(globals: Record<string, unknown>): string | null {
  const keys = ['publishedAt', 'published_at', 'publishTime', 'publish_time', 'releaseTime', 'release_time',
    'createTime', 'create_time', 'createdAt', 'created_at', 'timestamp'];
  let found: string | null = null;
  walkJson(globals, (object) => {
    if (found) return;
    for (const key of keys) {
      if (!(key in object)) continue;
      const parsed = parseTimestamp(object[key]);
      if (parsed) {
        found = parsed;
        return;
      }
    }
  }, 6);
  return found;
}

function findTitle(globals: Record<string, unknown>): string {
  const keys = ['title', 'noteTitle', 'note_title', 'displayTitle', 'display_title', 'articleTitle', 'article_title'];
  let found = '';
  walkJson(globals, (object) => {
    if (found) return;
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) {
        found = value.trim();
        return;
      }
    }
  }, 6);
  return found;
}

function metaValue(meta: Record<string, string>, key: string): string {
  return typeof meta[key] === 'string' ? meta[key].trim() : '';
}

function cleanTitle(raw: string): string {
  return raw.replace(/\s*[-_|]\s*(小红书|今日头条|头条|微信公众平台)\s*$/, '').trim();
}

function hasPhrase(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}

export function parsePublicNoteSnapshot(
  snapshot: PublicPageSnapshot,
  platform: string,
  fallbackURL: string
): PublicBenchmarkNote {
  const url = snapshot.finalUrl || fallbackURL;
  const text = `${snapshot.text}\n${snapshot.title}`;
  const externalId = noteIDFromPublicURL(url, platform) ?? noteIDFromPublicURL(fallbackURL, platform) ??
    externalIDForPublicURL(fallbackURL, platform);
  const baseTitle = cleanTitle(metaValue(snapshot.meta, 'og:title') || metaValue(snapshot.meta, 'twitter:title') ||
    snapshot.title || findTitle(snapshot.globals));
  if (hasPhrase(text, LOGIN_WALL_PHRASES)) {
    return { externalId, title: baseTitle, url, publishedAt: null, values: {}, quality: 'failed', errorCode: 'login_wall' };
  }
  if (hasPhrase(text, RISK_PHRASES)) {
    return { externalId, title: baseTitle, url, publishedAt: null, values: {}, quality: 'failed', errorCode: 'risk_control' };
  }
  if (!snapshot.finalUrl && !fallbackURL) {
    return { externalId, title: baseTitle, url, publishedAt: null, values: {}, quality: 'failed', errorCode: 'empty_page' };
  }
  if (!noteIDFromPublicURL(url, platform) && !noteIDFromPublicURL(fallbackURL, platform)) {
    return { externalId, title: baseTitle, url, publishedAt: null, values: {}, quality: 'failed', errorCode: 'no_public_note' };
  }
  const jsonValues = metricsFromGlobals(snapshot.globals);
  const textValues = metricsFromText(snapshot.text);
  const values: Partial<Record<BenchmarkMetric, number>> = { ...jsonValues };
  const labeledValues = metricsFromLabeledCounts(snapshot.labeledCounts);
  for (const [key, value] of Object.entries(labeledValues)) {
    if (values[key as BenchmarkMetric] === undefined) values[key as BenchmarkMetric] = value;
  }
  for (const [key, value] of Object.entries(textValues)) {
    if (values[key as BenchmarkMetric] === undefined) values[key as BenchmarkMetric] = value;
  }
  const metricCount = Object.keys(values).length;
  const textPublishedAt = snapshot.text.match(
    /(?:20[0-9]{2})[-/][0-9]{1,2}[-/][0-9]{1,2}\s+[0-9]{1,2}:[0-9]{2}/
  )?.[0] ?? '';
  const publishedAt = metaValue(snapshot.meta, 'article:published_time') ||
    metaValue(snapshot.meta, 'og:release_date') || findTimestamp(snapshot.globals) || textPublishedAt || null;
  return {
    externalId,
    title: baseTitle,
    url,
    publishedAt: parseTimestamp(publishedAt) ?? null,
    values,
    quality: metricCount >= 2 ? 'ok' : metricCount === 1 ? 'partial' : 'partial'
  };
}

// 页面加载失败时也必须给服务端一个稳定的 external_id；失败观测的 values 必须为空，
// 不能把「没采到」伪装成 0。
export function failedPublicNote(fallbackURL: string, platform: string, title = '', errorCode: PublicBenchmarkNote['errorCode'] = 'empty_page'): PublicBenchmarkNote {
  return {
    externalId: externalIDForPublicURL(fallbackURL, platform),
    title,
    url: fallbackURL,
    publishedAt: null,
    values: {},
    quality: 'failed',
    errorCode
  };
}
