// 小红书适配器（D-129 / 20 文档 §6.1、§6.2、§17.1.1）。
//
// 只实现固定动作：verifyIdentity / probeCapabilities / discoverWorks / collectMetrics /
// parseShareText / disconnectLocal。只使用 §17.1.1 已实测确认的接口与字段：
//   /api/galaxy/user/info                     → userId、redId
//   /api/galaxy/v2/creator/note/user/posted   → id、display_title、time、type、tab_status、
//                                               view_count、likes、collected_count、comments_count、shared_count
//   /api/galaxy/creator/home/personal_info    → fans_count、follow_count、faved_count
// 单篇曝光与涨粉对该账号返回空，首版不承诺（能力标 unknown）。
//
// 本文件是纯解析与映射：网络读取由注入的只读响应源完成，测试全部走 fixture，不访问真实平台。

import type { PlatformObservationDraft } from '../platform-client';
import { isPrivateHost } from '../platform-worker';

export const XHS_ADAPTER_VERSION = 'xhs-1';
export const XHS_MAPPING_VERSION = 1;
export const XHS_API = Object.freeze({
  userInfo: '/api/galaxy/user/info',
  postedNotes: '/api/galaxy/v2/creator/note/user/posted',
  personalInfo: '/api/galaxy/creator/home/personal_info'
});

// 允许解析的分享链接域名；短链本身不持久化为作品身份（§6.2）。
export const XHS_SHARE_HOSTS: ReadonlyArray<string> = Object.freeze(['xhslink.com', 'www.xiaohongshu.com', 'xiaohongshu.com']);

export type XhsCapabilityState = 'supported' | 'denied' | 'unknown' | 'temporarily_unavailable';

export interface XhsCapabilities {
  mainSiteLogin: XhsCapabilityState;
  creatorLogin: XhsCapabilityState;
  workList: XhsCapabilityState;
  perNoteMetrics: XhsCapabilityState;
  // 单篇曝光/涨粉：首版不承诺，始终 unknown（§6.2）。
  noteImpressions: XhsCapabilityState;
  followerTotal: XhsCapabilityState;
  detectedAt: string;
  adapterVersion: string;
  mappingVersion: number;
}

export interface XhsIdentity {
  externalAccountKey: string;
  redId: string;
}

// 一条笔记的规范化事实。字段是否出现用 present 标记，绝不把“没有”当成 0（§9.2）。
export interface XhsNoteFact {
  noteId: string;
  title: string;
  recordedAt: string | null;
  contentType: 'image' | 'video' | 'unknown';
  status: XhsNoteStatus;
  viewTimes: number | null;
  likes: number | null;
  favorites: number | null;
  comments: number | null;
  shares: number | null;
}

export type XhsNoteStatus = 'published' | 'draft' | 'reviewing' | 'hidden' | 'deleted' | 'unknown';

export interface XhsDiscoveryResult {
  notes: XhsNoteFact[];
  pagesRead: number;
  hasMore: boolean;
  nextCursor: string | null;
  // 覆盖说明：读了几页、是否因预算或结构不完整提前结束。
  coverage: { pages_read: number; has_more: boolean; incomplete_reason: string | null };
  duplicates: number;
}

// 只读响应源：由 CDP 会话在接入后实现；适配器只调用它取 JSON，不自己发请求。
export interface ReadOnlyResponseSource {
  fetchJSON(path: string): Promise<unknown>;
  // fetchSigned 用于需要平台签名的接口（如笔记列表）：由实现方让页面自己发起请求
  // 并监听响应，适配器仍然只关心“拿到 JSON”。不提供时回退到 fetchJSON。
  fetchSigned?(path: string): Promise<unknown>;
}

export class XhsAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'XhsAdapterError';
    this.code = code;
  }
}

// ---------- 数值与状态规范化 ----------

// parseCount 只接受明确的非负整数或“1.2万”这类可识别的大数写法。
// 返回 null 表示未知（缺失、空串、“—”、加载占位、NaN、布尔），绝不回退成 0。
export function parseCount(raw: unknown): { value: number; precision: 'exact' | 'rounded' } | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return null;
    // 与字符串分支一致：超过观测上限的数字不是可解释的计数。
    if (raw > 1e12) return null;
    return { value: raw, precision: 'exact' };
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text === '—' || text === '-' || text === '--' || /^(加载中|loading|\.\.\.|…)$/i.test(text)) {
    return null;
  }
  const wan = /^(\d+(?:\.\d+)?)\s*万$/.exec(text);
  if (wan) {
    const value = Math.round(Number(wan[1]) * 10000);
    // “1.2万”只能按 rounded 展示，不当作精确值（§9.1）。
    return Number.isSafeInteger(value) ? { value, precision: 'rounded' } : null;
  }
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return Number.isSafeInteger(value) && value <= 1e12 ? { value, precision: 'exact' } : null;
  }
  // 浮点、负数、布尔、其它写法一律视为不可解释。
  return null;
}

// mapNoteStatus 把平台的 tab_status 映射成独立状态；未知值保留 unknown，不推断删除。
//
// 平台实际返回的是**数字**：`tab_status: 1` 对应“已发布”
// （2026-10-21 真实账号实测：列表接口返回 tab_status=1，页面“全部 1 / 已发布”也是这一篇）。
// 只登记已实测确认的数值；其它数值保持 unknown，不猜成已发布，避免把草稿/审核中
// 当作作品观测（§2、PS-T14）。
export const XHS_TAB_STATUS_NUMBERS: Readonly<Record<number, XhsNoteStatus>> = Object.freeze({
  1: 'published'
});

export function mapNoteStatus(raw: unknown): XhsNoteStatus {
  // 数值形态优先按已登记表映射。
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return XHS_TAB_STATUS_NUMBERS[raw] ?? 'unknown';
  }
  // 纯数字字符串也按数值处理（平台不同接口的序列化不一致）。
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return XHS_TAB_STATUS_NUMBERS[Number(raw.trim())] ?? 'unknown';
  }
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (text) {
    case 'published':
    case 'posted':
    case 'public':
      return 'published';
    case 'draft':
      return 'draft';
    case 'reviewing':
    case 'auditing':
    case 'in_review':
      return 'reviewing';
    case 'hidden':
    case 'private':
      return 'hidden';
    case 'deleted':
      return 'deleted';
    default:
      return 'unknown';
  }
}

// mapNoteType 只区分图文的 image 与视频的 video；其它值不猜。
export function mapNoteType(raw: unknown): XhsNoteFact['contentType'] {
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'normal' || t === 'image' || t === 'pic') return 'image';
    if (t === 'video') return 'video';
  }
  if (typeof raw === 'number') {
    if (raw === 0) return 'image';
    if (raw === 1) return 'video';
  }
  return 'unknown';
}

// ---------- 身份与能力 ----------

export function parseIdentity(payload: unknown): XhsIdentity {
  const data = (payload as { data?: unknown })?.data;
  if (!data || typeof data !== 'object') {
    throw new XhsAdapterError('platform_login_required', '创作中心未返回账号身份');
  }
  const d = data as Record<string, unknown>;
  const userId = typeof d.userId === 'string' ? d.userId.trim() : '';
  if (!userId) {
    // 没有稳定 ID 就不能建立连接，也不能只凭昵称当作身份。
    throw new XhsAdapterError('platform_identity_mismatch', '无法取得小红书的稳定账号标识');
  }
  const redId = typeof d.redId === 'string' ? d.redId.trim() : '';
  return { externalAccountKey: `xhs_user_id:${userId}`, redId };
}

// probeCapabilities 分别判定主站与创作中心登录态：主站可用但创作中心不可用时，
// 只报告可读范围，不填造作品表现（§6.2）。
export function probeCapabilities(input: {
  mainSiteLoggedIn: boolean;
  identity: XhsIdentity | null;
  postedNotesReadable: boolean;
  followerInfoReadable: boolean;
  now: string;
}): XhsCapabilities {
  const creator = input.identity ? 'supported' : input.mainSiteLoggedIn ? 'denied' : 'unknown';
  const listState: XhsCapabilityState = creator === 'supported' && input.postedNotesReadable ? 'supported'
    : creator === 'supported' ? 'temporarily_unavailable' : 'unknown';
  return {
    mainSiteLogin: input.mainSiteLoggedIn ? 'supported' : 'unknown',
    creatorLogin: creator,
    workList: listState,
    perNoteMetrics: listState,
    // 未实测的字段保持 unknown，不声称已支持。
    noteImpressions: 'unknown',
    followerTotal: creator === 'supported' && input.followerInfoReadable ? 'supported' : 'unknown',
    detectedAt: input.now,
    adapterVersion: XHS_ADAPTER_VERSION,
    mappingVersion: XHS_MAPPING_VERSION
  };
}

// ---------- 列表解析与分页 ----------

function normalizeNote(raw: unknown): XhsNoteFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  // id 即 note_id；没有稳定编号的条目不能进入自动回填。
  const noteId = typeof n.id === 'string' ? n.id.trim() : typeof n.noteId === 'string' ? n.noteId.trim() : '';
  if (!/^[0-9a-f]{24}$/.test(noteId)) return null;
  const count = (v: unknown) => parseCount(v)?.value ?? null;
  return {
    noteId,
    title: typeof n.display_title === 'string' ? n.display_title : typeof n.title === 'string' ? n.title : '',
    recordedAt: typeof n.time === 'string' || typeof n.time === 'number' ? String(n.time) : null,
    contentType: mapNoteType(n.type),
    status: mapNoteStatus(n.tab_status),
    viewTimes: count(n.view_count),
    likes: count(n.likes),
    favorites: count(n.collected_count),
    comments: count(n.comments_count),
    shares: count(n.shared_count)
  };
}

// parsePostedNotesPage 解析一页列表；同时给出本页的游标信息，供调用方决定是否继续。
export function parsePostedNotesPage(payload: unknown): {
  notes: XhsNoteFact[];
  page: number | null;
  cursor: string | null;
  hasMore: boolean;
  invalidRows: number;
} {
  const body = payload as { data?: unknown; success?: unknown; code?: unknown } | null;
  if (body && body.success === false) {
    // 平台明确失败（未登录、验证、受限）时交给调用方按错误码处理，不返回空列表冒充“没有作品”。
    throw new XhsAdapterError('platform_login_required', '创作中心未登录或要求验证');
  }
  const data = (body?.data ?? payload) as Record<string, unknown> | null;
  const list = data && Array.isArray((data as Record<string, unknown>).notes)
    ? (data as Record<string, unknown>).notes as unknown[]
    : data && Array.isArray((data as Record<string, unknown>).items)
      ? (data as Record<string, unknown>).items as unknown[]
      : [];
  const notes: XhsNoteFact[] = [];
  let invalidRows = 0;
  for (const item of list) {
    const note = normalizeNote(item);
    if (note) notes.push(note);
    else invalidRows += 1;
  }
  const pageRaw = data?.page;
  const page = typeof pageRaw === 'number' && Number.isInteger(pageRaw) ? pageRaw : null;
  // page:-1 表示平台没有更多页；cursor 形态则直接取游标。
  const cursorRaw = data?.cursor ?? data?.next_cursor;
  const cursor = typeof cursorRaw === 'string' && cursorRaw.trim() !== '' ? cursorRaw.trim() : null;
  const hasMore = cursor !== null ? true : page !== null ? page >= 0 : false;
  // 整页都解析不出来且平台声称有数据：结构变化，不能当作“没有作品”。
  if (notes.length === 0 && invalidRows > 0) {
    throw new XhsAdapterError('platform_schema_changed', '笔记列表结构已变化');
  }
  return { notes, page, cursor, hasMore, invalidRows };
}

// collectPostedNotes 跨页收集并按 note_id 去重；到达页数上限或没有下一页时停止，
// 并如实报告覆盖，不能只读第一页就宣称已同步全部（§6.2）。
export async function collectPostedNotes(
  source: ReadOnlyResponseSource,
  options: {
    maxPages?: number;
    // page 形态每页请求的页码；prefix 用于把分页参数拼到路径上。
    buildPath?: (state: { page: number; cursor: string | null }) => string;
  } = {}
): Promise<XhsDiscoveryResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 3, 3));
  const buildPath = options.buildPath ?? ((s: { page: number; cursor: string | null }) =>
    s.cursor ? `${XHS_API.postedNotes}?cursor=${encodeURIComponent(s.cursor)}` : `${XHS_API.postedNotes}?page=${s.page}&page_size=20`);
  const seen = new Map<string, XhsNoteFact>();
  let duplicates = 0;
  let pagesRead = 0;
  let page = 0;
  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let hasMore = false;
  let incompleteReason: string | null = null;
  for (;;) {
    if (pagesRead >= maxPages) {
      incompleteReason = 'page_budget';
      break;
    }
    // 笔记列表接口需要平台签名；有 fetchSigned 时走“页面自发请求 + 响应监听”。
    const path = buildPath({ page, cursor });
    const payload = source.fetchSigned
      ? await source.fetchSigned(path)
      : await source.fetchJSON(path);
    const parsed = parsePostedNotesPage(payload);
    pagesRead += 1;
    for (const note of parsed.notes) {
      if (seen.has(note.noteId)) {
        duplicates += 1;
        continue;
      }
      seen.set(note.noteId, note);
    }
    hasMore = parsed.hasMore;
    // 游标与上一页完全相同说明平台没有推进：停止并如实标记，避免无限循环。
    if (parsed.hasMore && parsed.cursor !== null && parsed.cursor === previousCursor) {
      incompleteReason = 'cursor_stalled';
      cursor = parsed.cursor;
      break;
    }
    previousCursor = parsed.cursor;
    cursor = parsed.cursor;
    if (!hasMore) break;
    if (cursor === null) {
      page += 1;
    }
  }
  return {
    notes: [...seen.values()],
    pagesRead,
    hasMore,
    nextCursor: hasMore ? cursor : null,
    coverage: { pages_read: pagesRead, has_more: hasMore, incomplete_reason: incompleteReason },
    duplicates
  };
}

// ---------- 观测映射 ----------

// toObservations 把一条笔记映射成观测。只有已发布笔记才可作为作品观测；
// 草稿/审核中/隐藏/删除单独识别，不自动改 OPS 发布状态（§2、PS-T14）。
export function noteToObservation(
  note: XhsNoteFact,
  input: { externalAccountKey: string; observedAt: string; bindingRevision?: number; publishRevision?: number }
): PlatformObservationDraft | null {
  if (note.status !== 'published') return null;
  const values: Record<string, unknown> = {};
  const fieldPaths: Record<string, string> = {};
  const put = (key: string, value: number | null, unit: 'count' | 'unknown', path: string) => {
    if (value === null) return;
    values[key] = { value, precision: 'exact', unit };
    fieldPaths[key] = path;
  };
  // view_count 页面标签为“观看”，单位未确认前按 unknown 存观测，不投影 reads（D-129 v0.4）。
  put('view_times', note.viewTimes, 'unknown', 'fixture.note.view_count');
  put('like_count', note.likes, 'count', 'fixture.note.likes');
  put('favorite_count', note.favorites, 'count', 'fixture.note.collected_count');
  put('comment_count', note.comments, 'count', 'fixture.note.comments_count');
  put('share_times', note.shares, 'count', 'fixture.note.shared_count');
  if (Object.keys(values).length === 0) return null;
  return {
    row_no: 0,
    scope: 'work',
    external_account_key: input.externalAccountKey,
    external_id: note.noteId,
    ...(input.bindingRevision !== undefined ? { binding_revision: input.bindingRevision } : {}),
    ...(input.publishRevision !== undefined ? { publish_revision: input.publishRevision } : {}),
    source: 'xhs_browser',
    temporal_kind: 'cumulative',
    observed_at: input.observedAt,
    // 列表计数是“读取时的当前累计”，截止时点取读取时刻。
    as_of_at: input.observedAt,
    adapter_version: XHS_ADAPTER_VERSION,
    mapping_version: XHS_MAPPING_VERSION,
    values,
    field_paths: fieldPaths
  };
}

// ---------- 分享文本与短链 ----------

// extractShareURL 从 App 复制的分享文本里取出候选链接；取不到返回 null，交给手工输入 note_id。
export function extractShareURL(text: string): URL | null {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(text);
  if (!match) return null;
  let parsed: URL;
  try {
    parsed = new URL(match[0]);
  } catch {
    return null;
  }
  if (!XHS_SHARE_HOSTS.includes(parsed.hostname.toLowerCase())) return null;
  if (isPrivateHost(parsed.hostname)) return null;
  // 统一升级为 HTTPS；短链解析只在允许域名内做有限跳转（§6.2）。
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  parsed.protocol = 'https:';
  return parsed;
}

// noteIDFromURL 从完整笔记链接里取 note_id；不带编号的短链返回 null。
export function noteIDFromURL(url: URL): string | null {
  const direct = /\/explore\/([0-9a-f]{24})/i.exec(url.pathname) ?? /\/discovery\/item\/([0-9a-f]{24})/i.exec(url.pathname);
  if (direct) return direct[1].toLowerCase();
  const query = url.searchParams.get('noteId') ?? url.searchParams.get('note_id');
  if (query && /^[0-9a-f]{24}$/i.test(query)) return query.toLowerCase();
  return null;
}

// stripSessionParams 清掉会话性参数，对外展示链接不带 xsec_token 等（§6.2）。
export function stripSessionParams(url: URL): string {
  const clean = new URL(url.toString());
  for (const key of ['xsec_token', 'xsec_source', 'share_from_user_hidden', 'appuid', 'apptime', 'share_id', 'source', 'author_share']) {
    clean.searchParams.delete(key);
  }
  return clean.toString();
}

// resolveShareLink 在有界跳转内解析短链：最多 3 次、每次仅 HTTPS、每次仍在允许域名内。
// resolve 由调用方注入（CDP 会话），适配器不自己发请求。
export async function resolveShareLink(
  text: string,
  resolve: (url: string) => Promise<{ url: string } | null>
): Promise<{ noteId: string; displayURL: string }> {
  const start = extractShareURL(text);
  if (!start) {
    throw new XhsAdapterError('platform_historical_unavailable', '分享文本里没有可识别的小红书链接');
  }
  let current = start;
  for (let hop = 0; hop < 3; hop += 1) {
    const noteId = noteIDFromURL(current);
    if (noteId) {
      return { noteId, displayURL: stripSessionParams(current) };
    }
    const next = await resolve(current.toString());
    if (!next) break;
    let parsed: URL;
    try {
      parsed = new URL(next.url);
    } catch {
      break;
    }
    if (parsed.protocol !== 'https:' || !XHS_SHARE_HOSTS.includes(parsed.hostname.toLowerCase()) || isPrivateHost(parsed.hostname)) {
      // 跳出允许域名或私网：拒绝，不跟随。
      throw new XhsAdapterError('platform_network_unavailable', '短链跳转到了不允许的地址');
    }
    current = parsed;
  }
  throw new XhsAdapterError('platform_historical_unavailable', '无法从分享链接解析出笔记编号，请手工输入 note_id');
}

// verifyNoteAuthor 核对笔记作者是否为连接的账号：编号相同但作者不同不能当作本人作品。
export function verifyNoteAuthor(payload: unknown, expectedUserId: string): boolean {
  const data = (payload as { data?: unknown })?.data ?? payload;
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const candidates = [d.userId, d.user_id, (d.user as Record<string, unknown> | undefined)?.userId];
  const got = candidates.find((v) => typeof v === 'string' && v.trim() !== '');
  if (typeof got !== 'string') return false;
  return got.trim() === expectedUserId.trim();
}
