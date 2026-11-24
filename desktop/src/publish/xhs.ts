import { createDesktopPublishAdapter } from './adapter';
import type { PublishPagePort } from './adapter';
import { PLATFORM_PUBLISH_URLS } from './platform-urls';
import type { BrowserPolicyGate, PublishExecutor } from './types';

export const XHS_ADAPTER_VERSION = 'xhs-fill-v1';

export function createXhsPublishAdapter(page: PublishPagePort, policy?: BrowserPolicyGate): PublishExecutor {
  return createDesktopPublishAdapter({
    platform: 'xhs',
    version: XHS_ADAPTER_VERSION,
    // 发布页默认停在“上传视频”；title/editor 要上传图片后才出现。
    // preflight 只要求账号与“上传图文”入口，编辑器由 fill 阶段等待。
    anchors: { account: 'xhs-account', title: 'xhs-title', editor: 'xhs-editor', prefill: ['xhs-upload'] },
    page,
    url: PLATFORM_PUBLISH_URLS.xhs,
    policy,
    // D-222：填写并回读通过后只保存草稿；发布按钮必须由用户在小红书草稿箱点击。
    saveDraftAfterReadback: true,
  });
}
