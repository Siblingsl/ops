// 41 §5 / B-05.5：平台采集前置的每日基线巡检。
//
// 只在每个 profile（设备 + 账号 + 连接）每天第一次采集前跑一次：拍 header/main/side
// 三个固定区域，与上一张“好基线”比。viewport 尺寸、缩放与裁剪区域必须固定；
// 页面加载完成条件由调用方保证（采集前的身份读取已经走完导航与 load）。
// 结果只写本地基线目录并返回摘要：changedRatio>0.02 记 schema_suspect，
// 连续 N 次才建议 schema_changed；不自行暂停采集，也不上传截图。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformLoginSession } from '../platform-login';
import { BaselineMonitor, decodePng, type BaselineCheckResult, type PixelMask } from './baseline-diff';

export interface BaselineRegionDefinition {
  name: string;
  /** 相对 viewport 的归一化矩形（0..1）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 该区域的动态掩码（相对区域）；例如右上角的时间戳/未读红点。 */
  mask?: (width: number, height: number) => PixelMask[];
}

export const BASELINE_REGIONS: ReadonlyArray<BaselineRegionDefinition> = Object.freeze([
  {
    name: 'header',
    x: 0,
    y: 0,
    width: 1,
    height: 0.14,
    // 右上角状态位（时间/未读红点）不参与比对，避免每天误报。
    mask: (width, height) => [{ x: Math.max(0, width - Math.round(width * 0.18)), y: 0, width: Math.round(width * 0.18), height: Math.max(1, Math.round(height * 0.6)) }]
  },
  { name: 'main', x: 0, y: 0.14, width: 0.72, height: 0.86 },
  { name: 'side', x: 0.72, y: 0.14, width: 0.28, height: 0.86 }
]);

export interface BaselineCaptureSummary {
  checked: boolean;
  reason?: 'disabled' | 'capture_unavailable' | 'viewport_invalid' | 'already_checked_today' | 'no_regions';
  regions: BaselineCheckResult[];
  viewport?: { width: number; height: number; deviceScaleFactor: number };
  rebase?: boolean;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function baselineDir(profileDir: string): string {
  return path.join(profileDir, 'baseline');
}

interface DailyMarker {
  date: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
}

async function readDailyMarker(profileDir: string): Promise<DailyMarker | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(baselineDir(profileDir), 'daily.json'), 'utf8')) as Partial<DailyMarker>;
    if (typeof parsed.date !== 'string' || !parsed.viewport) return null;
    if (typeof parsed.viewport.width !== 'number' || typeof parsed.viewport.height !== 'number') return null;
    return {
      date: parsed.date,
      viewport: {
        width: parsed.viewport.width,
        height: parsed.viewport.height,
        deviceScaleFactor: typeof parsed.viewport.deviceScaleFactor === 'number' ? parsed.viewport.deviceScaleFactor : 1
      }
    };
  } catch {
    return null;
  }
}

async function writeDailyMarker(profileDir: string, marker: DailyMarker): Promise<void> {
  await fs.mkdir(baselineDir(profileDir), { recursive: true });
  await fs.writeFile(path.join(baselineDir(profileDir), 'daily.json'), JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 });
}

interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
  layoutViewport?: { clientWidth?: number; clientHeight?: number };
}

/**
 * 每个 profile 每天第一次采集前调用。捕获失败/尺寸异常时安静跳过（返回 checked:false），
 * 不影响采集主链路；不抛出到 collect，避免巡检把正常采集变成失败。
 */
export async function maybeCapturePlatformBaseline(
  session: PlatformLoginSession,
  options: { force?: boolean } = {}
): Promise<BaselineCaptureSummary> {
  if (process.env.OPS_PLATFORM_BASELINE_GUARD === '0') return { checked: false, reason: 'disabled', regions: [] };
  let metrics: LayoutMetrics;
  try {
    metrics = await session.cdp.request('Page.getLayoutMetrics', {}, 10_000) as LayoutMetrics;
  } catch {
    return { checked: false, reason: 'capture_unavailable', regions: [] };
  }
  const css = metrics.cssLayoutViewport ?? metrics.cssVisualViewport ?? metrics.layoutViewport;
  const width = Math.round(typeof css?.clientWidth === 'number' ? css.clientWidth : 0);
  const height = Math.round(typeof css?.clientHeight === 'number' ? css.clientHeight : 0);
  if (width < 200 || height < 150) return { checked: false, reason: 'viewport_invalid', regions: [] };
  const deviceWidth = Math.round(typeof metrics.layoutViewport?.clientWidth === 'number' ? metrics.layoutViewport.clientWidth : width);
  const deviceScaleFactor = width > 0 ? Math.max(1, Math.round((deviceWidth / width) * 100) / 100) : 1;
  const viewport = { width, height, deviceScaleFactor };

  const marker = await readDailyMarker(session.profileDir);
  if (!options.force && marker && marker.date === today()
    && marker.viewport.width === width && marker.viewport.height === height
    && marker.viewport.deviceScaleFactor === deviceScaleFactor) {
    return { checked: false, reason: 'already_checked_today', regions: [], viewport };
  }

  const dir = baselineDir(session.profileDir);
  const monitor = new BaselineMonitor({ dir });
  const { rebase } = await monitor.recordConditions(viewport, deviceScaleFactor);
  const regions: BaselineCheckResult[] = [];
  for (const definition of BASELINE_REGIONS) {
    const x = Math.max(0, Math.round(width * definition.x));
    const y = Math.max(0, Math.round(height * definition.y));
    const regionWidth = Math.max(1, Math.min(width - x, Math.round(width * definition.width)));
    const regionHeight = Math.max(1, Math.min(height - y, Math.round(height * definition.height)));
    let png: Buffer;
    try {
      const shot = await session.cdp.request('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x, y, width: regionWidth, height: regionHeight, scale: 1 }
      }, 15_000) as { data?: unknown };
      if (typeof shot?.data !== 'string' || shot.data === '') continue;
      png = Buffer.from(shot.data, 'base64');
      // 先解码一次，确保存进去的是真实图像而不是空/截断数据。
      decodePng(png);
    } catch {
      continue;
    }
    const mask = definition.mask ? definition.mask(regionWidth, regionHeight) : undefined;
    const result = rebase
      ? await monitor.rebaseRegion(definition.name, png)
      : await monitor.checkRegion(definition.name, png, mask);
    regions.push(result);
  }
  if (regions.length === 0) return { checked: false, reason: 'no_regions', regions, viewport, rebase };
  await writeDailyMarker(session.profileDir, { date: today(), viewport });
  return { checked: true, regions, viewport, rebase };
}
