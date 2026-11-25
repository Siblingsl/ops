import { createDesktopPublishAdapter } from './adapter';
import type { PublishPagePort } from './adapter';
import type { BrowserPolicyGate, PublishExecutor } from './types';
import { getXhsRulePack, type XhsRulePack } from '../platforms/rules/loader';

export const XHS_ADAPTER_VERSION = getXhsRulePack().publish_adapter_version;

// OPT-E01：版本、锚点与发布页地址由 RulePack 驱动；显式传入 rulePack 时优先使用，
// 便于单测与受控覆盖。saveDraftAfterReadback 恒为 true，绝不进入提交分支（D-222）。
export function createXhsPublishAdapter(
  page: PublishPagePort,
  policy?: BrowserPolicyGate,
  rulePack: XhsRulePack = getXhsRulePack()
): PublishExecutor {
  return createDesktopPublishAdapter({
    platform: 'xhs',
    version: rulePack.publish_adapter_version,
    // 发布页默认停在“上传视频”；title/editor 要上传图片后才出现。
    // preflight 只要求账号与“上传图文”入口，编辑器由 fill 阶段等待。
    anchors: {
      account: rulePack.anchors.account,
      title: rulePack.anchors.title,
      editor: rulePack.anchors.editor,
      prefill: [...rulePack.anchors.prefill]
    },
    page,
    url: rulePack.urls.publish,
    policy,
    // D-222：填写并回读通过后只保存草稿；发布按钮必须由用户在小红书草稿箱点击。
    saveDraftAfterReadback: true,
  });
}
