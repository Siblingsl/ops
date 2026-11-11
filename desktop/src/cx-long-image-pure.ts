import { PNG } from 'pngjs';

export const CX_LONG_IMAGE_WIDTH = 780;
export const CX_LONG_IMAGE_CSS_WIDTH = 390;
export const CX_LONG_IMAGE_DPR = 2;
export const CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT = 8_000;
export const CX_LONG_IMAGE_MAX_CSS_HEIGHT = 30_000;
export const CX_LONG_IMAGE_MAX_OUTPUT_HEIGHT = 60_000;
export const CX_LONG_IMAGE_MAX_PIXELS = 46_800_000;
export const CX_LONG_IMAGE_MAX_HTML_BYTES = 8 * 1024 * 1024;
export const CX_LONG_IMAGE_MAX_PNG_BYTES = 64 * 1024 * 1024;
export const CX_LONG_IMAGE_MAX_CAPTURE_BYTES = 192 * 1024 * 1024;
export const CX_LONG_IMAGE_MAX_WORKING_BYTES = 768 * 1024 * 1024;

export type LongImageErrorCode = 'invalid_input' | 'render_not_ready' | 'empty_content'
  | 'long_image_invalid' | 'image_too_tall' | 'build_timeout' | 'artifact_too_large' | 'capture_busy';

export class CXLongImageError extends Error {
  constructor(readonly code: LongImageErrorCode, message: string) {
    super(message);
    this.name = 'CXLongImageError';
  }
}

export type LongImagePlan = {
  width: number;
  height: number;
  totalPixels: number;
  estimatedWorkingBytes: number;
  segments: Array<{ y: number; height: number }>;
};

export function planCXLongImage(heightCss: number, htmlBytes = 0): LongImagePlan {
  if (!Number.isSafeInteger(heightCss) || heightCss < 1) {
    throw new CXLongImageError('empty_content', '长图没有可截取的正文内容。');
  }
  if (heightCss > CX_LONG_IMAGE_MAX_CSS_HEIGHT || !Number.isSafeInteger(htmlBytes)
    || htmlBytes < 0 || htmlBytes > CX_LONG_IMAGE_MAX_HTML_BYTES) {
    throw new CXLongImageError('image_too_tall', '长图超过本机渲染资源预算。');
  }

  const height = Math.ceil(heightCss * CX_LONG_IMAGE_DPR);
  const totalPixels = CX_LONG_IMAGE_WIDTH * height;
  const segmentHeight = Math.min(height, CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT);
  const rawOutputBytes = totalPixels * 4;
  const rawSegmentBytes = CX_LONG_IMAGE_WIDTH * segmentHeight * 4;
  const estimatedWorkingBytes = rawOutputBytes * 2 + rawSegmentBytes
    + CX_LONG_IMAGE_MAX_CAPTURE_BYTES + CX_LONG_IMAGE_MAX_PNG_BYTES
    + htmlBytes + 64 * 1024 * 1024;
  if (height > CX_LONG_IMAGE_MAX_OUTPUT_HEIGHT || !Number.isSafeInteger(totalPixels) || totalPixels > CX_LONG_IMAGE_MAX_PIXELS
    || estimatedWorkingBytes > CX_LONG_IMAGE_MAX_WORKING_BYTES) {
    throw new CXLongImageError('image_too_tall', '长图超过本机像素或内存预算。');
  }

  const segments: LongImagePlan['segments'] = [];
  for (let y = 0; y < height; y += CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT) {
    segments.push({ y, height: Math.min(CX_LONG_IMAGE_SEGMENT_MAX_HEIGHT, height - y) });
  }
  return { width: CX_LONG_IMAGE_WIDTH, height, totalPixels, estimatedWorkingBytes, segments };
}

export function stitchCXLongImageSegments(encodedSegments: Buffer[], plan: LongImagePlan): Buffer {
  if (encodedSegments.length !== plan.segments.length || encodedSegments.length === 0) {
    throw new CXLongImageError('long_image_invalid', '长图分段数量与预检结果不一致。');
  }
  const encodedBytes = encodedSegments.reduce((sum, segment) => sum + segment.byteLength, 0);
  if (encodedBytes > CX_LONG_IMAGE_MAX_CAPTURE_BYTES) {
    throw new CXLongImageError('image_too_tall', '长图分段图像超过本机编码内存预算。');
  }

  const decoded = encodedSegments.map((bytes, index) => {
    let image: PNG;
    try {
      image = PNG.sync.read(bytes);
    } catch {
      throw new CXLongImageError('long_image_invalid', '长图分段 PNG 无法解码。');
    }
    const expected = plan.segments[index]!;
    if (image.width !== plan.width || image.height !== expected.height
      || image.data.byteLength !== plan.width * expected.height * 4) {
      throw new CXLongImageError('long_image_invalid', '长图分段尺寸与 DPR 预检结果不一致。');
    }
    return image.data;
  });

  const output = Buffer.allocUnsafe(plan.width * plan.height * 4);
  let y = 0;
  let firstColor: [number, number, number, number] | null = null;
  let hasColorVariation = false;
  for (let index = 0; index < decoded.length; index += 1) {
    const pixels = decoded[index]!;
    pixels.copy(output, y * plan.width * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (firstColor === null) {
        firstColor = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
      } else if (pixels[offset] !== firstColor[0] || pixels[offset + 1] !== firstColor[1]
        || pixels[offset + 2] !== firstColor[2] || pixels[offset + 3] !== firstColor[3]) {
        hasColorVariation = true;
        break;
      }
    }
    y += plan.segments[index]!.height;
  }
  if (y !== plan.height || !hasColorVariation) {
    throw new CXLongImageError('long_image_invalid', '长图内容为空或像素异常。');
  }

  const image = new PNG({ width: plan.width, height: plan.height, colorType: 6, inputColorType: 6, deflateLevel: 3 });
  image.data = output;
  const png = PNG.sync.write(image, { colorType: 6, inputColorType: 6, deflateLevel: 3 });
  if (png.byteLength > CX_LONG_IMAGE_MAX_PNG_BYTES) {
    throw new CXLongImageError('artifact_too_large', '长图 PNG 超过服务端单个产物 64 MiB 限制。');
  }
  if (png.byteLength < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(16) !== plan.width || png.readUInt32BE(20) !== plan.height) {
    throw new CXLongImageError('long_image_invalid', '长图 PNG 编码或最终尺寸无效。');
  }
  return png;
}
