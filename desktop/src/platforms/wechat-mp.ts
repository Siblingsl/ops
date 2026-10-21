// 微信公众号适配器（D-129 / 20 文档 §6.1、§6.3、§17.1.1）。
//
// 只实现固定动作：verifyIdentity / probeCapabilities / discoverWorks / collectMetrics /
// parseArticleLink / disconnectLocal。只使用 §17.1.1 已实测确认的接口与字段：
//   /cgi-bin/switchacct           → biz_list.list[] 的 bizuin、username（gh_…）、is_admin
//   /cgi-bin/appmsgpublish        → publish_page.publish_list[].publish_info.appmsg_info[]
//                                   的 appmsgid、itemidx、title、content_url、is_deleted、
//                                   read_num、like_num、old_like_num、share_num、comment_num
//   发送时间在 sent_info.time。
//
// 文章编号固定为 <appmsgid>_<itemidx>：发表记录里“仅发表”项的 msgid 是内部序号，
// 与文章无关，不能当编号（§6.3、D-129 v0.4）。
//
// 本文件是纯解析与映射：网络读取由注入的只读响应源完成，测试全部走 fixture，不访问真实平台。

import type { PlatformObservationDraft } from '../platform-client';
import { isPrivateHost } from '../platform-worker';
import { parseCount, type ReadOnlyResponseSource } from './xhs';

export const WECHAT_MP_ADAPTER_VERSION = 'wechat-mp-1';
export const WECHAT_MP_MAPPING_VERSION = 1;
export const WECHAT_MP_API = Object.freeze({
  switchAccount: '/cgi-bin/switchacct',
  publishedList: '/cgi-bin/appmsgpublish'
});

// 允许解析的公众号域名；短链解析只在允许域名内做有限跳转（§6.3）。
export const WECHAT_MP_HOSTS: ReadonlyArray<string> = Object.freeze(['mp.weixin.qq.com']);

export type WechatCapabilityState = 'supported' | 'denied' | 'unknown' | 'temporarily_unavailable';

export interface WechatCapabilities {
  backendLogin: WechatCapabilityState;
  publishedList: WechatCapabilityState;
  perArticleMetrics: WechatCapabilityState;
  // 单篇明细（/misc/appmsganalysis?action=get_article_list）对样本账号返回空，首版不承诺。
  articleDetail: WechatCapabilityState;
  // 按日趋势是账号级区间数据，首版不上传（§9.1）。
  accountTrend: WechatCapabilityState;
  dataLatency: 'next_day' | 'unknown';
  detectedAt: string;
  adapterVersion: string;
  mappingVersion: number;
}

export interface WechatIdentity {
  externalAccountKey: string;
  // 原始 ID（gh_…）：与 OPS 账号已登记值核对，是身份的第二重证据。
  originalID: string;
  isAdmin: boolean;
}

export type WechatArticleStatus = 'published' | 'deleted' | 'unknown';

// 一篇公众号文章在发表记录中的位置与计数。
export interface WechatArticleFact {
  appmsgID: string;
  itemIndex: number;
  // 稳定编号 <appmsgid>_<itemidx>，即 wechat_msgid。
  externalID: string;
  title: string;
  contentURL: string | null;
  sentAt: string | null;
  status: WechatArticleStatus;
  // “仅发表、未群发”记录与群发记录同样当作已发布作品（D-129）。
  publishOnly: boolean;
  readNum: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface WechatDiscoveryResult {
  articles: WechatArticleFact[];
  pagesRead: number;
  hasMore: boolean;
  nextCursor: string | null;
  coverage: { pages_read: number; has_more: boolean; incomplete_reason: string | null; total_count?: number | null };
  duplicates: number;
  invalidRows: number;
}

export class WechatAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WechatAdapterError';
    this.code = code;
  }
}

// ---------- 身份 ----------

// parseIdentity 从 biz_list 里取当前公众号：优先 is_admin 的条目，
// 没有管理员条目时取第一条；始终要求 bizuin 与原始 ID 同时存在。
export function parseIdentity(payload: unknown): WechatIdentity {
  const body = payload as { biz_list?: unknown } | null;
  const list = (body?.biz_list as { list?: unknown } | undefined)?.list;
  if (!Array.isArray(list) || list.length === 0) {
    throw new WechatAdapterError('platform_login_required', '公众号后台未返回可用的账号列表');
  }
  const entries = list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (entries.length === 0) {
    throw new WechatAdapterError('platform_login_required', '公众号后台未返回可用的账号列表');
  }
  const admin = entries.find((e) => e.is_admin === true || e.is_admin === 1);
  const chosen = admin ?? entries[0];
  const bizuin = typeof chosen.bizuin === 'string' ? chosen.bizuin.trim()
    : typeof chosen.bizuin === 'number' ? String(chosen.bizuin) : '';
  const originalID = typeof chosen.username === 'string' ? chosen.username.trim() : '';
  if (!bizuin) {
    throw new WechatAdapterError('platform_identity_mismatch', '无法取得公众号的稳定账号标识（bizuin）');
  }
  // 只有昵称、拿不到原始 ID 时不能开启自动采用（§6.3）。
  if (!/^gh_[0-9a-zA-Z]+$/.test(originalID)) {
    throw new WechatAdapterError('platform_identity_mismatch', '无法核对公众号原始 ID，不能启用自动采集');
  }
  return {
    externalAccountKey: `wechat_biz:${bizuin}`,
    originalID,
    isAdmin: admin !== undefined
  };
}

// verifyRegisteredOriginalID 核对平台返回的原始 ID 与 OPS 账号已登记值一致。
export function verifyRegisteredOriginalID(identity: WechatIdentity, registeredOriginalID: string): boolean {
  const want = registeredOriginalID.trim();
  if (!want) return false;
  return identity.originalID.toLowerCase() === want.toLowerCase();
}

export function probeCapabilities(input: {
  backendLoggedIn: boolean;
  identity: WechatIdentity | null;
  listReadable: boolean;
  now: string;
}): WechatCapabilities {
  const login: WechatCapabilityState = input.backendLoggedIn ? 'supported' : 'unknown';
  const identityOK = input.identity !== null;
  const listState: WechatCapabilityState = login === 'supported' && identityOK && input.listReadable
    ? 'supported'
    : login === 'supported' && identityOK ? 'temporarily_unavailable' : 'unknown';
  return {
    backendLogin: login,
    publishedList: listState,
    perArticleMetrics: listState,
    // 未实测/返回空的能力保持 unknown，不声称已支持。
    articleDetail: 'unknown',
    accountTrend: 'unknown',
    // 首页标注“数据统计时间：前一日 00:00–24:00”，分析数据次日更新（§17.1.1）。
    dataLatency: 'next_day',
    detectedAt: input.now,
    adapterVersion: WECHAT_MP_ADAPTER_VERSION,
    mappingVersion: WECHAT_MP_MAPPING_VERSION
  };
}

// ---------- 文章编号 ----------

// buildExternalID 拼接稳定编号。itemidx 必须是正整数：缺失或非法时整条拒绝，
// 不默认成 1，否则同一 appmsgid 下的不同文章会被合并。
export function buildExternalID(appmsgID: string, itemIndex: unknown): string | null {
  const id = typeof appmsgID === 'string' ? appmsgID.trim() : typeof appmsgID === 'number' ? String(appmsgID) : '';
  if (!/^\d{1,32}$/.test(id)) return null;
  const idx = typeof itemIndex === 'number' ? itemIndex : typeof itemIndex === 'string' ? Number(itemIndex.trim()) : NaN;
  if (!Number.isInteger(idx) || idx < 1 || idx > 999) return null;
  return `${id}_${idx}`;
}

// parseExternalID 反向解析，供服务端绑定校验与页面展示使用。
export function parseExternalID(externalID: string): { appmsgID: string; itemIndex: number } | null {
  const match = /^(\d{1,32})_([1-9]\d{0,2})$/.exec(externalID.trim());
  if (!match) return null;
  return { appmsgID: match[1], itemIndex: Number(match[2]) };
}

// ---------- 列表解析 ----------

function pickArticle(raw: unknown, sentAt: string | null, publishOnly: boolean): WechatArticleFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const externalID = buildExternalID(a.appmsgid as string, a.itemidx);
  if (!externalID) return null;
  const parsed = parseExternalID(externalID);
  if (!parsed) return null;
  const deleted = a.is_deleted === true || a.is_deleted === 1 || a.is_deleted === '1';
  const url = typeof a.content_url === 'string' && a.content_url.trim() !== '' ? a.content_url.trim() : null;
  return {
    appmsgID: parsed.appmsgID,
    itemIndex: parsed.itemIndex,
    externalID,
    title: typeof a.title === 'string' ? a.title : '',
    contentURL: url,
    sentAt,
    status: deleted ? 'deleted' : 'published',
    publishOnly,
    readNum: parseCount(a.read_num)?.value ?? null,
    // like_num 映射 likes；old_like_num 含义未确认，不映射 wows（§6.3）。
    likes: parseCount(a.like_num)?.value ?? null,
    comments: parseCount(a.comment_num)?.value ?? null,
    shares: parseCount(a.share_num)?.value ?? null
  };
}

// parsePublishPage 解析一页发表记录。每篇 appmsg_info 独立，多图文同一 appmsgid 下按 idx 区分。
export function parsePublishPage(payload: unknown): {
  articles: WechatArticleFact[];
  page: number | null;
  hasMore: boolean;
  totalCount: number | null;
  invalidRows: number;
} {
  const body = payload as { publish_page?: unknown; base_resp?: { ret?: unknown } } | null;
  // 平台把失败也回 200，靠 base_resp.ret 判断；非 0 时按未登录/受限处理，
  // 不返回空列表冒充“没有作品”。
  const ret = body?.base_resp?.ret;
  if (typeof ret === 'number' && ret !== 0) {
    throw new WechatAdapterError('platform_login_required', '公众号后台会话无效或要求验证');
  }
  // 实测：`publish_page` 是一个**嵌套的 JSON 字符串**，不是对象（2026-10-21）。
  // 两种形态都要接受，否则永远解析不出文章。
  const raw = body?.publish_page;
  let page: unknown = raw;
  if (typeof raw === 'string') {
    try {
      page = JSON.parse(raw);
    } catch {
      throw new WechatAdapterError('platform_schema_changed', '发表记录结构已变化');
    }
  }
  if (!page || typeof page !== 'object') {
    throw new WechatAdapterError('platform_login_required', '公众号后台未返回发表记录');
  }
  const p = page as Record<string, unknown>;
  const list = Array.isArray(p.publish_list) ? p.publish_list : [];
  const articles: WechatArticleFact[] = [];
  let invalidRows = 0;
  for (const record of list) {
    if (!record || typeof record !== 'object') {
      invalidRows += 1;
      continue;
    }
    const r = record as Record<string, unknown>;
    // 发送时间在 sent_info.time；缺失时为 null，不编造。
    const sentInfo = r.sent_info as Record<string, unknown> | undefined;
    const sentAt = sentInfo && typeof sentInfo.time === 'string' && sentInfo.time.trim() !== ''
      ? sentInfo.time.trim()
      : sentInfo && typeof sentInfo.time === 'number' ? String(sentInfo.time) : null;
    const publishType = typeof r.publish_type === 'number' ? r.publish_type : Number(r.publish_type);
    // publish_type=101 是“仅发表、未群发”，与群发一样当作已发布作品（D-129）。
    const publishOnly = publishType === 101;
    // `publish_info` 同样是嵌套 JSON 字符串。
    let info = r.publish_info as unknown;
    if (typeof info === 'string') {
      try {
        info = JSON.parse(info);
      } catch {
        invalidRows += 1;
        continue;
      }
    }
    const appmsgInfo = (info as Record<string, unknown> | undefined)?.appmsg_info;
    if (!Array.isArray(appmsgInfo)) {
      invalidRows += 1;
      continue;
    }
    for (const item of appmsgInfo) {
      const article = pickArticle(item, sentAt, publishOnly);
      if (article) articles.push(article);
      else invalidRows += 1;
    }
  }
  const total = typeof p.total_count === 'number' ? p.total_count : null;
  const pageNo = typeof p.page === 'number' ? p.page : typeof p.page_no === 'number' ? p.page_no : null;
  // 注意：单页只能看到“本页有数据”，判断不出全局是否还有更多。
  // 实测第 2 页（begin=10，返回 6 条，total=16）单看本页会得出 hasMore=true，
  // 但累计已达 16，应收口。因此真正判定放在 collectPublishedArticles 里按已收集数量与
  // total_count 比较；这里只用“本页非空”作为粗粒度信号，避免误导。
  const hasMore = articles.length > 0 && (total === null || total > articles.length);
  return { articles, page: pageNo, hasMore, totalCount: total, invalidRows };
}

// collectPublishedArticles 跨页收集并按稳定编号去重；页数上限 3 与 §10.1 一致。
export async function collectPublishedArticles(
  source: ReadOnlyResponseSource,
  options: { maxPages?: number; buildPath?: (state: { page: number }) => string } = {}
): Promise<WechatDiscoveryResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 3, 3));
  const buildPath = options.buildPath ?? ((s: { page: number }) => `${WECHAT_MP_API.publishedList}?sub=list&begin=${s.page * 10}&count=10&lang=zh_CN&f=json&ajax=1`);
  const seen = new Map<string, WechatArticleFact>();
  let duplicates = 0;
  let invalidRows = 0;
  let pagesRead = 0;
  let page = 0;
  let hasMore = false;
  let incompleteReason: string | null = null;
  let totalCount: number | null = null;
  for (;;) {
    if (pagesRead >= maxPages) {
      incompleteReason = 'page_budget';
      break;
    }
    const payload = await source.fetchJSON(buildPath({ page }));
    const parsed = parsePublishPage(payload);
    pagesRead += 1;
    invalidRows += parsed.invalidRows;
    if (parsed.totalCount !== null) totalCount = parsed.totalCount;
    for (const article of parsed.articles) {
      if (seen.has(article.externalID)) {
        duplicates += 1;
        continue;
      }
      seen.set(article.externalID, article);
    }
    // total_count 是总量：已收集够多就不再请求，避免按“本页有数据”无限翻页。
    if (totalCount !== null && seen.size >= totalCount) {
      hasMore = false;
      break;
    }
    hasMore = parsed.hasMore;
    if (!hasMore) break;
    page += 1;
  }
  return {
    articles: [...seen.values()],
    pagesRead,
    hasMore,
    nextCursor: hasMore ? String(page) : null,
    coverage: { pages_read: pagesRead, has_more: hasMore, incomplete_reason: incompleteReason, total_count: totalCount },
    duplicates,
    invalidRows
  };
}

// ---------- 观测映射 ----------

// articleToObservation 把一篇文章映射成观测。已删除文章不生成观测（§6.3），
// 也不因为列表缺失就推断删除。
export function articleToObservation(
  article: WechatArticleFact,
  input: { externalAccountKey: string; observedAt: string; bindingRevision?: number; publishRevision?: number }
): PlatformObservationDraft | null {
  if (article.status !== 'published') return null;
  const values: Record<string, unknown> = {};
  const fieldPaths: Record<string, string> = {};
  const put = (key: string, value: number | null, unit: 'count' | 'unknown', path: string) => {
    if (value === null) return;
    values[key] = { value, precision: 'exact', unit };
    fieldPaths[key] = path;
  };
  // read_num 与 share_num 单位未确认前按 unknown 存观测，不投影 reads/shares（§6.3）。
  put('read_times', article.readNum, 'unknown', 'fixture.article.read_num');
  put('like_count', article.likes, 'count', 'fixture.article.like_num');
  put('comment_count', article.comments, 'count', 'fixture.article.comment_num');
  put('share_times', article.shares, 'unknown', 'fixture.article.share_num');
  if (Object.keys(values).length === 0) return null;
  return {
    row_no: 0,
    scope: 'work',
    external_account_key: input.externalAccountKey,
    external_id: article.externalID,
    ...(input.bindingRevision !== undefined ? { binding_revision: input.bindingRevision } : {}),
    ...(input.publishRevision !== undefined ? { publish_revision: input.publishRevision } : {}),
    source: 'wechat_browser',
    temporal_kind: 'cumulative',
    observed_at: input.observedAt,
    // 列表计数是读取时的当前累计；数据延迟为次日更新，这里只记读取时刻。
    as_of_at: input.observedAt,
    adapter_version: WECHAT_MP_ADAPTER_VERSION,
    mapping_version: WECHAT_MP_MAPPING_VERSION,
    values,
    field_paths: fieldPaths
  };
}

// ---------- 文章链接 ----------

// extractArticleURL 从文本里取允许域名内的文章链接；取不到返回 null。
export function extractArticleURL(text: string): URL | null {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(text);
  if (!match) return null;
  let parsed: URL;
  try {
    parsed = new URL(match[0]);
  } catch {
    return null;
  }
  if (!WECHAT_MP_HOSTS.includes(parsed.hostname.toLowerCase())) return null;
  if (isPrivateHost(parsed.hostname)) return null;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  parsed.protocol = 'https:';
  return parsed;
}

// articleIDFromURL 从文章链接的 mid/idx 取稳定编号；短链（/s/xxx）不带编号，返回 null。
export function articleIDFromURL(url: URL): string | null {
  const mid = url.searchParams.get('mid');
  const idx = url.searchParams.get('idx');
  if (!mid || !idx) return null;
  return buildExternalID(mid, Number(idx));
}

// stripSessionParams 清掉后台 token 等会话参数，对外展示链接不带（§6.3）。
export function stripSessionParams(url: URL): string {
  const clean = new URL(url.toString());
  for (const key of ['token', 'lang', 'scene', 'subscene', 'clicktime', 'enterid', 'ascene', 'devicetype', 'version', 'nettype', 'abtest_cookie', 'key', 'pass_ticket', 'wx_header']) {
    clean.searchParams.delete(key);
  }
  return clean.toString();
}

// resolveArticleLink 在有界跳转内解析短链：最多 3 次、每次仅 HTTPS、每次仍在允许域名内。
// 解析不到稳定编号时抛出，交给调用方进入待绑定，不按标题入库（§6.3）。
export async function resolveArticleLink(
  text: string,
  resolve: (url: string) => Promise<{ url: string } | null>
): Promise<{ externalID: string; displayURL: string }> {
  const start = extractArticleURL(text);
  if (!start) {
    throw new WechatAdapterError('platform_historical_unavailable', '文本里没有可识别的公众号文章链接');
  }
  let current = start;
  for (let hop = 0; hop < 3; hop += 1) {
    const externalID = articleIDFromURL(current);
    if (externalID) {
      return { externalID, displayURL: stripSessionParams(current) };
    }
    const next = await resolve(current.toString());
    if (!next) break;
    let parsed: URL;
    try {
      parsed = new URL(next.url);
    } catch {
      break;
    }
    if (parsed.protocol !== 'https:' || !WECHAT_MP_HOSTS.includes(parsed.hostname.toLowerCase()) || isPrivateHost(parsed.hostname)) {
      throw new WechatAdapterError('platform_network_unavailable', '短链跳转到了不允许的地址');
    }
    current = parsed;
  }
  throw new WechatAdapterError('platform_historical_unavailable', '无法从链接解析出文章编号，请手工输入');
}

// verifyArticleOwner 核对文章链接里的 __biz 与连接的公众号 bizuin 一致：
// 编号相同但来源公众号不同，不能当作本人作品。
export function verifyArticleOwner(url: URL, bizuin: string): boolean {
  const biz = url.searchParams.get('__biz');
  if (!biz) return false;
  return biz.trim().toLowerCase() === bizuin.trim().toLowerCase();
}
