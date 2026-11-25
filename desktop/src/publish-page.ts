// REF41 P2/P8：把发布任务绑定到真实平台登录 profile，并提供生产页面端口。
//
// 页面操作只走 CDP（Runtime/DOM/Page/Input），不调平台私有 API：
// - 图片通过 DOM.setFileInputFiles 交给平台自己的上传控件；
// - 标题/正文用原生 setter 或 execCommand 写入并派发 input 事件；
// - 回读只读 DOM，提交只点一次平台自己的发布按钮。
// 不自动提交：普通填写到回读为止；只有服务端明确发放 intent=submit 时才调用 submitNow。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAccountProfile,
  type AccountProfileMeta,
  type AccountProfileScope
} from './platform-profile';
import { selectLoginBrowser, trustedLoginBrowsers } from './platform-browser-trust';
import { getXhsRulePack } from './platforms/rules/loader';
import {
  createCDPClient,
  launchPlatformBrowser,
  type CDPPageClient,
  type PlatformBrowserProcess
} from './platform-worker';
import type { PublishPagePort } from './publish/adapter';
import { stripTrailingFallbackTags, type PublishReadbackActual } from './publish/readback';
import { PublishExecutorError } from './publish/errors';
import { platformPublishUrl } from './publish/platform-urls';
import type { PublishFillRequest } from './publish/types';

export interface DesktopPublishAsset {
  assetId: string;
  role: string;
  mime: string;
  width: number;
  height: number;
  data: Buffer;
}

export interface DesktopPublishPageSession {
  profileDir: string;
  meta: AccountProfileMeta;
  browser: PlatformBrowserProcess;
  cdp: CDPPageClient;
  port: PublishPagePort;
  close: () => Promise<void>;
}

export interface OpenDesktopPublishPageInput {
  userDataDir: string;
  scope: AccountProfileScope;
  platform: string;
  accountName: string;
  externalAccountKey: string;
  taskId?: string;
  /** claim 随任务下发的 manifest 图片；桌面写临时文件后交给平台上传控件。 */
  assets?: DesktopPublishAsset[];
  /** 仅测试/fixture 注入；生产调用不传，永远使用下面的平台官方创作页。 */
  publishUrl?: string;
}

const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  'input[placeholder*="填写标题"]',
  'input[name="title"]',
  '.title-input input',
  '.post-title input'
];

const EDITOR_SELECTORS = [
  '.ql-editor',
  '.ProseMirror',
  '[contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]'
];

const TAG_INPUT_SELECTORS = [
  'input[placeholder*="话题"]',
  'input[placeholder*="标签"]',
  'input[placeholder*="添加"]'
];

const PUBLISH_BUTTON_TEXTS = ['发布笔记', '发布', '预览并发布', '确认发布'];
// 小红书发布页的草稿保存入口叫“暂存离开”（页面 bundle 的 saveText 默认值）。
// 只允许精确命中 RulePack 给出的草稿保存文案，且 loader 已保证任何一条都不含发布字样。
const XHS_IMAGE_ACCEPT = /image|jpg|jpeg|png|webp|gif|heic/i;
const XHS_VIDEO_ACCEPT = /video|mp4|mov|flv|mkv|m4v|mpeg|ts/i;
const XHS_IMAGE_ACCEPT_SOURCE = XHS_IMAGE_ACCEPT.source;
const XHS_IMAGE_ACCEPT_FLAGS = XHS_IMAGE_ACCEPT.flags;
const XHS_VIDEO_ACCEPT_SOURCE = XHS_VIDEO_ACCEPT.source;
const XHS_VIDEO_ACCEPT_FLAGS = XHS_VIDEO_ACCEPT.flags;

export function isXhsImageTabText(text: string): boolean {
  const imageTabTexts = getXhsRulePack().selectors.image_tab_texts;
  return imageTabTexts.includes(text.replace(/\s+/g, ' ').trim());
}

export function isXhsImageAccept(accept: string): boolean {
  const normalized = accept.toLowerCase();
  if (!normalized) return true;
  if (XHS_VIDEO_ACCEPT.test(normalized)) return false;
  return XHS_IMAGE_ACCEPT.test(normalized);
}

interface EvaluateResult<T> {
  result?: { value?: T; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate<T>(cdp: CDPPageClient, expression: string, timeoutMs = 20_000): Promise<T> {
  const raw = await cdp.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, timeoutMs) as EvaluateResult<T>;
  if (raw.exceptionDetails) {
    throw new Error(raw.exceptionDetails.exception?.description || raw.exceptionDetails.text || '页面脚本执行失败');
  }
  return raw.result?.value as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPage(cdp: CDPPageClient, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate<string>(cdp, 'document.readyState').catch(() => '');
    if (ready === 'interactive' || ready === 'complete') return;
    await sleep(250);
  }
  throw new Error('平台创作页加载超时');
}

async function waitForCondition(
  cdp: CDPPageClient,
  expression: string,
  timeoutMs: number,
  message: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate<boolean>(cdp, expression).catch(() => false)) return;
    await sleep(500);
  }
  throw new PublishExecutorError('anchor_missing', message);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function selectors(platform: string): { title: string[]; editor: string[]; tag: string[] } {
  if (platform === 'toutiao') {
    return {
      title: TITLE_SELECTORS,
      editor: EDITOR_SELECTORS,
      tag: ['input[placeholder*="标签"]', 'input[placeholder*="话题"]']
    };
  }
  if (platform === 'xhs') {
    // OPT-E01：小红书选择器由 RulePack 驱动；头条保持既有硬编码不变。
    const rulePack = getXhsRulePack();
    return {
      title: [...rulePack.selectors.title],
      editor: [...rulePack.selectors.editor],
      tag: [...rulePack.selectors.tag_input]
    };
  }
  return { title: TITLE_SELECTORS, editor: EDITOR_SELECTORS, tag: TAG_INPUT_SELECTORS };
}

async function readXhsIdentity(cdp: CDPPageClient): Promise<{ userId: string; userName: string } | null> {
  // OPT-E01：账号信息接口路径由 RulePack 提供（loader 已保证是 /api/ 同源路径）。
  const userInfoPath = getXhsRulePack().api_paths.user_info;
  const body = await evaluate<string>(cdp, `(async () => {
    try {
      const response = await fetch(${json(userInfoPath)}, { credentials: 'include' });
      return await response.text();
    } catch (error) {
      return JSON.stringify({ error: String(error) });
    }
  })()`);
  try {
    const parsed = JSON.parse(body) as { data?: { userId?: unknown; userName?: unknown } };
    const userId = typeof parsed.data?.userId === 'string' ? parsed.data.userId.trim() : '';
    const userName = typeof parsed.data?.userName === 'string' ? parsed.data.userName.trim() : '';
    return userId ? { userId, userName } : null;
  } catch {
    return null;
  }
}

function errorWithCode(code: string, message: string): PublishExecutorError {
  return new PublishExecutorError(code, message);
}

/**
 * 打开一条已登录连接的创作页，返回可填写/回读/提交的 PublishPagePort。
 * 归属校验复用 readAccountProfile：profileDir 必须与登录写入口完全一致，
 * 并用平台侧的稳定 userId 复核 connection.external_account_key。
 */
export async function openDesktopPublishPage(input: OpenDesktopPublishPageInput): Promise<DesktopPublishPageSession> {
  const url = input.publishUrl || platformPublishUrl(input.platform);
  if (!url) throw errorWithCode('platform_not_supported', `平台 ${input.platform} 暂不支持桌面发布`);
  const stored = await readAccountProfile(input.userDataDir, input.scope);
  if (!stored.meta) throw errorWithCode('platform_login_required', '该账号没有可复用的平台登录会话');
  if (stored.meta.platform !== input.platform) {
    throw errorWithCode('platform_profile_mismatch', '登录会话与任务平台不一致');
  }
  if (input.externalAccountKey && stored.meta.externalAccountKey && stored.meta.externalAccountKey !== input.externalAccountKey) {
    throw errorWithCode('account_mismatch', '登录会话与任务账号不一致');
  }
  const candidate = selectLoginBrowser(await trustedLoginBrowsers(), stored.meta.browserFamily);
  const browser = await launchPlatformBrowser({ executablePath: candidate.executablePath, profileDir: stored.profileDir });
  const cdp = createCDPClient(browser, 20_000);
  let identityChecked = false;
  let assetDir = '';
  let uploaded = false;

  const verifyIdentity = async (): Promise<void> => {
    if (identityChecked) return;
    if (input.platform === 'xhs') {
      const identity = await readXhsIdentity(cdp);
      if (!identity) throw errorWithCode('platform_login_required', '小红书创作中心未返回登录身份');
      if (input.externalAccountKey && input.externalAccountKey !== `xhs_user_id:${identity.userId}`) {
        throw errorWithCode('account_mismatch', '当前登录的小红书账号与任务账号不一致');
      }
    }
    identityChecked = true;
  };

  const spec = selectors(input.platform);
  const titleExists = () => evaluate<boolean>(cdp, `(() => {
    const selectors = ${json(spec.title)};
    return selectors.some((selector) => {
      const el = document.querySelector(selector);
      return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    });
  })()`);
  const editorExists = () => evaluate<boolean>(cdp, `(() => {
    const selectors = ${json(spec.editor)};
    return selectors.some((selector) => {
      const el = document.querySelector(selector);
      return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    });
  })()`);

  async function writeAssetFiles(): Promise<string[]> {
    const assets = input.assets ?? [];
    if (assets.length === 0) return [];
    if (!assetDir) {
      assetDir = await mkdtemp(join(tmpdir(), 'ops-publish-'));
    }
    const paths: string[] = [];
    for (const [index, asset] of assets.entries()) {
      const ext = asset.mime === 'image/png' ? '.png' : asset.mime === 'image/webp' ? '.webp' : '.jpg';
      const path = join(assetDir, `${String(index).padStart(2, '0')}-${asset.role}${ext}`);
      await writeFile(path, asset.data);
      paths.push(path);
    }
    return paths;
  }

  async function selectXhsImageTab(): Promise<void> {
    // 当前小红书创作页默认停在“上传视频”；图片上传控件只有切到“上传图文”后
    // 才存在。不能把封面图塞进视频 input，否则平台侧不会进入标题/正文编辑器。
    // OPT-E01：容器选择器与入口文案由 RulePack 提供。
    const rulePack = getXhsRulePack();
    const tabContainer = rulePack.selectors.image_tab_container;
    const imageTabTexts = rulePack.selectors.image_tab_texts;
    const clicked = await evaluate<boolean>(cdp, `(() => {
      const nodes = Array.from(document.querySelectorAll(${json(tabContainer)}));
      const target = nodes.find((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const text = String(el.innerText ?? '').replace(/\\s+/g, ' ').trim();
        if (!${json(imageTabTexts)}.includes(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!clicked) throw errorWithCode('anchor_missing', '未找到“上传图文”入口');
    await waitForCondition(cdp, `(() => {
      return Array.from(document.querySelectorAll('input[type="file"]')).some((el) => {
        const accept = String(el.accept ?? '').toLowerCase();
        if (!accept) return true;
        if (new RegExp(${json(XHS_VIDEO_ACCEPT_SOURCE)}, ${json(XHS_VIDEO_ACCEPT_FLAGS)}).test(accept)) return false;
        return new RegExp(${json(XHS_IMAGE_ACCEPT_SOURCE)}, ${json(XHS_IMAGE_ACCEPT_FLAGS)}).test(accept);
      });
    })()`, 15_000, '切换“上传图文”后未出现图片上传控件');
  }

  async function markImageInput(): Promise<boolean> {
    return await evaluate<boolean>(cdp, `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const image = inputs.find((el) => {
        const accept = String(el.accept ?? '').toLowerCase();
        if (!accept) return true;
        if (new RegExp(${json(XHS_VIDEO_ACCEPT_SOURCE)}, ${json(XHS_VIDEO_ACCEPT_FLAGS)}).test(accept)) return false;
        return new RegExp(${json(XHS_IMAGE_ACCEPT_SOURCE)}, ${json(XHS_IMAGE_ACCEPT_FLAGS)}).test(accept);
      });
      if (!image) return false;
      image.setAttribute('data-ops-publish-asset', '1');
      return true;
    })()`);
  }

  async function uploadAssetsIfNeeded(): Promise<void> {
    if (uploaded || !(input.assets && input.assets.length > 0)) return;
    if (await titleExists()) {
      // 页面已经有编辑器，说明上一次填写已上传成功；重试不得重复上传。
      uploaded = true;
      return;
    }
    if (input.platform === 'xhs') await selectXhsImageTab();
    await waitForCondition(cdp, `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.some((el) => {
        const accept = String(el.accept ?? '').toLowerCase();
        if (!accept) return true;
        if (new RegExp(${json(XHS_VIDEO_ACCEPT_SOURCE)}, ${json(XHS_VIDEO_ACCEPT_FLAGS)}).test(accept)) return false;
        return new RegExp(${json(XHS_IMAGE_ACCEPT_SOURCE)}, ${json(XHS_IMAGE_ACCEPT_FLAGS)}).test(accept);
      });
    })()`, 15_000, '页面没有图片上传控件');
    const paths = await writeAssetFiles();
    await cdp.request('DOM.enable');
    const document = await cdp.request('DOM.getDocument', { depth: -1 }) as { root?: { nodeId?: number } };
    const rootNodeId = document.root?.nodeId;
    if (!rootNodeId) throw errorWithCode('anchor_missing', '无法读取平台页面 DOM');
    if (!(await markImageInput())) throw errorWithCode('anchor_missing', '页面没有图片上传控件');
    const found = await cdp.request('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: 'input[data-ops-publish-asset="1"]'
    }) as { nodeId?: number };
    if (!found.nodeId) throw errorWithCode('anchor_missing', '页面没有图片上传控件');
    await cdp.request('DOM.setFileInputFiles', { files: paths, nodeId: found.nodeId });
    uploaded = true;
    await waitForCondition(cdp, `(() => {
      const selectors = ${json(spec.title)};
      return selectors.some((selector) => Boolean(document.querySelector(selector)));
    })()`, 90_000, '图片上传后未出现标题编辑器');
    await waitForCondition(cdp, `(() => {
      const selectors = ${json(spec.editor)};
      return selectors.some((selector) => Boolean(document.querySelector(selector)));
    })()`, 90_000, '图片上传后未出现正文编辑器');
  }

  async function setTitle(value: string): Promise<void> {
    const ok = await evaluate<boolean>(cdp, `(() => {
      const selectors = ${json(spec.title)};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${json(value)});
        else el.value = ${json(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()`);
    if (!ok) throw errorWithCode('anchor_missing', '未找到标题输入框');
  }

  async function setBody(value: string): Promise<void> {
    const ok = await evaluate<boolean>(cdp, `(() => {
      const selectors = ${json(spec.editor)};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, ${json(value)});
        } catch {
          inserted = false;
        }
        if (!inserted) {
          el.textContent = ${json(value)};
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${json(value)} }));
        }
        return true;
      }
      return false;
    })()`);
    if (!ok) throw errorWithCode('anchor_missing', '未找到正文编辑器');
  }

  async function hasTagInput(): Promise<boolean> {
    return await evaluate<boolean>(cdp, `(() => {
      const selectors = ${json(spec.tag)};
      return selectors.some((selector) => {
        const el = document.querySelector(selector);
        return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      });
    })()`);
  }

  async function addTag(tag: string): Promise<void> {
    const focused = await evaluate<boolean>(cdp, `(() => {
      const selectors = ${json(spec.tag)};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()`);
    if (!focused) return;
    await cdp.request('Input.insertText', { text: tag });
    await sleep(800);
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(400);
  }

  async function clickXhsShadowSaveButton(): Promise<{ ok: boolean; label?: string; reason?: string }> {
    // 小红书真实发布页的底部按钮是 <xhs-publish-btn> 自定义组件，按钮文本渲染在
    // 闭合 shadow root 里：document.querySelectorAll 看不到“暂存离开”，但组件属性
    // save-text="暂存离开" / submit-text="发布" 与 CDP 扁平化 DOM 能精确区分两个
    // 原生 button。这里只点 shadow 内文本恰为草稿保存词的 BUTTON，绝不按坐标盲点。
    // OPT-E01：host 选择器、按钮 class 与草稿文案由 RulePack 提供。
    const rulePackSelectors = getXhsRulePack().selectors;
    const shadowSaveHost = rulePackSelectors.shadow_save_host;
    const shadowSaveButtonClass = rulePackSelectors.shadow_save_button_class;
    const draftSaveTexts = rulePackSelectors.draft_save_texts;
    const hostOK = await evaluate<boolean>(cdp, `(() => {
      const host = document.querySelector(${json(shadowSaveHost)});
      if (!(host instanceof HTMLElement)) return false;
      const saveText = String(host.getAttribute('save-text') ?? '').replace(/\\s+/g, ' ').trim();
      const submitText = String(host.getAttribute('submit-text') ?? '');
      if (!${json(draftSaveTexts)}.includes(saveText)) return false;
      if (!submitText.includes('发布')) return false;
      if (host.getAttribute('save-disabled') === 'true') return false;
      const rect = host.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`);
    if (!hostOK) return { ok: false, reason: 'draft_save_host_missing' };

    await cdp.request('DOM.enable');
    const flat = await cdp.request('DOM.getFlattenedDocument', { depth: -1, pierce: true }) as {
      nodes?: Array<{ nodeId: number; parentId?: number; nodeName: string; nodeValue?: string; attributes?: string[] }>;
    };
    const nodes = flat.nodes ?? [];
    const textNode = nodes.find((node) => node.nodeName === '#text'
      && draftSaveTexts.includes(String(node.nodeValue ?? '').replace(/\s+/g, ' ').trim())
      && node.parentId);
    if (!textNode || !textNode.parentId) return { ok: false, reason: 'draft_save_button_missing' };
    const button = nodes.find((node) => node.nodeId === textNode.parentId);
    if (!button || button.nodeName !== 'BUTTON') return { ok: false, reason: 'draft_save_button_not_button' };
    const attributes = button.attributes ?? [];
    const classIndex = attributes.indexOf('class');
    const className = classIndex >= 0 ? String(attributes[classIndex + 1] ?? '') : '';
    if (!className.includes(shadowSaveButtonClass)) return { ok: false, reason: 'draft_save_button_not_ce_btn' };

    const box = await cdp.request('DOM.getBoxModel', { nodeId: button.nodeId }) as {
      model?: { content?: number[] };
    };
    const content = box.model?.content ?? [];
    if (content.length !== 8) return { ok: false, reason: 'draft_save_button_bounds' };
    const width = Math.abs(content[2] - content[0]);
    const height = Math.abs(content[5] - content[1]);
    if (width < 40 || width > 260 || height < 20 || height > 80) {
      return { ok: false, reason: 'draft_save_button_bounds' };
    }
    const x = (content[0] + content[4]) / 2;
    const y = (content[1] + content[5]) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      return { ok: false, reason: 'draft_save_button_bounds' };
    }
    await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.request('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
    await cdp.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, label: '暂存离开' };
  }

  async function saveDraft(): Promise<void> {
    // 小红书红线：这里只点草稿保存，不允许点任何发布按钮。平台浏览器端口必须
    // 与适配器一样做 fail-closed，避免历史代码或异常调用绕过适配器直接点发布。
    if (input.platform !== 'xhs') {
      throw errorWithCode('draft_save_not_supported', `平台 ${input.platform} 不支持桌面保存草稿`);
    }
    await verifyIdentity();
    // OPT-E01：草稿保存文案由 RulePack 提供；PUBLISH_BUTTON_TEXTS 禁止词守卫保持硬编码。
    const draftSaveTexts = getXhsRulePack().selectors.draft_save_texts;
    let clicked = await evaluate<{ ok: boolean; label?: string; reason?: string }>(cdp, `(() => {
      const wanted = ${json(draftSaveTexts)};
      const forbidden = ${json(PUBLISH_BUTTON_TEXTS)};
      const text = (el) => String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"], [class*="save"], div, span'))
        .filter((el) => el instanceof HTMLElement && visible(el));
      for (const el of candidates) {
        const label = text(el);
        if (!wanted.includes(label)) continue;
        if (forbidden.some((word) => label.includes(word))) continue;
        if (el.closest('[aria-disabled="true"], [disabled]')) continue;
        const clickable = el.closest('button, [role="button"], [class*="btn"]') || el;
        if (clickable.closest('[aria-disabled="true"], [disabled]')) continue;
        clickable.click();
        return { ok: true, label };
      }
      return { ok: false, reason: 'draft_save_button_missing' };
    })()`);
    if (!clicked || !clicked.ok) {
      clicked = await clickXhsShadowSaveButton();
    }
    if (!clicked || !clicked.ok) {
      throw errorWithCode(clicked?.reason || 'draft_save_button_missing', '未找到可安全点击的草稿保存入口（暂存离开/保存草稿），内容未落草稿箱');
    }

    // 平台可能在“暂存离开”后弹确认框；只在确认框明确是草稿/离开语义时，
    // 点“确认/确定/保存/暂存并离开”这类文本，绝不点任何含“发布”的按钮。
    await sleep(800);
    await evaluate<boolean>(cdp, `(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .d-modal, .modal, [class*="dialog"]'))
        .filter((el) => el instanceof HTMLElement && el.getBoundingClientRect().width > 0);
      for (const dialog of dialogs) {
        const body = String(dialog.innerText ?? dialog.textContent ?? '').replace(/\\s+/g, ' ').trim();
        if (!/草稿|暂存|离开/.test(body) || /发布/.test(body)) continue;
        const nodes = Array.from(dialog.querySelectorAll('button, [role="button"], [class*="btn"], div, span'))
          .filter((el) => el instanceof HTMLElement && el.getBoundingClientRect().width > 0);
        const confirm = nodes.find((el) => {
          const label = String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
          if (!['确认', '确定', '保存', '暂存并离开', '保存并离开'].includes(label)) return false;
          if (/发布/.test(label)) return false;
          return true;
        });
        if (confirm) {
          const clickable = confirm.closest('button, [role="button"], [class*="btn"]') || confirm;
          clickable.click();
          return true;
        }
      }
      return false;
    })()`).catch(() => false);

    // 成功判定：出现“保存成功”，或页面已经离开发布编辑器（跳草稿箱/笔记管理）。
    const started = Date.now();
    let confirmed = false;
    while (Date.now() - started < 15_000) {
      confirmed = await evaluate<boolean>(cdp, `(() => {
        const body = String(document.body.innerText ?? '');
        if (/保存成功|已保存到草稿箱|已存入草稿箱/.test(body)) return true;
        return !(location.pathname + location.search).startsWith('/publish/publish');
      })()`).catch(() => false);
      if (confirmed) break;
      await sleep(500);
    }
    if (!confirmed) {
      throw errorWithCode('draft_save_unconfirmed', '点击草稿保存后未出现“保存成功”或离开发布页，按未保存处理');
    }
  }

  const port: PublishPagePort = {
    async currentAccountName(): Promise<string> {
      await verifyIdentity();
      // OPS 账号名是用户可改的展示名，平台昵称也可能被改；身份已用稳定 userId 复核，
      // 这里返回任务侧名称供适配器比较，不再把可变昵称当成身份。
      return input.accountName;
    },

    async tabCount(): Promise<number> {
      const targets = await cdp.request('Target.getTargets') as {
        targetInfos?: Array<{ type?: unknown }>;
      };
      return (targets.targetInfos ?? []).filter((target) => target.type === 'page').length;
    },

    async hasAnchor(anchor: string): Promise<boolean> {
      await verifyIdentity();
      if (anchor === 'xhs-account' || anchor === 'toutiao-account') return true;
      if (anchor === 'xhs-upload') {
        // OPT-E01：上传图文入口文案由 RulePack 提供，不再硬编码单一文案。
        const imageTabTexts = getXhsRulePack().selectors.image_tab_texts;
        return await evaluate<boolean>(cdp, `(() => {
          const texts = ${json(imageTabTexts)};
          const body = String(document.body.innerText ?? '');
          return texts.some((text) => body.includes(text));
        })()`);
      }
      if (anchor === 'xhs-title' || anchor === 'toutiao-title') return await titleExists();
      if (anchor === 'xhs-editor' || anchor === 'toutiao-editor') return await editorExists();
      return false;
    },

    async fillFields(manifest: Record<string, unknown>): Promise<void> {
      await verifyIdentity();
      await uploadAssetsIfNeeded();
      const fields = (manifest.fields && typeof manifest.fields === 'object' && !Array.isArray(manifest.fields))
        ? manifest.fields as Record<string, unknown>
        : {};
      const title = typeof fields.title === 'string' ? fields.title : '';
      const bodyText = typeof fields.body_text === 'string' ? fields.body_text : '';
      const tags = Array.isArray(fields.tags)
        ? fields.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      if (!title) throw errorWithCode('manifest_invalid', 'manifest 缺少标题');
      await setTitle(title);
      let body = bodyText;
      // 小红书真实页没有独立的“话题芯片”输入框：底部“话题”只是正文内联
      // hashtag 的辅助入口，推荐话题还会混进无关 chip。统一把标签以 #tag
      // 追加在正文尾部，回读再从正文解析并剥离；不要用 Input.insertText 盲打，
      // 否则文字会落进正文编辑器（真实首跑已发生）。
      const inlineTags = tags.length > 0 && (input.platform === 'xhs' || !(await hasTagInput()));
      if (inlineTags) {
        body = `${bodyText}\n\n${tags.map((tag) => `#${tag}`).join(' ')}`;
      }
      await setBody(body);
      if (tags.length > 0 && !inlineTags) {
        for (const tag of tags) await addTag(tag);
      }
      await sleep(500);
    },

    async readbackFields(): Promise<PublishReadbackActual> {
      await verifyIdentity();
      // OPT-E01：小红书的标签芯片选择器由 RulePack 提供；头条保持既有选择器。
      const tagChipsSelector = input.platform === 'xhs'
        ? getXhsRulePack().selectors.tag_chips
        : '[class*="topic"] span, [class*="tag"] span, [data-tag]';
      return await evaluate<PublishReadbackActual>(cdp, `(() => {
        const titleSelectors = ${json(spec.title)};
        const editorSelectors = ${json(spec.editor)};
        const titleEl = titleSelectors.map((s) => document.querySelector(s)).find(Boolean);
        const editor = editorSelectors.map((s) => document.querySelector(s)).find(Boolean);
        const title = titleEl ? String(titleEl.value ?? titleEl.textContent ?? '') : '';
        const rawBody = editor ? String(editor.innerText ?? editor.textContent ?? '') : '';
        const chips = Array.from(document.querySelectorAll(${json(tagChipsSelector)}))
          .map((el) => String(el.textContent ?? '').trim())
          .filter((text) => text.startsWith('#'));
        const hashes = Array.from(rawBody.matchAll(/#([^#\\s]{1,30})/g)).map((m) => m[1]).filter(Boolean);
        // 小红书话题就是正文里的 hashtag；页面上的推荐话题 chip 不是已选话题，
        // 不能拿来当回读事实（真实首跑曾因此读到 18 个无关 chip）。
        const inlineTags = ${input.platform === 'xhs'};
        const tags = inlineTags ? hashes : (chips.length > 0 ? chips.map((text) => text.replace(/^#/, '')) : hashes);
        // 标签由 fillFields 追加在正文尾部时，回读必须把这段回退标签从正文剥离，
        // 标签本身仍由 tags 字段单独核对。
        const body = tags.length > 0 && (inlineTags || chips.length === 0)
          ? (${stripTrailingFallbackTags.toString()})(rawBody, tags)
          : rawBody;
        const images = Array.from(document.querySelectorAll('img'))
          .filter((img) => {
            const src = String(img.currentSrc || img.src || '');
            return src.startsWith('blob:') || /ci\\.xiaohongshu|toutiao|byteimg/.test(src) || /upload|image/i.test(img.className);
          });
        const first = images[0];
        const ratio = first && first.naturalWidth > 0 && first.naturalHeight > 0
          ? first.naturalWidth / first.naturalHeight
          : 0;
        return { title, body, tags, cover: { present: images.length > 0, ratio }, schedule: '' };
      })()`);
    },

    async captureScreenshot(): Promise<string> {
      await verifyIdentity();
      // 用 jpeg 控制体积；服务端会转码并落到 asset 表，只保留 asset_id。
      const shot = await cdp.request('Page.captureScreenshot', { format: 'jpeg', quality: 60 }) as { data?: string };
      if (!shot.data) throw errorWithCode('screenshot_failed', '页面截图失败');
      return shot.data;
    },

    async saveDraft(): Promise<void> {
      await saveDraft();
    },

    async countFilledPages(req: PublishFillRequest): Promise<number> {
      await verifyIdentity();
      const fields = (req.manifest.fields && typeof req.manifest.fields === 'object' && !Array.isArray(req.manifest.fields))
        ? req.manifest.fields as Record<string, unknown>
        : {};
      const expectedTitle = typeof fields.title === 'string' ? fields.title.replace(/\s+/g, ' ').trim() : '';
      const actual = await port.readbackFields!();
      const title = actual.title.replace(/\s+/g, ' ').trim();
      const body = actual.body.trim();
      if (!expectedTitle || !title || !body) return 0;
      return title === expectedTitle ? 1 : 0;
    },

    async submitNow(): Promise<void> {
      // 小红书风控红线：即使适配器/执行器出现回归，页面端口本身也绝不点发布。
      if (input.platform === 'xhs') {
        throw errorWithCode('direct_submit_not_supported', '小红书不允许由 OPS 直接点击发布；请保存草稿后由用户在小红书草稿箱发布');
      }
      await verifyIdentity();
      const clicked = await evaluate<boolean>(cdp, `(() => {
        const wanted = ${json(PUBLISH_BUTTON_TEXTS)};
        const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const text of wanted) {
          const node = nodes.find((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const label = String(el.innerText ?? '').trim();
            if (label !== text) return false;
            if (el.closest('[aria-disabled="true"], [disabled]')) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (node) {
            (node as HTMLElement).click();
            return true;
          }
        }
        return false;
      })()`);
      if (!clicked) throw errorWithCode('submit_not_configured', '页面没有可点击的发布按钮');
      await sleep(1_500);
      // 二次确认弹窗只点一次“确认发布”；找不到就不再点，交给成功判定。
      await evaluate<boolean>(cdp, `(() => {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], div'));
        const confirm = nodes.find((el) => el instanceof HTMLElement && /^(确认发布|确认)$/.test(String(el.innerText ?? '').trim()));
        if (confirm) { (confirm as HTMLElement).click(); return true; }
        return false;
      })()`);
      await waitForCondition(cdp, `(() => {
        const text = document.body.innerText;
        return /发布成功|已发布|提交成功/.test(text);
      })()`, 30_000, '点击发布后未出现成功提示，按未提交处理且不再点击');
    }
  };

  async function cleanup(): Promise<void> {
    if (assetDir) {
      await rm(assetDir, { recursive: true, force: true }).catch(() => undefined);
      assetDir = '';
    }
  }

  try {
    await cdp.attachToPage();
    await cdp.request('Page.enable');
    await cdp.request('Page.navigate', { url });
    await waitForPage(cdp);
    await sleep(2_000);
    await verifyIdentity();
    return {
      profileDir: stored.profileDir,
      meta: stored.meta,
      browser,
      cdp,
      port,
      close: async () => {
        await cleanup();
        await browser.close();
      }
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}
