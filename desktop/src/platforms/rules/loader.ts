// OPT-E01：小红书平台适配规则包（RulePack）的安全加载器。
//
// 目标：把创作中心地址、页面锚点、CSS 选择器与回读字段路径从代码常量外置为
// 可版本化 JSON，允许本机热更新；但热更新文件永远是**不可信输入**：
//   * 只允许 https 的小红书官方域名（xiaohongshu.com / *.xiaohongshu.com）；
//   * api 路径只允许同源 /api/ 前缀；
//   * draft_save_texts 绝不允许包含「发布」字样（D-222 红线）；
//   * 任何超限、读取失败、JSON 语法错误或校验失败都不得抛错崩溃应用，
//     必须记录 fallbackReason 并回落到随包发布的内置 xhs.default.json。
//
// 本模块只读本地文件，不发请求、不接触页面，可在主进程与单测中直接使用。

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface XhsRulePackUrls {
  readonly creator_origin: string;
  readonly main_origin: string;
  readonly note_manager: string;
  readonly publish: string;
}

export interface XhsRulePackApiPaths {
  readonly user_info: string;
  readonly posted_notes: string;
  readonly personal_info: string;
  readonly comment_page: string;
}

export interface XhsRulePackAnchors {
  readonly account: string;
  readonly title: string;
  readonly editor: string;
  readonly prefill: ReadonlyArray<string>;
}

export interface XhsRulePackSelectors {
  readonly note_card: string;
  readonly note_card_covers: ReadonlyArray<string>;
  readonly title: ReadonlyArray<string>;
  readonly editor: ReadonlyArray<string>;
  readonly tag_input: ReadonlyArray<string>;
  readonly image_tab_container: string;
  readonly shadow_save_host: string;
  readonly shadow_save_button_class: string;
  readonly draft_save_texts: ReadonlyArray<string>;
  readonly image_tab_texts: ReadonlyArray<string>;
  readonly tag_chips: string;
}

export interface XhsObservationFieldPaths {
  readonly view_times: string;
  readonly like_count: string;
  readonly favorite_count: string;
  readonly comment_count: string;
  readonly share_times: string;
}

export interface XhsRulePackReadback {
  readonly note_body_keys: ReadonlyArray<string>;
  readonly comment_id_keys: ReadonlyArray<string>;
  readonly comment_body_keys: ReadonlyArray<string>;
  readonly comment_time_keys: ReadonlyArray<string>;
  readonly observation_field_paths: XhsObservationFieldPaths;
}

export interface XhsRulePack {
  readonly schema_version: 1;
  readonly platform: 'xhs';
  readonly adapter_version: string;
  readonly publish_adapter_version: string;
  readonly mapping_version: number;
  readonly updated_at: string;
  readonly urls: XhsRulePackUrls;
  readonly api_paths: XhsRulePackApiPaths;
  readonly share_hosts: ReadonlyArray<string>;
  readonly anchors: XhsRulePackAnchors;
  readonly selectors: XhsRulePackSelectors;
  readonly readback: XhsRulePackReadback;
}

export interface XhsRulePackLoadResult {
  readonly pack: XhsRulePack;
  readonly source: 'cache' | 'default';
  readonly cachePath?: string;
  readonly fallbackReason?: string;
}

export interface XhsRulePackLoadOptions {
  readonly cachePath?: string;
  readonly overrideDir?: string;
  readonly onFallback?: (reason: string) => void;
}

export type XhsRulePackValidationResult =
  | { readonly ok: true; readonly pack: XhsRulePack }
  | { readonly ok: false; readonly reason: string };

const RULE_PACK_FILE = 'xhs.default.json';
// 热更新文件体积上限：正常规则包不足 10 KiB，超过 256 KiB 一律视为异常输入。
const MAX_CACHE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNonEmptyString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[]
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path}.${key} 必须是非空字符串`);
    return '';
  }
  return value;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[]
): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}.${key} 必须是非空字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`${path}.${key}[${index}] 必须是非空字符串`);
      continue;
    }
    out.push(item);
  }
  return out;
}

// httpsHostError 同时拦截：非 https、带 username/password、非小红书官方域名。
// 不做“模糊包含”判断，避免 xiaohongshu.com.evil.example 这类后缀注入。
function httpsHostError(value: string, label: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} 不是合法 URL`;
  }
  if (parsed.protocol !== 'https:') {
    return `${label} 必须使用 https`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `${label} 不允许携带账号密码`;
  }
  const host = parsed.hostname.toLowerCase();
  if (!(host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'))) {
    return `${label} 域名必须是 xiaohongshu.com 或其子域`;
  }
  return null;
}

function shareHostError(value: string, label: string): string | null {
  if (/\s/.test(value) || value === '') return `${label} 不是合法域名`;
  const host = value.toLowerCase();
  if (host === 'xiaohongshu.com' || host === 'xhslink.com') return null;
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(host)) {
    return `${label} 不是合法域名`;
  }
  if (host.endsWith('.xiaohongshu.com') || host.endsWith('.xhslink.com')) return null;
  return `${label} 只允许 xiaohongshu.com / *.xiaohongshu.com / xhslink.com / *.xhslink.com`;
}

function apiPathError(value: string, label: string): string | null {
  if (!value.startsWith('/api/')) return `${label} 必须以 /api/ 开头`;
  if (value.includes('..')) return `${label} 不允许包含 ..`;
  if (value.includes('://')) return `${label} 不允许包含绝对地址`;
  if (/\s/.test(value)) return `${label} 不允许包含空白字符`;
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

// validateXhsRulePack 是纯函数：只做结构/类型/安全校验，不读文件、不抛异常。
// 返回的 pack 已深度冻结，防止运行期被意外改写。
export function validateXhsRulePack(raw: unknown): XhsRulePackValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: '规则包必须是 JSON 对象' };
  const errors: string[] = [];

  if (raw.schema_version !== 1) errors.push('schema_version 必须为 1');
  if (raw.platform !== 'xhs') errors.push('platform 必须为 xhs');
  const adapterVersion = readNonEmptyString(raw, 'adapter_version', 'rulepack', errors);
  const publishAdapterVersion = readNonEmptyString(raw, 'publish_adapter_version', 'rulepack', errors);
  const mappingVersion = raw.mapping_version;
  if (typeof mappingVersion !== 'number' || !Number.isInteger(mappingVersion) || mappingVersion <= 0) {
    errors.push('mapping_version 必须为正整数');
  }
  const updatedAt = readNonEmptyString(raw, 'updated_at', 'rulepack', errors);
  if (updatedAt !== '' && Number.isNaN(Date.parse(updatedAt))) {
    errors.push('updated_at 必须是可解析的有效日期');
  }

  const urlsRaw = raw.urls;
  const urls: XhsRulePackUrls = {
    creator_origin: '',
    main_origin: '',
    note_manager: '',
    publish: ''
  };
  if (!isRecord(urlsRaw)) {
    errors.push('urls 必须是对象');
  } else {
    const parsedUrls = {
      creator_origin: readNonEmptyString(urlsRaw, 'creator_origin', 'urls', errors),
      main_origin: readNonEmptyString(urlsRaw, 'main_origin', 'urls', errors),
      note_manager: readNonEmptyString(urlsRaw, 'note_manager', 'urls', errors),
      publish: readNonEmptyString(urlsRaw, 'publish', 'urls', errors)
    };
    Object.assign(urls, parsedUrls);
    for (const key of ['creator_origin', 'main_origin', 'note_manager', 'publish'] as const) {
      const value = parsedUrls[key];
      if (value === '') continue;
      const problem = httpsHostError(value, `urls.${key}`);
      if (problem) errors.push(problem);
    }
  }

  const apiRaw = raw.api_paths;
  const apiPaths: XhsRulePackApiPaths = {
    user_info: '',
    posted_notes: '',
    personal_info: '',
    comment_page: ''
  };
  if (!isRecord(apiRaw)) {
    errors.push('api_paths 必须是对象');
  } else {
    const parsedApi = {
      user_info: readNonEmptyString(apiRaw, 'user_info', 'api_paths', errors),
      posted_notes: readNonEmptyString(apiRaw, 'posted_notes', 'api_paths', errors),
      personal_info: readNonEmptyString(apiRaw, 'personal_info', 'api_paths', errors),
      comment_page: readNonEmptyString(apiRaw, 'comment_page', 'api_paths', errors)
    };
    Object.assign(apiPaths, parsedApi);
    for (const key of ['user_info', 'posted_notes', 'personal_info', 'comment_page'] as const) {
      const value = parsedApi[key];
      if (value === '') continue;
      const problem = apiPathError(value, `api_paths.${key}`);
      if (problem) errors.push(problem);
    }
  }

  const shareHosts = readStringArray(raw, 'share_hosts', 'rulepack', errors);
  for (const [index, host] of shareHosts.entries()) {
    const problem = shareHostError(host, `share_hosts[${index}]`);
    if (problem) errors.push(problem);
  }

  const anchorsRaw = raw.anchors;
  const anchors: XhsRulePackAnchors = { account: '', title: '', editor: '', prefill: [] };
  if (!isRecord(anchorsRaw)) {
    errors.push('anchors 必须是对象');
  } else {
    const parsedAnchors = {
      account: readNonEmptyString(anchorsRaw, 'account', 'anchors', errors),
      title: readNonEmptyString(anchorsRaw, 'title', 'anchors', errors),
      editor: readNonEmptyString(anchorsRaw, 'editor', 'anchors', errors),
      prefill: readStringArray(anchorsRaw, 'prefill', 'anchors', errors)
    };
    Object.assign(anchors, parsedAnchors);
  }

  const selectorsRaw = raw.selectors;
  const selectors: XhsRulePackSelectors = {
    note_card: '',
    note_card_covers: [],
    title: [],
    editor: [],
    tag_input: [],
    image_tab_container: '',
    shadow_save_host: '',
    shadow_save_button_class: '',
    draft_save_texts: [],
    image_tab_texts: [],
    tag_chips: ''
  };
  if (!isRecord(selectorsRaw)) {
    errors.push('selectors 必须是对象');
  } else {
    const parsedSelectors = {
      note_card: readNonEmptyString(selectorsRaw, 'note_card', 'selectors', errors),
      note_card_covers: readStringArray(selectorsRaw, 'note_card_covers', 'selectors', errors),
      title: readStringArray(selectorsRaw, 'title', 'selectors', errors),
      editor: readStringArray(selectorsRaw, 'editor', 'selectors', errors),
      tag_input: readStringArray(selectorsRaw, 'tag_input', 'selectors', errors),
      image_tab_container: readNonEmptyString(selectorsRaw, 'image_tab_container', 'selectors', errors),
      shadow_save_host: readNonEmptyString(selectorsRaw, 'shadow_save_host', 'selectors', errors),
      shadow_save_button_class: readNonEmptyString(selectorsRaw, 'shadow_save_button_class', 'selectors', errors),
      draft_save_texts: readStringArray(selectorsRaw, 'draft_save_texts', 'selectors', errors),
      image_tab_texts: readStringArray(selectorsRaw, 'image_tab_texts', 'selectors', errors),
      tag_chips: readNonEmptyString(selectorsRaw, 'tag_chips', 'selectors', errors)
    };
    Object.assign(selectors, parsedSelectors);
    // D-222：任何草稿保存文案一旦包含「发布」，规则包直接拒绝，绝不进入页面点击路径。
    if (parsedSelectors.draft_save_texts.some((text) => text.includes('发布'))) {
      errors.push('selectors.draft_save_texts 不得包含“发布”字样（D-222 红线）');
    }
  }

  const readbackRaw = raw.readback;
  const readback: XhsRulePackReadback = {
    note_body_keys: [],
    comment_id_keys: [],
    comment_body_keys: [],
    comment_time_keys: [],
    observation_field_paths: {
      view_times: '',
      like_count: '',
      favorite_count: '',
      comment_count: '',
      share_times: ''
    }
  };
  if (!isRecord(readbackRaw)) {
    errors.push('readback 必须是对象');
  } else {
    const noteBodyKeys = readStringArray(readbackRaw, 'note_body_keys', 'readback', errors);
    const commentIdKeys = readStringArray(readbackRaw, 'comment_id_keys', 'readback', errors);
    const commentBodyKeys = readStringArray(readbackRaw, 'comment_body_keys', 'readback', errors);
    const commentTimeKeys = readStringArray(readbackRaw, 'comment_time_keys', 'readback', errors);
    const fieldPathsRaw = readbackRaw.observation_field_paths;
    const fieldPaths: XhsObservationFieldPaths = {
      view_times: '',
      like_count: '',
      favorite_count: '',
      comment_count: '',
      share_times: ''
    };
    if (!isRecord(fieldPathsRaw)) {
      errors.push('readback.observation_field_paths 必须是对象');
    } else {
      const parsedPaths = {
        view_times: readNonEmptyString(fieldPathsRaw, 'view_times', 'readback.observation_field_paths', errors),
        like_count: readNonEmptyString(fieldPathsRaw, 'like_count', 'readback.observation_field_paths', errors),
        favorite_count: readNonEmptyString(fieldPathsRaw, 'favorite_count', 'readback.observation_field_paths', errors),
        comment_count: readNonEmptyString(fieldPathsRaw, 'comment_count', 'readback.observation_field_paths', errors),
        share_times: readNonEmptyString(fieldPathsRaw, 'share_times', 'readback.observation_field_paths', errors)
      };
      Object.assign(fieldPaths, parsedPaths);
    }
    Object.assign(readback, {
      note_body_keys: noteBodyKeys,
      comment_id_keys: commentIdKeys,
      comment_body_keys: commentBodyKeys,
      comment_time_keys: commentTimeKeys,
      observation_field_paths: fieldPaths
    });
  }

  if (errors.length > 0) return { ok: false, reason: errors.join('；') };

  const pack: XhsRulePack = {
    schema_version: 1,
    platform: 'xhs',
    adapter_version: adapterVersion,
    publish_adapter_version: publishAdapterVersion,
    mapping_version: mappingVersion as number,
    updated_at: updatedAt,
    urls,
    api_paths: apiPaths,
    share_hosts: shareHosts,
    anchors,
    selectors,
    readback
  };
  return { ok: true, pack: deepFreeze(pack) };
}

let defaultPackCache: XhsRulePack | null = null;

export function defaultXhsRulePackPath(): string {
  return join(__dirname, RULE_PACK_FILE);
}

// loadDefaultXhsRulePack 读取随包发布的内置规则。它是最后的安全底线：
// 内置资产缺失/损坏属于构建或打包缺陷，必须显式失败而不是带病运行。
export function loadDefaultXhsRulePack(): XhsRulePack {
  if (defaultPackCache) return defaultPackCache;
  const file = defaultXhsRulePackPath();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`内置小红书规则包无法读取：${file}（${messageOf(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`内置小红书规则包不是合法 JSON：${messageOf(error)}`);
  }
  const validated = validateXhsRulePack(parsed);
  if (!validated.ok) {
    throw new Error(`内置小红书规则包校验失败：${validated.reason}`);
  }
  defaultPackCache = validated.pack;
  return defaultPackCache;
}

function resolveCachePath(options: XhsRulePackLoadOptions): string | null {
  const explicit = typeof options.cachePath === 'string' ? options.cachePath.trim() : '';
  if (explicit !== '') return explicit;
  const overrideDir = typeof options.overrideDir === 'string' ? options.overrideDir.trim() : '';
  if (overrideDir !== '') return join(overrideDir, 'xhs.json');
  const fromEnv = process.env.OPS_XHS_RULEPACK_PATH?.trim() ?? '';
  return fromEnv === '' ? null : fromEnv;
}

// loadXhsRulePack 按显式缓存 → 覆盖目录 → 环境变量的优先级读取热更新规则。
// 所有失败路径都只回落，不抛出；缓存不存在时静默回落且不记录 fallbackReason。
export function loadXhsRulePack(options: XhsRulePackLoadOptions = {}): XhsRulePackLoadResult {
  const defaultPack = loadDefaultXhsRulePack();
  const cachePath = resolveCachePath(options);
  if (cachePath === null) return { pack: defaultPack, source: 'default' };

  const fallback = (reason: string): XhsRulePackLoadResult => {
    try {
      options.onFallback?.(reason);
    } catch {
      // 回调自身异常不得影响安全回落。
    }
    return { pack: defaultPack, source: 'default', cachePath, fallbackReason: reason };
  };

  let size = 0;
  try {
    const stat = statSync(cachePath);
    if (!stat.isFile()) return fallback('cache_not_a_file');
    size = stat.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { pack: defaultPack, source: 'default' };
    return fallback(`cache_read_failed: ${messageOf(error)}`);
  }
  if (size > MAX_CACHE_BYTES) {
    return fallback(`cache_too_large: ${size} > ${MAX_CACHE_BYTES} bytes`);
  }

  let text: string;
  try {
    text = readFileSync(cachePath, 'utf8');
  } catch (error) {
    return fallback(`cache_read_failed: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fallback(`cache_json_invalid: ${messageOf(error)}`);
  }
  const validated = validateXhsRulePack(parsed);
  if (!validated.ok) {
    return fallback(`cache_validation_failed: ${validated.reason}`);
  }
  return { pack: validated.pack, source: 'cache', cachePath };
}

let loadedPack: XhsRulePack | null = null;

// getXhsRulePack 使用默认加载选项并缓存成功结果；消费端只拿冻结后的 pack。
export function getXhsRulePack(): XhsRulePack {
  if (loadedPack === null) loadedPack = loadXhsRulePack().pack;
  return loadedPack;
}

// resetXhsRulePackCache 仅清理进程级结果缓存，供测试或受控重载使用。
export function resetXhsRulePackCache(): void {
  loadedPack = null;
}
