import { createDesktopPublishAdapter } from './adapter';
import type { PublishPagePort } from './adapter';
import { PLATFORM_PUBLISH_URLS } from './platform-urls';
import type { BrowserPolicyGate, PublishExecutor } from './types';

export const XHS_ADAPTER_VERSION = 'xhs-fill-v1';

export function createXhsPublishAdapter(page: PublishPagePort, policy?: BrowserPolicyGate): PublishExecutor {
  return createDesktopPublishAdapter({
    platform: 'xhs',
    version: XHS_ADAPTER_VERSION,
    anchors: { account: 'xhs-account', title: 'xhs-title', editor: 'xhs-editor' },
    page,
    url: PLATFORM_PUBLISH_URLS.xhs,
    policy,
  });
}
