// 41 §5 / B-05：截图基线与像素比对（纯函数 + 基线存储）。
//
// 约束来自清单 5.1：
//   * PNG 最大 32 MiB、最大 16 MP（防解压炸弹）；索引色不支持；从不缩放；
//   * 判定用 YIQ 加权平方距离，threshold 是每像素颜色容差，不是变化面积；
//   * 默认 threshold=0.1，max_delta = 35215 * threshold^2；
//   * diff 图：变化像素纯红，未变化像素按 10% alpha 淡灰；
//   * 基线按设备 + 账号 + 平台 + 区域存；changedRatio>0.02 记 schema_suspect，
//     只提示不自行暂停；连续 N 次才建议 schema_changed（是否熔断由服务端决定）。
// 本文件不读写浏览器、不联网；捕获由宿主注入。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const DEFAULT_PIXEL_THRESHOLD = 0.1;
export const DEFAULT_SUSPECT_RATIO = 0.02;
export const DEFAULT_SCHEMA_SUSPECT_STREAK = 3;
export const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

export type BaselineErrorCode =
  | 'png_signature_invalid'
  | 'png_color_type_unsupported'
  | 'image_too_large'
  | 'image_too_many_pixels'
  | 'image_size_mismatch'
  | 'baseline_read_failed';

export class BaselineImageError extends Error {
  readonly code: BaselineErrorCode;
  constructor(code: BaselineErrorCode, message: string) {
    super(message);
    this.name = 'BaselineImageError';
    this.code = code;
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA，每像素 4 字节。 */
  data: Buffer;
}

export interface PixelMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareResult {
  matches: boolean;
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  threshold: number;
}

// PNG 头解析不依赖 pngjs：先做尺寸/颜色类型/字节数限制，避免把炸弹交给解码器。
export function readPngHeader(buffer: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  if (buffer.length < 33 || PNG_SIGNATURE.some((byte, index) => buffer[index] !== byte)) {
    throw new BaselineImageError('png_signature_invalid', '不是合法的 PNG 文件');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  return { width, height, bitDepth, colorType };
}

export function assertPngLimits(buffer: Buffer): void {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new BaselineImageError('image_too_large', `PNG 超过 ${MAX_IMAGE_BYTES} 字节上限`);
  }
  const header = readPngHeader(buffer);
  // 清单只放行 RGBA/RGB/灰度/灰度+alpha；索引色（3）明确拒绝。
  if (![0, 2, 4, 6].includes(header.colorType)) {
    throw new BaselineImageError('png_color_type_unsupported', `不支持的 PNG 颜色类型 ${header.colorType}`);
  }
  if (header.width <= 0 || header.height <= 0) {
    throw new BaselineImageError('png_signature_invalid', 'PNG 尺寸非法');
  }
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new BaselineImageError('image_too_many_pixels', `PNG 像素数 ${header.width}x${header.height} 超过 16 MP 上限`);
  }
}

/** 解码 PNG。从不缩放；解码后再用 width/height 断言两边一致。 */
export function decodePng(buffer: Buffer): DecodedImage {
  assertPngLimits(buffer);
  const decoded = PNG.sync.read(buffer);
  if (decoded.width <= 0 || decoded.height <= 0 || decoded.data.length !== decoded.width * decoded.height * 4) {
    throw new BaselineImageError('png_signature_invalid', 'PNG 解码结果非法');
  }
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

export function assertSameSize(before: DecodedImage, after: DecodedImage): void {
  if (before.width !== after.width || before.height !== after.height) {
    throw new BaselineImageError(
      'image_size_mismatch',
      `两边尺寸不一致：${before.width}x${before.height} vs ${after.width}x${after.height}（不缩放，尺寸不一致直接报错）`
    );
  }
}

// YIQ 加权平方距离（与 pixelmatch 的 colorDelta 兼容），最大 35215。
export function colorDelta(before: Buffer, after: Buffer, offset: number): number {
  const r1 = before[offset];
  const g1 = before[offset + 1];
  const b1 = before[offset + 2];
  const a1 = before[offset + 3];
  const r2 = after[offset];
  const g2 = after[offset + 1];
  const b2 = after[offset + 2];
  const a2 = after[offset + 3];
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  const y = r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
  const i = r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
  const q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  const alpha = a1 === a2 ? 1 : 1 - Math.abs(a1 - a2) / 255;
  return delta * alpha;
}

function maxDelta(threshold: number): number {
  const value = Math.max(0, Math.min(1, threshold));
  return 35_215 * value * value;
}

function maskedAt(mask: ReadonlyArray<PixelMask> | undefined, x: number, y: number): boolean {
  if (!mask || mask.length === 0) return false;
  return mask.some((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

/**
 * 比对两张 PNG（RGBA）。mask 命中的像素视为“未变化”，用于屏蔽时间戳/未读红点等动态区域。
 * 返回 matches/changedPixels/totalPixels/changedRatio/width/height。
 */
export function comparePng(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  options: { threshold?: number; mask?: ReadonlyArray<PixelMask> } = {}
): CompareResult {
  const threshold = options.threshold ?? DEFAULT_PIXEL_THRESHOLD;
  const before = decodePng(beforeBuffer);
  const after = decodePng(afterBuffer);
  assertSameSize(before, after);
  const deltaLimit = maxDelta(threshold);
  const totalPixels = before.width * before.height;
  let changedPixels = 0;
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (maskedAt(options.mask, x, y)) continue;
      const offset = (y * before.width + x) * 4;
      const same = before.data[offset] === after.data[offset]
        && before.data[offset + 1] === after.data[offset + 1]
        && before.data[offset + 2] === after.data[offset + 2]
        && before.data[offset + 3] === after.data[offset + 3];
      if (!same && colorDelta(before.data, after.data, offset) > deltaLimit) changedPixels += 1;
    }
  }
  return {
    matches: changedPixels === 0,
    changedPixels,
    totalPixels,
    changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    width: before.width,
    height: before.height,
    threshold
  };
}

function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}

function blend(value: number, alpha: number): number {
  return 255 * (1 - alpha) + value * alpha;
}

/** 生成 diff PNG：变化像素纯红 [255,0,0,255]，未变化像素按 10% alpha 淡灰。 */
export function buildDiffPng(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  options: { threshold?: number; mask?: ReadonlyArray<PixelMask> } = {}
  ): Buffer {
  const threshold = options.threshold ?? DEFAULT_PIXEL_THRESHOLD;
  const before = decodePng(beforeBuffer);
  const after = decodePng(afterBuffer);
  assertSameSize(before, after);
  const deltaLimit = maxDelta(threshold);
  const out = Buffer.alloc(before.width * before.height * 4);
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      const offset = (y * before.width + x) * 4;
      const masked = maskedAt(options.mask, x, y);
      const same = before.data[offset] === after.data[offset]
        && before.data[offset + 1] === after.data[offset + 1]
        && before.data[offset + 2] === after.data[offset + 2]
        && before.data[offset + 3] === after.data[offset + 3];
      if (!same && !masked && colorDelta(before.data, after.data, offset) > deltaLimit) {
        out[offset] = 255;
        out[offset + 1] = 0;
        out[offset + 2] = 0;
        out[offset + 3] = 255;
      } else {
        const alpha = 0.1 * (after.data[offset + 3] / 255);
        const gray = Math.round(blend(rgb2y(after.data[offset], after.data[offset + 1], after.data[offset + 2]), alpha));
        out[offset] = gray;
        out[offset + 1] = gray;
        out[offset + 2] = gray;
        out[offset + 3] = 255;
      }
    }
  }
  const image = new PNG({ width: before.width, height: before.height });
  image.data = out;
  return PNG.sync.write(image);
}

export type BaselineRegionStatus = 'baseline_created' | 'stable' | 'schema_suspect' | 'schema_changed_suggested' | 'size_mismatch';

export interface BaselineCheckResult {
  region: string;
  status: BaselineRegionStatus;
  streak: number;
  changedPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  recommendation: 'none' | 'watch' | 'check_mapping';
  message?: string;
}

export interface BaselineMeta {
  version: 1;
  updatedAt: string;
  deviceScaleFactor?: number;
  viewport?: { width: number; height: number };
  streak: Record<string, number>;
}

export interface BaselineMonitorOptions {
  /** profile 目录下的 baseline 子目录；按账号/连接天然隔离（调用方只传自己的 profileDir）。 */
  dir: string;
  threshold?: number;
  suspectRatio?: number;
  streakLimit?: number;
  /** 所有区域共用的动态区域掩码（图像坐标）。 */
  mask?: ReadonlyArray<PixelMask>;
}

function safeRegionName(region: string): string {
  const name = String(region || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return name || 'region';
}

export class BaselineMonitor {
  readonly dir: string;
  readonly threshold: number;
  readonly suspectRatio: number;
  readonly streakLimit: number;
  readonly mask: ReadonlyArray<PixelMask>;
  private meta: BaselineMeta | null = null;

  constructor(options: BaselineMonitorOptions) {
    this.dir = options.dir;
    this.threshold = options.threshold ?? DEFAULT_PIXEL_THRESHOLD;
    this.suspectRatio = options.suspectRatio ?? DEFAULT_SUSPECT_RATIO;
    this.streakLimit = options.streakLimit ?? DEFAULT_SCHEMA_SUSPECT_STREAK;
    // 掩码由调用方按区域传入；默认不屏蔽任何像素（避免把真实改版也屏蔽掉）。
    this.mask = options.mask ?? [];
  }

  private metaPath(): string {
    return path.join(this.dir, 'meta.json');
  }

  private baselinePath(region: string): string {
    return path.join(this.dir, `${safeRegionName(region)}.png`);
  }

  async loadMeta(): Promise<BaselineMeta> {
    if (this.meta) return this.meta;
    try {
      const raw = await fs.readFile(this.metaPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<BaselineMeta>;
      this.meta = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        deviceScaleFactor: typeof parsed.deviceScaleFactor === 'number' ? parsed.deviceScaleFactor : undefined,
        viewport: parsed.viewport && typeof parsed.viewport.width === 'number' && typeof parsed.viewport.height === 'number'
          ? { width: parsed.viewport.width, height: parsed.viewport.height }
          : undefined,
        streak: parsed.streak && typeof parsed.streak === 'object' ? { ...parsed.streak } : {}
      };
    } catch {
      this.meta = { version: 1, updatedAt: new Date().toISOString(), streak: {} };
    }
    return this.meta;
  }

  private async saveMeta(patch: Partial<BaselineMeta>): Promise<void> {
    const current = await this.loadMeta();
    this.meta = {
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceScaleFactor: patch.deviceScaleFactor ?? current.deviceScaleFactor,
      viewport: patch.viewport ?? current.viewport,
      streak: { ...current.streak, ...(patch.streak ?? {}) }
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.metaPath(), JSON.stringify(this.meta, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * 比对单区域。无基线 → 建基线；比率 ≤ suspectRatio → 滚动更新基线并清零计数；
   * > suspectRatio → 计数 +1（保留上一张好基线），达 streakLimit 只给 schema_changed_suggested，
   * 不自行暂停、不删基线。
   */
  async checkRegion(region: string, png: Buffer, maskOverride?: ReadonlyArray<PixelMask>): Promise<BaselineCheckResult> {
    const name = safeRegionName(region);
    const regionMask = maskOverride ?? this.mask;
    const baseline = this.baselinePath(name);
    let previous: Buffer | null = null;
    try {
      previous = await fs.readFile(baseline);
    } catch {
      previous = null;
    }
    if (!previous) {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(baseline, png, { mode: 0o600 });
      const meta = await this.loadMeta();
      await this.saveMeta({ streak: { ...meta.streak, [name]: 0 } });
      const decoded = decodePng(png);
      return {
        region: name,
        status: 'baseline_created',
        streak: 0,
        changedPixels: 0,
        changedRatio: 0,
        width: decoded.width,
        height: decoded.height,
        recommendation: 'none'
      };
    }
    let compared: CompareResult;
    try {
      compared = comparePng(previous, png, { threshold: this.threshold, mask: regionMask });
    } catch (error) {
      const message = error instanceof Error ? error.message : '基线比对失败';
      const streak = await this.bumpStreak(name);
      return {
        region: name,
        status: 'size_mismatch',
        streak,
        changedPixels: 0,
        changedRatio: 1,
        width: 0,
        height: 0,
        recommendation: 'check_mapping',
        message
      };
    }
    if (compared.changedRatio > this.suspectRatio) {
      const streak = await this.bumpStreak(name);
      const suggested = streak >= this.streakLimit;
      return {
        region: name,
        status: suggested ? 'schema_changed_suggested' : 'schema_suspect',
        streak,
        changedPixels: compared.changedPixels,
        changedRatio: compared.changedRatio,
        width: compared.width,
        height: compared.height,
        recommendation: suggested ? 'check_mapping' : 'watch'
      };
    }
    // 稳定：把当前图滚成下一张基线（last good baseline），并清零可疑计数。
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(baseline, png, { mode: 0o600 });
    const meta = await this.loadMeta();
    await this.saveMeta({ streak: { ...meta.streak, [name]: 0 } });
    return {
      region: name,
      status: 'stable',
      streak: 0,
      changedPixels: compared.changedPixels,
      changedRatio: compared.changedRatio,
      width: compared.width,
      height: compared.height,
      recommendation: 'none'
    };
  }

  private async bumpStreak(region: string): Promise<number> {
    const meta = await this.loadMeta();
    const streak = (meta.streak[region] ?? 0) + 1;
    await this.saveMeta({ streak: { ...meta.streak, [region]: streak } });
    return streak;
  }

  /** 跨设备/窗口尺寸变化时重建该区域基线：不拿旧尺寸图硬比，也不静默沿用旧基线。 */
  async rebaseRegion(region: string, png: Buffer): Promise<BaselineCheckResult> {
    const name = safeRegionName(region);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.baselinePath(name), png, { mode: 0o600 });
    const meta = await this.loadMeta();
    await this.saveMeta({ streak: { ...meta.streak, [name]: 0 } });
    const decoded = decodePng(png);
    return {
      region: name,
      status: 'baseline_created',
      streak: 0,
      changedPixels: 0,
      changedRatio: 0,
      width: decoded.width,
      height: decoded.height,
      recommendation: 'none',
      message: 'viewport/scale 变化，已重建基线'
    };
  }

  /** 记录本次检查的 viewport/scale；跨设备/跨窗口尺寸不共用基线（清单 5.4 风险）。 */
  async recordConditions(viewport: { width: number; height: number }, deviceScaleFactor?: number): Promise<{ rebase: boolean }> {
    const meta = await this.loadMeta();
    const rebase = meta.viewport !== undefined
      && (meta.viewport.width !== viewport.width || meta.viewport.height !== viewport.height
        || (meta.deviceScaleFactor !== undefined && deviceScaleFactor !== undefined && meta.deviceScaleFactor !== deviceScaleFactor));
    await this.saveMeta({ viewport, deviceScaleFactor });
    return { rebase };
  }
}

/** 把“连续 N 次可疑”换算成服务端现有 stop reason；本函数不触发熔断，只给调用方参考。 */
export function schemaSuspectStopReason(results: ReadonlyArray<BaselineCheckResult>): 'schema_changed' | null {
  return results.some((result) => result.status === 'schema_changed_suggested') ? 'schema_changed' : null;
}
