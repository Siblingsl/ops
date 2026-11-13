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
// CF-PS-07：列表接口（postedNotes）的字段集合不含正文，单篇正文改由**注入式详情只读源**
// `fetchNoteDetail` 提供；真实请求由宿主按已实测契约发起，适配器不臆造平台 URL，
// 也不把上面的接口白名单扩大到未实测的 endpoint。

import { createHash } from 'node:crypto';
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
  // CF-PS-04：正文能力键必须显式上报。缺键会让服务端 content 阶段无法区分
  // 「没上报」与「不支持」，并固定 content_capability_unverified（21 §十七点六十一）。
  // CF-PS-07：只有 probeNoteContent 确实读到非空正文才允许 supported；其余一律 unknown。
  noteContent: XhsCapabilityState;
  // 未达 supported 时保留原因码，区分「没读详情 / 没详情源 / 没权限 / 解析失败 / 正文缺失」。
  noteContentReason: XhsNoteBodyReason | null;
  // 单篇曝光/涨粉：首版不承诺，始终 unknown（§6.2）。
  noteImpressions: XhsCapabilityState;
  followerTotal: XhsCapabilityState;
  // 会话实测有效期（§6.4）：未实测时为 null，不编造。
  sessionTtlObserved: string | null;
  detectedAt: string;
  adapterVersion: string;
  mappingVersion: number;
}

export interface XhsIdentity {
  externalAccountKey: string;
  redId: string;
}

// 一次签名列表请求能核验出的两项能力。分开报告，便于只提升确实核验过的那一项。
export interface XhsListCapabilities {
  listReadable: boolean;
  perNoteMetricsReadable: boolean;
}

// CF-PS-07：单篇正文事实。列表接口不含正文，正文必须走详情读取。
// 「缺失」用 present:false + reason 表示，绝不把「没有」写成空串或 0（§9.2）。
export type XhsNoteBodyReason =
  | 'detail_not_read'
  | 'detail_source_missing'
  | 'permission_denied'
  | 'read_failed'
  | 'parse_failed'
  | 'body_absent'
  | 'empty_body';

export interface XhsNoteBodyFact {
  noteId: string;
  present: boolean;
  text: string | null;
  reason: XhsNoteBodyReason | null;
}

export interface XhsNoteContentProbe {
  readable: boolean;
  reason: XhsNoteBodyReason | null;
  fact: XhsNoteBodyFact;
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
  // 列表解析阶段一律「尚未读详情」；由 attachNoteBodies 成功后回填。
  body: XhsNoteBodyFact;
}

export type XhsNoteStatus = 'published' | 'draft' | 'reviewing' | 'hidden' | 'deleted' | 'unknown';

export interface XhsDiscoveryResult {
  notes: XhsNoteFact[];
  pagesRead: number;
  hasMore: boolean;
  nextCursor: string | null;
  // 覆盖说明：读了几页、是否因预算或结构不完整提前结束。
  coverage: { pages_read: number; has_more: boolean; incomplete_reason: string | null; skipped_pages?: number };
  duplicates: number;
  invalidRows: number;
  enumerationComplete: boolean;
  totalCount: number | null;
}

// 只读响应源：由 CDP 会话在接入后实现；适配器只调用它取 JSON，不自己发请求。
export interface ReadOnlyResponseSource {
  fetchJSON(path: string): Promise<unknown>;
  // fetchSigned 用于需要平台签名的接口（如笔记列表）：由实现方让页面自己发起请求
  // 并监听响应，适配器仍然只关心“拿到 JSON”。不提供时回退到 fetchJSON。
  fetchSigned?(path: string): Promise<unknown>;
  // fetchSignedNextPage 取签名列表的**下一批**：同一个列表页里让页面自己加载下一页
  // （滚动列表到底），仍然只监听页面自己发出的请求，不构造签名、不重新导航。
  //
  // 为什么需要它：小红书的 posted 接口只认页面自己发的请求，且分页参数由页面掌握。
  // 2026-10-26 实测——只导航一次只能拿到第一页 10 条，滚动列表容器会依次发出
  // page=1/2/3，读到 39 条（与平台自报一致）。没有这个能力位时适配器退回逐页导航，
  // 平台忽略页码就会得到 page_repeated。
  // 返回 null 表示“平台没有再给出下一批”（列表已到底）。
  fetchSignedNextPage?(path: string): Promise<unknown | null>;
  // CF-PS-07：单篇详情只读源。列表响应不含正文，正文事实只能由详情读取给出。
  // 请求本身由宿主（CDP 会话 / worker）按已实测契约发起，适配器只消费 JSON，
  // 不构造平台 URL、不猜测 endpoint；未提供时能力保持 unknown 并留原因码。
  fetchNoteDetail?(noteId: string): Promise<unknown>;
  // CF-P2-CXEF-06：指定笔记的评论只读源。与详情源同样由宿主按已实测契约注入；
  // 适配器不臆造评论 endpoint、不读取所选笔记之外的页面（docs/27 C09/W17c 边界）。
  // 未提供时返回 comment_source_missing，不冒充「已授权读取」。
  fetchComments?(noteId: string): Promise<unknown>;
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
  // 会话实测有效期：只在真正做过“扫码到失效”实测时传入，未实测保持 null。
  sessionTtlObserved?: string | null;
  // CF-PS-07：必须来自 probeNoteContent 的真实详情探测；不传或不可读时保持 unknown。
  noteContent?: XhsNoteContentProbe | null;
}): XhsCapabilities {
  const creator = input.identity ? 'supported' : input.mainSiteLoggedIn ? 'denied' : 'unknown';
  const listState: XhsCapabilityState = creator === 'supported' && input.postedNotesReadable ? 'supported'
    : creator === 'supported' ? 'temporarily_unavailable' : 'unknown';
  return {
    mainSiteLogin: input.mainSiteLoggedIn ? 'supported' : 'unknown',
    creatorLogin: creator,
    workList: listState,
    perNoteMetrics: listState,
    // CF-PS-04：键必须存在且如实上报；服务端 platformSyncCapabilityState 对 xhs 的
    // content 能力读的就是这个键。CF-PS-07：只有确实读到过非空正文才允许 supported，
    // 权限不足 / 解析失败 / 无详情源一律 unknown 且保留原因码，禁止硬写 supported。
    noteContent: input.noteContent?.readable === true ? 'supported' : 'unknown',
    noteContentReason: input.noteContent?.readable === true
      ? null
      : (input.noteContent?.reason ?? 'detail_not_read'),
    // 未实测的字段保持 unknown，不声称已支持。
    noteImpressions: 'unknown',
    followerTotal: creator === 'supported' && input.followerInfoReadable ? 'supported' : 'unknown',
    // 未实测时明确为 null，不写“未知”也不写猜测值。
    sessionTtlObserved: input.sessionTtlObserved ?? null,
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
    shares: count(n.shared_count),
    // 列表阶段没有正文：显式「尚未读详情」，不是空串，也不是空正文。
    body: { noteId, present: false, text: null, reason: 'detail_not_read' }
  };
}

// parsePostedNotesPage 解析一页列表；同时给出本页的游标信息，供调用方决定是否继续。
export function parsePostedNotesPage(payload: unknown): {
  notes: XhsNoteFact[];
  page: number | null;
  cursor: string | null;
  hasMore: boolean;
  paginationVerified: boolean;
  totalCount: number | null;
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
  const paginationVerified = page !== null || !!data && ('cursor' in data || 'next_cursor' in data);
  const hasMore = cursor !== null ? true : page !== null ? page >= 0 : false;
  const totalRaw = data?.total_count ?? data?.total;
  const totalCount = typeof totalRaw === 'number' && Number.isInteger(totalRaw) && totalRaw >= 0 ? totalRaw : null;
  // 整页都解析不出来且平台声称有数据：结构变化，不能当作“没有作品”。
  if (notes.length === 0 && invalidRows > 0) {
    throw new XhsAdapterError('platform_schema_changed', '笔记列表结构已变化');
  }
  return { notes, page, cursor, hasMore, paginationVerified, totalCount, invalidRows };
}

// probePostedNotesReadable 仅核验首页目录结构，不分页、不保存作品；
// 必须走创作中心自己发起的签名 GET，不能退回客户端构造请求。
export async function probePostedNotesReadable(source: ReadOnlyResponseSource): Promise<boolean> {
  const probe = await probePostedNotesCapabilities(source);
  return probe.listReadable;
}

// probePostedNotesCapabilities 用**同一次**签名列表请求同时核验两件事：目录可读、单篇指标可读。
//
// 为什么合并：单篇指标（观看/点赞/收藏/评论/分享）本来就随列表响应一起返回
// （见 normalizeNote 与 noteToObservation），不需要额外接口。分两次请求会连发两个
// 签名 GET，违反 §13.1「相邻请求至少间隔 5 秒」；合成一次既满足节奏要求，
// 又避免"只核验了列表就顺带声称指标可读"或反过来漏掉指标核验。
//
// 单篇指标可读的判定：至少一篇**已发布**作品带出至少一个可解释的计数。
// 草稿/审核中没有指标；整页都没有计数说明该账号或接口未给出指标，此时保持未核验，
// 不虚报 supported（§6.2）。
export async function probePostedNotesCapabilities(source: ReadOnlyResponseSource): Promise<XhsListCapabilities> {
  if (!source.fetchSigned) {
    throw new XhsAdapterError('platform_capability_denied', '作品列表核验需要创作中心签名请求');
  }
  const payload = await source.fetchSigned(`${XHS_API.postedNotes}?page=0&page_size=20`);
  const parsed = parsePostedNotesPage(payload);
  const body = payload as { data?: unknown } | null;
  const data = (body?.data ?? payload) as Record<string, unknown> | null;
  if (!data || (!Array.isArray(data.notes) && !Array.isArray(data.items)) || parsed.invalidRows > 0) {
    throw new XhsAdapterError('platform_schema_changed', '作品列表结构尚未通过核验');
  }
  const perNoteMetricsReadable = parsed.notes.some((note) => note.status === 'published'
    && [note.viewTimes, note.likes, note.favorites, note.comments, note.shares].some((value) => value !== null));
  return { listReadable: true, perNoteMetricsReadable };
}

// collectPostedNotes 跨页收集并按 note_id 去重；到达页数上限或没有下一页时停止，
// 并如实报告覆盖，不能只读第一页就宣称已同步全部（§6.2）。
export async function collectPostedNotes(
  source: ReadOnlyResponseSource,
  options: {
    maxPages?: number;
    startPage?: number;
    // page 形态每页请求的页码；prefix 用于把分页参数拼到路径上。
    buildPath?: (state: { page: number; cursor: string | null }) => string;
  } = {}
): Promise<XhsDiscoveryResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 3, 3));
  const buildPath = options.buildPath ?? ((s: { page: number; cursor: string | null }) =>
    s.cursor ? `${XHS_API.postedNotes}?cursor=${encodeURIComponent(s.cursor)}` : `${XHS_API.postedNotes}?page=${s.page}&page_size=20`);
  const startPage = Math.max(0, Math.floor(options.startPage ?? 0));
  // 有滚动加载能力时，后续页靠“让列表自己加载下一批”推进；没有则退回逐页导航。
  const canScroll = typeof source.fetchSignedNextPage === 'function';
  const seen = new Map<string, XhsNoteFact>();
  let duplicates = 0;
  let pagesRead = 0;
  let skippedPages = 0;
  let page = startPage;
  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let hasMore = false;
  let paginationVerified = false;
  let totalCount: number | null = null;
  let invalidRows = 0;
  let incompleteReason: string | null = null;
  // 断点续采要把列表滚过 startPage 页才开始计数，这里给总循环一个硬上限，
  // 避免 checkpoint 里出现异常大的 next_page 时无限滚动。
  const maxIterations = maxPages + startPage + 1;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (pagesRead >= maxPages) {
      incompleteReason = 'page_budget';
      break;
    }
    const path = buildPath({ page, cursor });
    // 第一页用导航触发；之后的页必须交给 fetchSignedNextPage。
    // 重新导航会让平台回到第一页，这正是 `page_repeated` 的来源（2026-10-26 实测：
    // 导航只给第一页 10 条，滚动列表容器依次给出 page=1/2/3，读到 39 条）。
    const useScroll = canScroll && pagesRead + skippedPages > 0;
    const payload = useScroll
      ? await source.fetchSignedNextPage!(path)
      : source.fetchSigned
        ? await source.fetchSigned(path)
        : await source.fetchJSON(path);
    // 滚动到底时页面不再发请求，fetchSignedNextPage 返回 null：这就是“没有更多”，
    // 不是错误，也不该算作读过一页（否则 coverage.pages_read 会虚高）。
    if (payload === null) {
      hasMore = false;
      break;
    }
    const parsed = parsePostedNotesPage(payload);
    paginationVerified ||= parsed.paginationVerified;
    if (parsed.totalCount !== null) totalCount = parsed.totalCount;
    hasMore = parsed.hasMore;
    cursor = parsed.cursor;
    // 断点续采：滚动形态下起始页之前的页只用来把列表滚到断点位置，不计入本次覆盖、
    // 不收作品；否则续跑的 run 会把前几页重复计入，next_page 永远推不动。
    // 逐页导航形态不需要跳过——它本来就按 page=startPage 直接请求那一页。
    if (canScroll && skippedPages < startPage) {
      skippedPages += 1;
      previousCursor = parsed.cursor;
      if (!hasMore) break;
      if (cursor === null) page += 1;
      continue;
    }
    pagesRead += 1;
    invalidRows += parsed.invalidRows;
    // 上一页已有的编号在本页再次出现时计数；整页全是重复则说明平台没有推进。
    let pageNew = 0;
    for (const note of parsed.notes) {
      if (seen.has(note.noteId)) {
        duplicates += 1;
        continue;
      }
      seen.set(note.noteId, note);
      pageNew += 1;
    }
    if (parsed.invalidRows > 0) {
      incompleteReason = 'catalog_inconsistent';
      break;
    }
    // 游标与上一页完全相同说明平台没有推进：停止并如实标记，避免无限循环。
    if (parsed.hasMore && parsed.cursor !== null && parsed.cursor === previousCursor) {
      incompleteReason = 'cursor_stalled';
      break;
    }
    // 页形态兜底：这一页非空但没有任何新编号，说明平台恒回同一页（page 参数被忽略）。
    // 实测小红书在只有一页时会回 `page:-1`（已由 hasMore 拦住），但其它形态下
    // page>=0 却恒回同一批数据时若不拦就会重复请求到页数上限。
    if (parsed.notes.length > 0 && pageNew === 0) {
      incompleteReason = 'page_repeated';
      break;
    }
    previousCursor = parsed.cursor;
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
    coverage: {
      pages_read: pagesRead,
      has_more: hasMore,
      incomplete_reason: incompleteReason,
      ...(skippedPages > 0 ? { skipped_pages: skippedPages } : {})
    },
    duplicates,
    invalidRows,
    enumerationComplete: invalidRows === 0 && !hasMore && incompleteReason === null && paginationVerified,
    totalCount
  };
}

// ---------- 单篇正文（CF-PS-07） ----------

// 详情页可能把正文放在哪几个中性键里；这只是「拿到 JSON 后怎么找」的解析约定，
// 不是对平台字段的实测声明。刻意不采用裸的正文原文字段名：CF-PS-04 守卫会锁住
// 「适配器不得出现那种字段名」，本项用 present 标记的事实对象取代它。
const XHS_NOTE_BODY_KEYS: ReadonlyArray<string> = Object.freeze(['desc', 'content', 'body', 'text']);

function absentBody(noteId: string, reason: XhsNoteBodyReason): XhsNoteBodyFact {
  return { noteId, present: false, text: null, reason };
}

// 详情响应常见包装：envelope.data / data.note / data.note_detail / data.items[0]。
function noteDetailData(payload: Record<string, unknown>): Record<string, unknown> | null {
  const inner = payload.data;
  const base = inner && typeof inner === 'object' ? inner as Record<string, unknown> : payload;
  const note = base.note && typeof base.note === 'object' ? base.note as Record<string, unknown>
    : base.note_detail && typeof base.note_detail === 'object' ? base.note_detail as Record<string, unknown>
      : null;
  if (note) return note;
  if (Array.isArray(base.items) && base.items.length > 0 && base.items[0] && typeof base.items[0] === 'object') {
    return base.items[0] as Record<string, unknown>;
  }
  return base;
}

function detailPermissionDenied(payload: Record<string, unknown>): boolean {
  if (payload.success === false) return true;
  const code = payload.code;
  if (code === 401 || code === 403 || code === '401' || code === '403') return true;
  const msg = typeof payload.msg === 'string' ? payload.msg
    : typeof payload.message === 'string' ? payload.message : '';
  return /未登录|登录失效|验证|权限|无权|unauthor|forbidden/i.test(msg);
}

// parseNoteBody 是纯解析：把所有「读不到」统一收敛成 present:false + 原因码，
// 调用方不需要靠 try/catch 猜语义。只有非空的字符串正文才算确实可读。
export function parseNoteBody(noteId: string, payload: unknown): XhsNoteBodyFact {
  if (typeof noteId !== 'string' || noteId === '') return absentBody(String(noteId ?? ''), 'parse_failed');
  if (!payload || typeof payload !== 'object') return absentBody(noteId, 'parse_failed');
  const envelope = payload as Record<string, unknown>;
  if (detailPermissionDenied(envelope)) return absentBody(noteId, 'permission_denied');
  const data = noteDetailData(envelope);
  if (!data) return absentBody(noteId, 'parse_failed');
  for (const key of XHS_NOTE_BODY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const raw = data[key];
    if (typeof raw !== 'string') return absentBody(noteId, 'parse_failed');
    // 空串是「明确给了空正文」，不是「字段缺失」；两者都保持 present:false，但原因码不同。
    if (raw.trim() === '') return absentBody(noteId, 'empty_body');
    return { noteId, present: true, text: raw, reason: null };
  }
  // 详情结构可解析但根本没有正文键：如实报缺失，绝不回一个空串冒充正文。
  return absentBody(noteId, 'body_absent');
}

// readNoteBody 调用注入的详情只读源。没有详情源、被平台拒绝、读取抛错一律
// 返回「不可读 + 原因码」，不抛出、不冒充空正文，也不改能力状态。
export async function readNoteBody(source: ReadOnlyResponseSource, noteId: string): Promise<XhsNoteBodyFact> {
  if (typeof source.fetchNoteDetail !== 'function') return absentBody(noteId, 'detail_source_missing');
  let payload: unknown;
  try {
    payload = await source.fetchNoteDetail(noteId);
  } catch (error) {
    const code = error instanceof XhsAdapterError ? error.code : '';
    const denied = code === 'platform_login_required' || code === 'platform_capability_denied'
      || code === 'platform_permission_denied';
    return absentBody(noteId, denied ? 'permission_denied' : 'read_failed');
  }
  return parseNoteBody(noteId, payload);
}

// probeNoteContent 是唯一允许把 noteContent 抬成 supported 的入口：
// 必须有详情源、必须真的读到非空正文。其余情况 readable=false 且带原因码。
export async function probeNoteContent(source: ReadOnlyResponseSource, noteId: string): Promise<XhsNoteContentProbe> {
  const fact = await readNoteBody(source, noteId);
  return { readable: fact.present && fact.text !== null, reason: fact.reason, fact };
}

// attachNoteBodies 逐篇回填正文事实。默认只探测 1 篇（能力核验够用），
// 不提供「全部采集」入口（D-117）；未探测到的条目保持列表阶段的 detail_not_read。
export async function attachNoteBodies(
  source: ReadOnlyResponseSource,
  notes: readonly XhsNoteFact[],
  options: { maxNotes?: number } = {}
): Promise<XhsNoteFact[]> {
  const limit = Math.max(0, Math.min(Math.floor(options.maxNotes ?? 1), notes.length));
  const out: XhsNoteFact[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    out.push(i < limit ? { ...note, body: await readNoteBody(source, note.noteId) } : note);
  }
  return out;
}

// ---------- 评论事实（CF-P2-CXEF-06） ----------

// 结论前置：本段只交付「注入式 mock 评论事实 + 单条结果信封」。真账号授权读取链路、
// 服务端同步票据接线、UI 授权文案都未做；不声称评论采集已可用。
export const XHS_COMMENT_FACT_SCHEMA = 'cxef06-comment-facts-v1';

export type XhsCommentReason =
  | 'comment_source_missing'
  | 'permission_denied'
  | 'read_failed'
  | 'parse_failed'
  | 'comment_absent'
  | 'body_absent'
  | 'empty_body';

// 六个字段逐个打 present 标记：没有这个事实就是 null + false，绝不补空串（§9.2）。
export interface XhsCommentPresence {
  comment_id: boolean;
  note_id: boolean;
  author: boolean;
  body: boolean;
  published_at: boolean;
  parent_comment_id: boolean;
}

export interface XhsCommentFact {
  comment_id: string;
  note_id: string;
  author: string | null;
  body: string | null;
  published_at: string | null;
  parent_comment_id: string | null;
  present: XhsCommentPresence;
  reason: XhsCommentReason | null;
}

export interface XhsCommentReadResult {
  facts: XhsCommentFact[];
  reason: XhsCommentReason | null;
}

// 服务端 ingestPlatformCommentResultTx 消费的同形信封；items 恒为 1 条。
export interface XhsCommentResult {
  schema: string;
  platform: string;
  external_account_key: string;
  items: XhsCommentFact[];
}

// 中性键约定，不是对平台字段的实测声明；真实契约须由 20/21 验证后由宿主提供。
const XHS_COMMENT_ID_KEYS: ReadonlyArray<string> = Object.freeze(['id', 'comment_id']);
const XHS_COMMENT_BODY_KEYS: ReadonlyArray<string> = Object.freeze(['content', 'text']);
const XHS_COMMENT_TIME_KEYS: ReadonlyArray<string> = Object.freeze(['time', 'create_time', 'published_at']);

function firstNonEmptyString(row: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    return null;
  }
  return null;
}

function commentAuthor(row: Record<string, unknown>): string | null {
  const container = row.user_info && typeof row.user_info === 'object' ? row.user_info as Record<string, unknown>
    : row.user && typeof row.user === 'object' ? row.user as Record<string, unknown> : row;
  return firstNonEmptyString(container, ['nickname']);
}

function commentBodyFact(row: Record<string, unknown>): { value: string | null; present: boolean; reason: XhsCommentReason | null } {
  for (const key of XHS_COMMENT_BODY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const raw = row[key];
    if (typeof raw !== 'string') return { value: null, present: false, reason: 'parse_failed' };
    if (raw.trim() === '') return { value: null, present: false, reason: 'empty_body' };
    return { value: raw, present: true, reason: null };
  }
  return { value: null, present: false, reason: 'body_absent' };
}

function parseCommentFact(noteId: string, raw: unknown): XhsCommentFact {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const commentId = firstNonEmptyString(row, XHS_COMMENT_ID_KEYS);
  // note_id 只认响应里真实给出的值；不从请求参数反推，避免把「缺字段」伪装成事实。
  const noteIdValue = firstNonEmptyString(row, ['note_id']);
  const author = commentAuthor(row);
  const body = commentBodyFact(row);
  const publishedAt = firstNonEmptyString(row, XHS_COMMENT_TIME_KEYS);
  const parent = firstNonEmptyString(row, ['parent_comment_id']);
  const reason: XhsCommentReason | null = commentId === null ? 'parse_failed' : body.reason;
  return {
    comment_id: commentId ?? '',
    note_id: noteIdValue ?? '',
    author,
    body: body.value,
    published_at: publishedAt,
    parent_comment_id: parent,
    present: {
      comment_id: commentId !== null,
      note_id: noteIdValue !== null,
      author: author !== null,
      body: body.present,
      published_at: publishedAt !== null,
      parent_comment_id: parent !== null
    },
    reason
  };
}

// parseCommentFacts 是纯解析：读不到 / 被拒 / 结构坏 / 空列表都收敛成原因码，
// 不抛异常、不返回假事实。noteId 只用于定位所选笔记，不参与字段推断。
export function parseCommentFacts(noteId: string, payload: unknown): XhsCommentReadResult {
  if (typeof noteId !== 'string' || noteId === '') return { facts: [], reason: 'parse_failed' };
  if (!payload || typeof payload !== 'object') return { facts: [], reason: 'parse_failed' };
  const envelope = payload as Record<string, unknown>;
  if (detailPermissionDenied(envelope)) return { facts: [], reason: 'permission_denied' };
  const inner = envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : envelope;
  const list = Array.isArray(inner.comments) ? inner.comments : Array.isArray(inner.items) ? inner.items : null;
  if (!list) return { facts: [], reason: 'parse_failed' };
  if (list.length === 0) return { facts: [], reason: 'comment_absent' };
  return { facts: list.map((raw) => parseCommentFact(noteId, raw)), reason: null };
}

// readCommentFacts 调用注入源。未提供源、被平台拒绝、读取抛错一律返回原因码。
export async function readCommentFacts(source: ReadOnlyResponseSource, noteId: string): Promise<XhsCommentReadResult> {
  if (typeof source.fetchComments !== 'function') return { facts: [], reason: 'comment_source_missing' };
  let payload: unknown;
  try {
    payload = await source.fetchComments(noteId);
  } catch (error) {
    const code = error instanceof XhsAdapterError ? error.code : '';
    const denied = code === 'platform_login_required' || code === 'platform_capability_denied'
      || code === 'platform_permission_denied';
    return { facts: [], reason: denied ? 'permission_denied' : 'read_failed' };
  }
  return parseCommentFacts(noteId, payload);
}

// commentDedupeId 与服务端 platformCommentDedupeID 同算法；共享 fixture 的 dedupe_id
// 同时钉住两端。同一条平台评论重复上报时服务端靠这个 uuid 主键幂等，无需外部 ID 列。
export function commentDedupeId(platform: string, externalAccountKey: string, commentId: string): string {
  const digest = createHash('sha256')
    .update(['CF-P2-CXEF-06', platform, externalAccountKey, commentId].join('\x1f'), 'utf8')
    .digest('hex');
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32)].join('-');
}

// toCommentResult 一次只出一条：不可读事实直接返回 null，绝不把整批评论打包成批量入库
// （D-117）。调用方按用户逐条动作逐次调用，本模块不提供「全部入库」入口。
export function toCommentResult(
  platform: string,
  externalAccountKey: string,
  facts: readonly XhsCommentFact[],
  index = 0
): XhsCommentResult | null {
  const fact = facts[index];
  if (!fact || fact.reason !== null || !fact.present.comment_id || !fact.present.note_id ||
    !fact.present.body || fact.body === null) return null;
  return { schema: XHS_COMMENT_FACT_SCHEMA, platform, external_account_key: externalAccountKey, items: [fact] };
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
  // 单位口径与后端 metric_unit 对齐（20 文档 §9.1）：count/times/users/unknown。
  // 早期这里写成 'count' | 'unknown'，等于在编译期把口径钉死，导致 share_times
  // 无法上报 times（它语义是"分享次数"）——服务端 share_unit 的 CHECK 只接受
  // users/times/unknown，上报 count 会让确认投影抛 23514、整条事务回滚。
  const put = (key: string, value: number | null, unit: 'count' | 'times' | 'users' | 'unknown', path: string) => {
    if (value === null) return;
    values[key] = { value, precision: 'exact', unit };
    fieldPaths[key] = path;
  };
  // view_count 页面标签为“观看”，单位未确认前按 unknown 存观测，不投影 reads（D-129 v0.4）。
  put('view_times', note.viewTimes, 'unknown', 'fixture.note.view_count');
  put('like_count', note.likes, 'count', 'fixture.note.likes');
  put('favorite_count', note.favorites, 'count', 'fixture.note.collected_count');
  put('comment_count', note.comments, 'count', 'fixture.note.comments_count');
  // share_times 是"分享次数"，单位必须是 times：`metric_snapshot.share_unit`
  // 的 CHECK 只接受 users/times/unknown，且服务端要求观测单位与映射登记一致。
  // 早期这里标成 count，导致逐条确认时投影 INSERT 抛 23514、整条事务回滚
  // （2026-10-22 实测：10 篇观测确认全部 500）。
  put('share_times', note.shares, 'times', 'fixture.note.shared_count');
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
    field_paths: fieldPaths,
    // 平台侧的发布时间（笔记列表接口的 `time` 字段）。
    // 服务端用它回填 `work.published_at`——`metric_day_offset`（D1/D3/D7 天数）
    // 完全依赖它，缺了就全部算成 0，按天对比的指标失真
    // （公众号适配器就是漏了这一步，DEV-PS49 已修）。
    // 解析失败就不带该字段：宁可保持原值，也不写错时间。
    ...(normalizeXhsNoteTime(note.recordedAt) ? { platform_published_at: normalizeXhsNoteTime(note.recordedAt)! } : {})
  };
}

// normalizeXhsNoteTime 把小红书笔记时间转成 RFC3339，识别不出来返回 null。
//
// 该字段实测形态不统一：可能是 Unix 秒、Unix 毫秒，也可能是
// `YYYY-MM-DD HH:mm[:ss]`（北京时间裸串）。三种都要接受，
// 但**不能猜**——超出合理区间的数值一律返回 null。
export function normalizeXhsNoteTime(raw: string | number | null): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // 纯数字：按毫秒/秒两种量级判断（毫秒 13 位、秒 10 位）。
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = trimmed.length >= 12 ? n : n * 1000;
    // 合理区间：2015-01-01 之后、明天之前。
    if (ms < 1420070400000 || ms > Date.now() + 24 * 3600 * 1000) return null;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  // 已带时区的 ISO 串：直接归一化。
  if (/T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  // 北京时间裸串 `YYYY-MM-DD HH:mm[:ss]`：显式按 +08:00 解释，避免依赖本机时区。
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 3600 * 1000;
  const back = new Date(utcMillis + 8 * 3600 * 1000);
  // 反向校验，防止 `2026-02-31` 被 Date 悄悄进位。
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return new Date(utcMillis).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
