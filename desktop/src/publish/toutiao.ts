import { createDesktopPublishAdapter } from './adapter';
import type { PublishPagePort } from './adapter';
import { PLATFORM_PUBLISH_URLS } from './platform-urls';
import type { BrowserPolicyGate, PublishExecutor } from './types';

export const TOUTIAO_ADAPTER_VERSION = 'toutiao-fill-v1';

export function createToutiaoPublishAdapter(page: PublishPagePort, policy?: BrowserPolicyGate): PublishExecutor {
  return createDesktopPublishAdapter({
    platform: 'toutiao',
    version: TOUTIAO_ADAPTER_VERSION,
    anchors: { account: 'toutiao-account', title: 'toutiao-title', editor: 'toutiao-editor' },
    page,
    url: PLATFORM_PUBLISH_URLS.toutiao,
    policy,
  });
}
