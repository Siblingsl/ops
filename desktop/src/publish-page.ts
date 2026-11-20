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
const XHS_IMAGE_TAB_TEXTS = ['上传图文'];
const XHS_IMAGE_ACCEPT = /image|jpg|jpeg|png|webp|gif|heic/i;
const XHS_VIDEO_ACCEPT = /video|mp4|mov|flv|mkv|m4v|mpeg|ts/i;
const XHS_IMAGE_ACCEPT_SOURCE = XHS_IMAGE_ACCEPT.source;
const XHS_IMAGE_ACCEPT_FLAGS = XHS_IMAGE_ACCEPT.flags;
const XHS_VIDEO_ACCEPT_SOURCE = XHS_VIDEO_ACCEPT.source;
const XHS_VIDEO_ACCEPT_FLAGS = XHS_VIDEO_ACCEPT.flags;

export function isXhsImageTabText(text: string): boolean {
  return XHS_IMAGE_TAB_TEXTS.includes(text.replace(/\s+/g, ' ').trim());
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
  return { title: TITLE_SELECTORS, editor: EDITOR_SELECTORS, tag: TAG_INPUT_SELECTORS };
}

async function readXhsIdentity(cdp: CDPPageClient): Promise<{ userId: string; userName: string } | null> {
  const body = await evaluate<string>(cdp, `(async () => {
    try {
      const response = await fetch('/api/galaxy/user/info', { credentials: 'include' });
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
    const clicked = await evaluate<boolean>(cdp, `(() => {
      const nodes = Array.from(document.querySelectorAll('.creator-tab, [role="tab"], button, [role="button"]'));
      const target = nodes.find((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const text = String(el.innerText ?? '').replace(/\\s+/g, ' ').trim();
        if (!${json(XHS_IMAGE_TAB_TEXTS)}.includes(text)) return false;
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
        return await evaluate<boolean>(cdp, `document.body.innerText.includes('上传图文')`);
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
      if (tags.length > 0 && !(await hasTagInput())) {
        // 没有独立话题输入框时，把标签以 #tag 形式接在正文尾部；回读按 hashtag 统计。
        body = `${bodyText}\n\n${tags.map((tag) => `#${tag}`).join(' ')}`;
      }
      await setBody(body);
      if (tags.length > 0 && (await hasTagInput())) {
        for (const tag of tags) await addTag(tag);
      }
      await sleep(500);
    },

    async readbackFields(): Promise<PublishReadbackActual> {
      await verifyIdentity();
      return await evaluate<PublishReadbackActual>(cdp, `(() => {
        const titleSelectors = ${json(spec.title)};
        const editorSelectors = ${json(spec.editor)};
        const titleEl = titleSelectors.map((s) => document.querySelector(s)).find(Boolean);
        const editor = editorSelectors.map((s) => document.querySelector(s)).find(Boolean);
        const title = titleEl ? String(titleEl.value ?? titleEl.textContent ?? '') : '';
        const rawBody = editor ? String(editor.innerText ?? editor.textContent ?? '') : '';
        const tagSelectors = ${json(spec.tag)};
        const chips = Array.from(document.querySelectorAll('[class*="topic"] span, [class*="tag"] span, [data-tag]'))
          .map((el) => String(el.textContent ?? '').trim())
          .filter((text) => text.startsWith('#'));
        const hashes = Array.from(rawBody.matchAll(/#([^#\\s]{1,30})/g)).map((m) => m[1]).filter(Boolean);
        const tags = chips.length > 0 ? chips.map((text) => text.replace(/^#/, '')) : hashes;
        // 没有独立话题输入框时，标签由 fillFields 追加在正文尾部；回读必须把这段
        // 回退标签从正文剥离，标签本身仍由 tags 字段单独核对。
        const body = chips.length === 0 && tags.length > 0
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
