// 平台无关的桌面发布适配器骨架。平台差异只在 anchors/version 与 adapter 内；
// 页面操作只通过 PublishPagePort（生产实现走 chrome-shim），不调平台私有 API。
import { PublishExecutorError } from './errors';
import { buildPublishReadback, type PublishReadbackActual } from './readback';
import type { BrowserPolicyGate, PublishExecutor, PublishFillRequest, PublishFillResult } from './types';

export interface PublishPagePort {
  currentAccountName(): Promise<string>;
  hasAnchor(anchor: string): Promise<boolean>;
  fillFields?(manifest: Record<string, unknown>): Promise<void>;
  readbackFields?(): Promise<PublishReadbackActual>;
  /** 小红书：填写完成并回读通过后，只点“暂存离开/保存草稿”把内容落到草稿箱，绝不点发布。 */
  saveDraft?(): Promise<void>;
  submitNow?(): Promise<void>;
  /** REF41 F5：当前浏览器会话的页面 target 数；策略闸要求恰好 1。 */
  tabCount?(): Promise<number>;
  /** REF41 P6：当前账号+平台下“已填好待提交”的匹配页数量；submit 前必须恰好 1。 */
  countFilledPages?(req: PublishFillRequest): Promise<number>;
  /** REF41 P3：回读截图（base64 jpeg/png）；服务端转存 asset 后只保留 asset_id。 */
  captureScreenshot?(): Promise<string>;
}

export interface PublishAdapterAnchors {
  account: string;
  title: string;
  editor: string;
  /**
   * 上传前实际存在的锚点。小红书发布页默认停在“上传视频”，标题/正文编辑器
   * 只有在“上传图文”并选中图片后才出现；preflight 先查这组锚点，否则真实
   * 首跑会永远在填写前报 anchor_missing。未配置时保持原来的 title+editor 校验。
   */
  prefill?: string[];
}

export interface DesktopPublishAdapterOptions {
  platform: string;
  version: string;
  anchors: PublishAdapterAnchors;
  page: PublishPagePort;
  /** 当前平台官方创作页地址；与页面导航使用同一常量。 */
  url?: string;
  /** REF41 F5：服务端策略闸；生产必填，非生产单测可省略。 */
  policy?: BrowserPolicyGate;
  /** 回读通过后只保存草稿（小红书红线：不进入提交分支）。 */
  saveDraftAfterReadback?: boolean;
}

function expectedAccountName(req: PublishFillRequest): string {
  const fromRequest = typeof req.accountName === 'string' ? req.accountName.trim() : '';
  const fromManifest = typeof req.manifest.account_name === 'string' ? req.manifest.account_name.trim() : '';
  return fromRequest || fromManifest;
}

function normalizeAccountName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function evidenceFor(platform: string, version: string): Record<string, unknown> {
  return { platform, adapter_version: version, transport: 'desktop' };
}

export function createDesktopPublishAdapter(options: DesktopPublishAdapterOptions): PublishExecutor {
  const { platform, version, anchors, page, url, policy, saveDraftAfterReadback } = options;

  async function preflight(req: PublishFillRequest): Promise<Record<string, unknown>> {
    // REF41 F5：先过服务端三道闸（策略/账号/单标签），拒绝即 policy_denied，不接触页面。
    if (policy) {
      if (!url) throw new PublishExecutorError('policy_check_unavailable', '发布适配器缺少策略检查 URL');
      if (!page.tabCount) throw new PublishExecutorError('policy_check_unavailable', '发布页面端口未实现标签页计数');
      const gate = await policy.check({
        accountId: req.accountId,
        purpose: 'publish_fill',
        url,
        tabCount: await page.tabCount(),
        action: req.explicitSubmitNow === true ? 'publish' : 'fill',
      });
      if (!gate.ok) {
        throw new PublishExecutorError('policy_denied', `浏览器任务策略拒绝：${gate.reason || 'policy_denied'}`);
      }
    }
    const actual = normalizeAccountName(await page.currentAccountName());
    const expected = normalizeAccountName(expectedAccountName(req));
    if (!expected) {
      throw new PublishExecutorError('account_identity_missing', '任务缺少账号名，无法确认当前登录账号');
    }
    if (actual !== expected) {
      throw new PublishExecutorError('account_mismatch', `当前账号 ${actual} 与任务账号 ${expected} 不一致`);
    }
    if (!(await page.hasAnchor(anchors.account))) {
      throw new PublishExecutorError('anchor_missing', `页面缺少账号锚点 ${anchors.account}`);
    }
    if (anchors.prefill && anchors.prefill.length > 0) {
      // 小红书等“先上传才出现编辑器”的平台：先验证当前阶段真实存在的锚点，
      // 上传/填写阶段自己等待标题与编辑器出现，不把正常首屏判成 anchor_missing。
      for (const anchor of anchors.prefill) {
        if (!(await page.hasAnchor(anchor))) {
          throw new PublishExecutorError('anchor_missing', `页面缺少填写前锚点 ${anchor}`);
        }
      }
    } else {
      if (!(await page.hasAnchor(anchors.title))) {
        throw new PublishExecutorError('anchor_missing', `页面缺少标题锚点 ${anchors.title}`);
      }
      if (!(await page.hasAnchor(anchors.editor))) {
        throw new PublishExecutorError('anchor_missing', `页面缺少编辑器锚点 ${anchors.editor}`);
      }
    }
    return { platform, adapter_version: version, account_name: actual, anchors_ok: true };
  }

  async function fill(req: PublishFillRequest): Promise<PublishFillResult> {
    if (req.mode === 'manual') {
      return { state: 'awaiting_user', evidence: { ...evidenceFor(platform, version), manual: true } };
    }
    if (!page.fillFields) {
      return {
        state: 'awaiting_user',
        evidence: { ...evidenceFor(platform, version), fill: 'manual_handoff' },
        errorCode: 'manual_fill_required',
        errorMessage: '当前适配器未实现自动填写，等待用户手动填写',
      };
    }
    await page.fillFields(req.manifest);
    return { state: 'filled', evidence: { ...evidenceFor(platform, version), fill: 'automatic' } };
  }

  async function readback(req: PublishFillRequest): Promise<PublishFillResult> {
    if (!page.readbackFields) {
      return {
        state: 'awaiting_user',
        readback: {},
        evidence: { ...evidenceFor(platform, version), readback: 'manual' },
      };
    }
    const actual = await page.readbackFields();
    const compared = buildPublishReadback(req.manifest, actual);
    // P3-A1：五类字段 + 截图资产。截图以 base64 交给服务端落 asset，
    // 服务端把 evidence.screenshot_base64 换成 screenshot_asset_id 后再存库。
    const screenshotBase64 = page.captureScreenshot ? await page.captureScreenshot() : '';
    const readback = {
      checked_at: new Date().toISOString(),
      adapter_version: version,
      ok: compared.ok && screenshotBase64 !== '',
      fields: compared.fields,
    };
    const evidence: Record<string, unknown> = {
      ...evidenceFor(platform, version),
      readback,
      readback_ok: readback.ok,
    };
    if (screenshotBase64) evidence.screenshot_base64 = screenshotBase64;
    if (!readback.ok) {
      return {
        state: 'failed',
        readback,
        evidence,
        errorCode: screenshotBase64 === '' ? 'readback_screenshot_missing' : 'readback_mismatch',
        errorMessage: screenshotBase64 === '' ? '回读缺少证据截图，不能进入待提交' : '回读字段与 manifest 不一致，已停止且不提交',
      };
    }
    if (saveDraftAfterReadback) {
      // 小红书红线：只保存草稿，不进入任何发布分支。保存失败要如实失败，
      // 不能把“已填写”冒充成“草稿已保存”。
      if (!page.saveDraft) {
        return {
          state: 'failed',
          readback,
          evidence,
          errorCode: 'draft_save_not_configured',
          errorMessage: '当前页面端口未实现保存草稿，内容未落草稿箱',
        };
      }
      try {
        await page.saveDraft();
      } catch (err) {
        return {
          state: 'failed',
          readback,
          evidence,
          errorCode: 'draft_save_failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      evidence.draft_saved = true;
      evidence.draft_saved_at = new Date().toISOString();
    }
    return {
      state: 'awaiting_user',
      readback,
      evidence,
    };
  }

  async function submit(req: PublishFillRequest): Promise<PublishFillResult> {
    // 小红书风控红线：OPS 不代点发布，最多填写/保存草稿；历史 submit 意图也必须拒绝。
    if (platform === 'xhs') {
      throw new PublishExecutorError('direct_submit_not_supported', '小红书不允许由 OPS 直接点击发布；请保存草稿后由用户在小红书草稿箱发布');
    }
    if (req.mode !== 'api' && req.mode !== 'desktop') {
      throw new PublishExecutorError('submit_requires_user_action', '手动通道不得自动点发布');
    }
    if (req.explicitSubmitNow !== true) {
      throw new PublishExecutorError('submit_requires_user_action', '提交必须由用户显式 submit-now 触发');
    }
    if (req.mode === 'desktop') {
      // REF41 P6-A3：submit-now 语义——桌面必须验证“恰好一个匹配的已填页面”，
      // 0 个或多个都判 submit_ambiguous，不点击；避免重复发布。
      if (!page.countFilledPages) {
        throw new PublishExecutorError('submit_not_configured', '当前适配器未实现匹配页校验，不能自动提交');
      }
      const matches = await page.countFilledPages(req);
      if (matches !== 1) {
        throw new PublishExecutorError('submit_ambiguous', `匹配的已填页面数量为 ${matches}，需要恰好 1 个`);
      }
    }
    if (!page.submitNow) {
      throw new PublishExecutorError('submit_not_configured', '当前平台未配置提交能力');
    }
    await page.submitNow();
    return {
      state: 'submitted',
      evidence: {
        ...evidenceFor(platform, version),
        submit: 'explicit_once',
        submit_verified: true,
        submit_clicked_at: new Date().toISOString(),
        matched_pages: req.mode === 'desktop' ? 1 : undefined,
      },
    };
  }

  return {
    platform,
    name: `${platform}-desktop`,
    version,
    preflight,
    fill,
    readback,
    submit,
  };
}
