import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

// OPT-U03（docs/43 §4）：小红书填草稿失败「一键人工接管兜底包」的本机落盘通道。
// 业务页只传 workId 与图片字节；扩展名、张数、单张/总量上限全部在本机二次校验，
// 落盘根目录锁死在 app.getPath('temp')/ops-xhs-manual-pack 的独立子目录，
// 返回值只含张数与安全文件名，绝不回传本机绝对路径。

export const PUBLISH_PACK_XHS_IMAGES_CHANNEL = 'publish-pack:open-xhs-images';

export const XHS_MANUAL_PACK_MAX_FILES = 18;
const XHS_MANUAL_PACK_MAX_FILE_BYTES = 20 * 1024 * 1024;
const XHS_MANUAL_PACK_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const XHS_MANUAL_PACK_WORK_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const XHS_MANUAL_PACK_ALLOWED_EXT = new Set(['png', 'jpg', 'webp', 'gif']);
const XHS_MANUAL_PACK_ROOT = 'ops-xhs-manual-pack';

export type XhsManualImageFile = { ext: string; bytes: Uint8Array };
export type XhsManualImageExportResult =
  | { ok: false; code: string; message: string }
  | { ok: true; count: number; fileNames: string[] };

export type XhsManualImageExportDeps = {
  tempRoot: string;
  openPath: (dir: string) => Promise<string>;
  now?: () => number;
};

/** 导出序号：第 1 张固定 01_封面，其余 02、03…（与发布包图片顺序一致）。 */
export function buildXhsManualImageFileName(index: number, ext: string): string {
  if (index === 0) return `01_封面.${ext}`;
  return `${String(index + 1).padStart(2, '0')}.${ext}`;
}

function failure(code: string, message: string): XhsManualImageExportResult {
  return { ok: false, code, message };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** 严格入参校验：只接受 { workId, files:[{ ext, bytes }] }，任何多余键整份拒绝。 */
function parseExportInput(raw: unknown): { workId: string; files: XhsManualImageFile[] } | null {
  const value = asRecord(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'files,workId') return null;
  const workId = value.workId;
  if (typeof workId !== 'string' || !XHS_MANUAL_PACK_WORK_ID.test(workId)) return null;
  const rawFiles = value.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > XHS_MANUAL_PACK_MAX_FILES) return null;
  const files: XhsManualImageFile[] = [];
  let totalBytes = 0;
  for (const item of rawFiles) {
    const file = asRecord(item);
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,ext') return null;
    if (typeof file.ext !== 'string' || !XHS_MANUAL_PACK_ALLOWED_EXT.has(file.ext)) return null;
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : null;
    if (!bytes || bytes.byteLength < 1 || bytes.byteLength > XHS_MANUAL_PACK_MAX_FILE_BYTES) return null;
    totalBytes += bytes.byteLength;
    files.push({ ext: file.ext, bytes });
  }
  if (totalBytes > XHS_MANUAL_PACK_MAX_TOTAL_BYTES) return null;
  return { workId, files };
}

/**
 * exportXhsManualImageFolder 把图片按序写进 tempRoot/<workId>-<timestamp>/ 并打开文件夹。
 * shell.openPath 契约：返回 "" 才算成功，非空字符串是失败原因；失败时只回固定文案，不回传路径。
 */
export async function exportXhsManualImageFolder(raw: unknown, deps: XhsManualImageExportDeps): Promise<XhsManualImageExportResult> {
  const input = parseExportInput(raw);
  if (!input) {
    return failure('invalid_argument', '图片导出参数无效：请确认作品标识与 1–18 张 png/jpg/webp/gif 图片的大小限制。');
  }
  const root = path.resolve(deps.tempRoot);
  const stamp = (deps.now ? deps.now() : Date.now()).toString();
  const exportDir = path.resolve(root, `${input.workId}-${stamp}`);
  // 目标必须是 root 下的独立子目录：既排除 root 本身，也排除同前缀的兄弟路径。
  if (!exportDir.startsWith(`${root}${path.sep}`)) {
    return failure('invalid_argument', '图片导出参数无效：导出目录越界。');
  }
  const fileNames = input.files.map((file, index) => buildXhsManualImageFileName(index, file.ext));
  try {
    await fs.mkdir(exportDir, { recursive: true });
    await Promise.all(input.files.map((file, index) => fs.writeFile(path.join(exportDir, fileNames[index]), file.bytes)));
  } catch {
    return failure('write_failed', '图片导出失败，请重试');
  }
  let opened = '';
  try {
    opened = await deps.openPath(exportDir);
  } catch {
    opened = 'open_failed';
  }
  // Electron shell.openPath 只有在文件夹成功打开时才返回空字符串。
  if (opened !== '') {
    return failure('open_folder_failed', '无法打开系统文件夹，请重试');
  }
  return { ok: true, count: fileNames.length, fileNames };
}

/** 业务窗口来源守卫：与 ipc/cx.ts 同口径（宿主存活、同一 webContents 主框架、业务 URL）。 */
function isTrustedBusinessSender(event: IpcMainInvokeEvent, host: BrowserWindow | null, isBusinessUrl: (url: string) => boolean): boolean {
  const senderFrame = event.senderFrame;
  return Boolean(host && !host.isDestroyed() && event.sender === host.webContents
    && senderFrame && senderFrame === event.sender.mainFrame && isBusinessUrl(senderFrame.url)
    && isBusinessUrl(event.sender.getURL()));
}

export function registerPublishPackIpcHandlers(deps: {
  ipcHandle: <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => void;
  businessWindow: () => BrowserWindow | null;
  isBusinessUrl: (url: string) => boolean;
  // 单测注入点：真实运行时用 app.getPath('temp') 与 shell.openPath，业务页永远看不到根目录。
  tempRoot?: () => string;
  openPath?: (dir: string) => Promise<string>;
  now?: () => number;
}): void {
  const { ipcHandle, businessWindow, isBusinessUrl, tempRoot, openPath, now } = deps;
  ipcHandle(PUBLISH_PACK_XHS_IMAGES_CHANNEL, async (event, raw) => {
    if (!isTrustedBusinessSender(event, businessWindow(), isBusinessUrl)) {
      return failure('not_business_window', '不允许此窗口导出小红书图片。');
    }
    return exportXhsManualImageFolder(raw, {
      tempRoot: tempRoot ? tempRoot() : path.join(app.getPath('temp'), XHS_MANUAL_PACK_ROOT),
      openPath: openPath ?? ((dir: string) => shell.openPath(dir)),
      now,
    });
  });
}
