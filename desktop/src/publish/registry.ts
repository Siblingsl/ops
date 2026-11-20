// 桌面适配器注册表：按平台 exact 命中，不做模糊回退，避免把 xhs 任务交给头条适配器。
import type { PublishExecutor } from './types';
import { createXhsPublishAdapter } from './xhs';
import { createToutiaoPublishAdapter } from './toutiao';
import type { PublishPagePort } from './adapter';
import type { BrowserPolicyGate } from './types';

export class DesktopPublishAdapterRegistry {
  private readonly adapters = new Map<string, PublishExecutor>();

  register(adapter: PublishExecutor): void {
    if (!adapter.platform || !adapter.name || !adapter.version) {
      throw new Error('发布适配器必须有 platform/name/version');
    }
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`发布适配器重复注册: ${adapter.platform}`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: string): PublishExecutor | undefined {
    return this.adapters.get(platform);
  }

  list(): Array<{ platform: string; name: string; version: string }> {
    return [...this.adapters.values()].map((adapter) => ({
      platform: adapter.platform,
      name: adapter.name,
      version: adapter.version,
    }));
  }
}

export function createDefaultDesktopPublishAdapterRegistry(page: PublishPagePort, policy?: BrowserPolicyGate): DesktopPublishAdapterRegistry {
  const registry = new DesktopPublishAdapterRegistry();
  registry.register(createXhsPublishAdapter(page, policy));
  registry.register(createToutiaoPublishAdapter(page, policy));
  return registry;
}
