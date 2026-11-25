// REF41 P8：生产平台创作页地址。发布执行器把同一个地址同时用于页面导航与 F5
// 策略检查，避免适配器、页面端口和策略白名单各自维护一份容易漂移的常量。
// OPT-E01：小红书地址由 RulePack 提供，默认值等于原实测常量。
import { getXhsRulePack } from '../platforms/rules/loader';

export const PLATFORM_PUBLISH_URLS: Readonly<Record<string, string>> = Object.freeze({
  xhs: getXhsRulePack().urls.publish,
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish'
});

export function platformPublishUrl(platform: string): string | undefined {
  return PLATFORM_PUBLISH_URLS[platform];
}
