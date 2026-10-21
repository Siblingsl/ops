// 平台采集的本机 profile 管理（D-129 / 20 文档 §5.1、§5.3、§13.1）。
// 纯 Node，不依赖 Electron，便于用 node --test 直接覆盖路径、锁、配额与清理规则。
//
// 目录命名空间：platform-profiles/accounts/<OPS 登录用户 UUID>/<platform>/<connection UUID>/profile
// 第一段是登录用户，不是平台账号或工作区 ID——同一登录用户的微信与小红书连接不能共用 profile，
// 跨成员转移后新用户使用自己的命名空间。

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLATFORM_PROFILE_ROOT = 'platform-profiles';
export const PLATFORM_PROFILE_META = 'meta.json';
export const PLATFORM_PROFILE_DIR = 'profile';

// 每登录用户 2 GiB、全应用 10 GiB（§5.1）。
export const PLATFORM_PROFILE_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const PLATFORM_PROFILE_TOTAL_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export type PlatformId = 'wechat_mp' | 'xhs' | 'toutiao';

// meta.json：启动时逐项校验，任何一项不符都不能复用该目录。
export interface PlatformProfileMeta {
  version: 1;
  origin: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
  platform: PlatformId;
  connectionId: string;
  externalAccountKey: string;
  createdAt: string;
}

export class PlatformProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformProfileError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORMS: ReadonlyArray<string> = ['wechat_mp', 'xhs', 'toutiao'];

// validatePlatformId 只接受首版支持的两个平台；头条等一律拒绝，不静默降级。
export function validatePlatformId(value: string): PlatformId {
  if (!PLATFORMS.includes(value)) {
    throw new PlatformProfileError('platform_not_supported', '该平台暂不支持本机登录采集');
  }
  return value as PlatformId;
}

// profileRoot 返回全应用共用的 profile 根目录，位于应用 data 目录下。
export function profileRoot(userDataDir: string): string {
  return path.join(userDataDir, PLATFORM_PROFILE_ROOT);
}

// accountNamespace 是某个登录用户的命名空间；非 UUID 一律拒绝，避免路径注入。
export function accountNamespace(userDataDir: string, userId: string): string {
  if (!UUID_RE.test(userId)) {
    throw new PlatformProfileError('invalid_namespace', '登录用户标识无效');
  }
  return path.join(profileRoot(userDataDir), 'accounts', userId.toLowerCase());
}

// connectionProfileDir 返回某条连接的 profile 目录，并校验所有分段。
export function connectionProfileDir(
  userDataDir: string,
  input: { userId: string; platform: string; connectionId: string }
): string {
  const platform = validatePlatformId(input.platform);
  if (!UUID_RE.test(input.connectionId)) {
    throw new PlatformProfileError('invalid_namespace', '连接标识无效');
  }
  return path.join(accountNamespace(userDataDir, input.userId), platform, input.connectionId.toLowerCase(), PLATFORM_PROFILE_DIR);
}

// profileMetaPath 是被校验的元数据文件位置，与 profile 目录同级。
export function profileMetaPath(profileDir: string): string {
  return path.join(path.dirname(profileDir), PLATFORM_PROFILE_META);
}

// assertInsideNamespace 拒绝一切越出该命名空间的路径（含符号链接以外的 .. 拼接）。
export function assertInsideNamespace(namespace: string, target: string): void {
  const rel = path.relative(path.resolve(namespace), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PlatformProfileError('invalid_namespace', '目录超出该登录用户的命名空间');
  }
}

export function buildProfileMeta(input: {
  origin: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
  platform: string;
  connectionId: string;
  externalAccountKey: string;
  createdAt?: string;
  // 账号 slot 的归属字段：采集时靠它确认"这条 run 属于本机已登录的这个账号"。
  // 连接命名空间的 meta 不写这个字段（那里按连接隔离，与账号 slot 是两套目录）。
  accountId?: string;
  slotId?: string;
  browserFamily?: 'chrome' | 'edge';
}): PlatformProfileMeta {
  const meta: PlatformProfileMeta = {
    version: 1,
    origin: input.origin,
    userId: input.userId,
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    platform: validatePlatformId(input.platform),
    connectionId: input.connectionId,
    externalAccountKey: input.externalAccountKey,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  // 只在传入时写出，避免给连接命名空间的 meta 增加无意义字段。
  if (input.accountId) (meta as PlatformProfileMeta & { accountId?: string }).accountId = input.accountId;
  if (input.slotId) (meta as PlatformProfileMeta & { slotId?: string }).slotId = input.slotId;
  if (input.browserFamily) {
    (meta as PlatformProfileMeta & { browserFamily?: string }).browserFamily = input.browserFamily;
  }
  return meta;
}

// verifyProfileMeta 逐项比对。Origin、工作区或登录用户变化都不能靠移动目录解决，
// 只能拒绝复用（§5.1）。
export function verifyProfileMeta(
  meta: unknown,
  expected: { origin: string; userId: string; workspaceId: string; platform: string; connectionId: string }
): PlatformProfileMeta {
  if (!meta || typeof meta !== 'object') {
    throw new PlatformProfileError('profile_meta_invalid', '本机平台连接元数据缺失');
  }
  const m = meta as Record<string, unknown>;
  if (m.version !== 1) {
    throw new PlatformProfileError('profile_meta_invalid', '本机平台连接元数据版本不支持');
  }
  for (const key of ['origin', 'userId', 'workspaceId', 'platform', 'connectionId', 'externalAccountKey', 'createdAt']) {
    if (typeof m[key] !== 'string' || (m[key] as string).trim() === '') {
      throw new PlatformProfileError('profile_meta_invalid', '本机平台连接元数据不完整');
    }
  }
  if (!UUID_RE.test(String(m.deviceId))) {
    throw new PlatformProfileError('profile_meta_invalid', '本机平台连接元数据缺少设备标识');
  }
  const fields: Array<[string, string]> = [
    ['origin', expected.origin],
    ['userId', expected.userId.toLowerCase()],
    ['workspaceId', expected.workspaceId.toLowerCase()],
    ['platform', expected.platform],
    ['connectionId', expected.connectionId.toLowerCase()]
  ];
  for (const [key, want] of fields) {
    const got = String(m[key]).toLowerCase();
    if (got !== want.toLowerCase()) {
      // 不复用、不迁移、不覆盖：交给上层按 §5.3 处理（撤销或重新扫码）。
      throw new PlatformProfileError('profile_meta_mismatch', `本机平台连接元数据与当前上下文不一致（${key}）`);
    }
  }
  return m as unknown as PlatformProfileMeta;
}

// ---------- SingletonLock 恢复 ----------

// 解析 Chromium 的 SingletonLock（Windows 上是符号链接 "<hostname>-<pid>"，其它平台是文件内容）。
export function parseSingletonLock(raw: string): { hostname: string; pid: number } | null {
  const match = /^(.*)-(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { hostname: match[1], pid };
}

// isProcessAlive 由调用方注入，便于测试与跨平台实现。
export type ProcessAliveProbe = (pid: number) => Promise<boolean>;

// resolveLockResidue 决定遇到残留锁时该怎么办：
// - 锁能解析且进程仍存活 → busy，沿用该会话，绝不删锁；
// - 锁能解析但进程已死 → 只有这时才允许把 profile 改名成 .corrupt-<时间> 后重建；
// - 锁无法解析 → 无法证明无存活进程，同样按 busy 处理，交给人处理。
export async function resolveLockResidue(
  lockRaw: string | null,
  probe: ProcessAliveProbe,
  localHostname: string
): Promise<{ action: 'proceed' } | { action: 'busy'; reason: string } | { action: 'reclaim'; corruptName: string }> {
  if (lockRaw === null) return { action: 'proceed' };
  const parsed = parseSingletonLock(lockRaw);
  if (!parsed) {
    return { action: 'busy', reason: '锁文件无法解析，不能确认没有存活进程' };
  }
  // 其它主机的锁不可能是本机的残留，不能据此删目录。
  if (parsed.hostname !== localHostname) {
    return { action: 'busy', reason: '锁属于另一台主机，不能确认本机进程状态' };
  }
  if (await probe(parsed.pid)) {
    return { action: 'busy', reason: '同一 profile 已被一个存活进程使用' };
  }
  return { action: 'reclaim', corruptName: `.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}` };
}

// ---------- 配额 ----------

export interface DirectoryUsage {
  bytes: number;
  files: number;
}

// measureUsage 递归统计目录大小；符号链接按其自身长度计，不跟随（避免逃逸与死循环）。
export async function measureUsage(dir: string): Promise<DirectoryUsage> {
  const result: DirectoryUsage = { bytes: 0, files: 0 };
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        result.bytes += Buffer.byteLength(entry.name);
        result.files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const stat = await fs.stat(full);
        result.bytes += stat.size;
        result.files += 1;
      } catch {
        // 统计期间被删除的文件不计入。
      }
    }
  }
  return result;
}

// checkQuota 在启动采集前检查配额：超限要停新采集并提示清理，不静默删用户目录。
export async function checkQuota(
  userDataDir: string,
  userId: string,
  limits: { userBytes?: number; totalBytes?: number } = {}
): Promise<{ ok: boolean; userBytes: number; totalBytes: number; exceeded: 'user' | 'total' | null }> {
  const userLimit = limits.userBytes ?? PLATFORM_PROFILE_USER_QUOTA_BYTES;
  const totalLimit = limits.totalBytes ?? PLATFORM_PROFILE_TOTAL_QUOTA_BYTES;
  const total = await measureUsage(profileRoot(userDataDir)).then((u) => u.bytes).catch(() => 0);
  const userBytes = await measureUsage(accountNamespace(userDataDir, userId)).then((u) => u.bytes).catch(() => 0);
  const exceeded = userBytes > userLimit ? 'user' : total > totalLimit ? 'total' : null;
  return { ok: exceeded === null, userBytes, totalBytes: total, exceeded };
}

// ---------- 清理 ----------

// removeConnectionNamespace 只删该连接自己的目录，绝不整目录递归删账号命名空间。
export async function removeConnectionNamespace(
  userDataDir: string,
  input: { userId: string; platform: string; connectionId: string }
): Promise<{ removed: boolean }> {
  const namespace = accountNamespace(userDataDir, input.userId);
  const connectionDir = path.dirname(connectionProfileDir(userDataDir, input));
  assertInsideNamespace(namespace, connectionDir);
  await assertProfilePath(userDataDir, path.join(connectionDir, PLATFORM_PROFILE_DIR));
  const busy = await fs.lstat(path.join(connectionDir, PLATFORM_PROFILE_DIR, 'SingletonLock')).then(() => true, () => false);
  if (busy) return { removed: false };
  try {
    await fs.rm(connectionDir, { recursive: true, force: true });
    return { removed: true };
  } catch {
    // 浏览器仍占用目录时保持待清理状态，不强行删除。
    return { removed: false };
  }
}

// listNamespaces 返回账号命名空间下的目录快照，用于“无主目录”扫描与提示清理。
export async function listAccountNamespaces(userDataDir: string): Promise<string[]> {
  const accountsDir = path.join(profileRoot(userDataDir), 'accounts');
  try {
    const entries = await fs.readdir(accountsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listConnectionNamespaces(
  userDataDir: string,
  input: { userId: string; platform: string }
): Promise<string[]> {
  const dir = path.join(accountNamespace(userDataDir, input.userId), validatePlatformId(input.platform));
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// orphanConnections 找出本机存在、但服务端已不认识（或已被撤销）的连接目录。
// 只返回候选，不自动删除：删除前要确认浏览器未占用。
export async function orphanConnections(
  userDataDir: string,
  input: { userId: string; platform: string },
  knownConnectionIds: ReadonlyArray<string>
): Promise<string[]> {
  const known = new Set(knownConnectionIds.map((id) => id.toLowerCase()));
  const existing = await listConnectionNamespaces(userDataDir, input);
  const orphans: string[] = [];
  for (const id of existing) {
    if (known.has(id.toLowerCase())) continue;
    if (!UUID_RE.test(id)) continue;
    const profileDir = connectionProfileDir(userDataDir, { ...input, connectionId: id });
    await assertProfilePath(userDataDir, profileDir);
    let mappedId = '';
    try {
      const meta = JSON.parse(await fs.readFile(profileMetaPath(profileDir), 'utf8')) as { connectionId?: unknown };
      if (typeof meta.connectionId === 'string') mappedId = meta.connectionId.toLowerCase();
    } catch { /* 遗留没有映射的连接目录仍由用户明确清理。 */ }
    if (!known.has(mappedId)) orphans.push(id);
  }
  return orphans;
}

// namespaceFingerprint 用于日志与诊断，不含任何路径（§13.1 不回显路径）。
export function namespaceFingerprint(userId: string, platform: string, connectionId: string): string {
  return createHash('sha256').update(`${userId}\n${platform}\n${connectionId}`).digest('hex').slice(0, 16);
}

// 供测试使用的稳定临时标识。
export function newNamespaceID(): string {
  return randomUUID();
}

// D-131：slot 是本机目录定位符；服务端 connectionId 始终是业务连接唯一标识。
export interface AccountProfileScope {
  origin: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
  accountId: string;
  platform: string;
}

export interface AccountProfileMeta extends PlatformProfileMeta {
  slotId: string;
  accountId: string;
  browserFamily: 'chrome' | 'edge';
  loginOperationId?: string;
}

export function accountProfileSlot(scope: AccountProfileScope): string {
  for (const id of [scope.userId, scope.workspaceId, scope.deviceId, scope.accountId]) {
    if (!UUID_RE.test(id)) throw new PlatformProfileError('invalid_namespace', '账号会话归属无效');
  }
  validatePlatformId(scope.platform);
  const origin = new URL(scope.origin).origin;
  const hash = createHash('sha256').update(JSON.stringify([origin, scope.userId.toLowerCase(), scope.workspaceId.toLowerCase(), scope.deviceId.toLowerCase(), scope.platform, scope.accountId.toLowerCase()])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// 检查每一层，拒绝 junction / symlink；清理和读取共用此边界。
export async function assertProfilePath(userDataDir: string, profileDir: string): Promise<void> {
  const root = path.resolve(userDataDir);
  assertInsideNamespace(path.join(root, PLATFORM_PROFILE_ROOT), profileDir);
  let cursor = root;
  for (const segment of path.relative(root, profileDir).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new PlatformProfileError('invalid_namespace', '会话目录存在链接，不能安全使用');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function readAccountProfile(userDataDir: string, scope: AccountProfileScope): Promise<{ profileDir: string; meta: AccountProfileMeta | null }> {
  const slotId = accountProfileSlot(scope);
  const profileDir = connectionProfileDir(userDataDir, { ...scope, connectionId: slotId });
  await assertProfilePath(userDataDir, profileDir);
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(profileMetaPath(profileDir), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 未知目录不能被写入新归属。全新 slot 才允许创建草案。
      const exists = await fs.stat(profileDir).then(() => true, () => false);
      if (exists) throw new PlatformProfileError('profile_meta_invalid', '已有会话目录缺少归属信息');
      return { profileDir, meta: null };
    }
    throw new PlatformProfileError('profile_meta_invalid', '会话元数据无法读取');
  }
  const meta = raw as AccountProfileMeta;
  for (const key of ['userId', 'workspaceId', 'deviceId', 'accountId', 'platform'] as const) {
    if (typeof meta[key] !== 'string' || meta[key].toLowerCase() !== scope[key].toLowerCase()) throw new PlatformProfileError('profile_meta_mismatch', '本机会话归属与当前账号不一致');
  }
  if (meta.version !== 1 || meta.origin !== new URL(scope.origin).origin || meta.slotId !== slotId || !UUID_RE.test(meta.connectionId)
    || !['chrome', 'edge'].includes(meta.browserFamily) || typeof meta.externalAccountKey !== 'string') {
    throw new PlatformProfileError('profile_meta_mismatch', '本机会话元数据不匹配');
  }
  return { profileDir, meta };
}

const profileWrites = new Map<string, Promise<void>>();
export async function saveAccountProfile(userDataDir: string, profileDir: string, meta: AccountProfileMeta, expectedOperationId?: string, signal?: AbortSignal): Promise<void> {
  const previous = profileWrites.get(profileDir) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    await assertProfilePath(userDataDir, profileDir);
    const target = profileMetaPath(profileDir);
    if (expectedOperationId) {
      const current = JSON.parse(await fs.readFile(target, 'utf8')) as AccountProfileMeta;
      if (current.loginOperationId !== expectedOperationId) throw new PlatformProfileError('platform_login_stale', '旧操作不能覆盖新会话映射');
    }
    if (signal?.aborted) throw new PlatformProfileError('platform_login_cancelled', '登录操作已取消');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
    if (signal?.aborted) { await fs.unlink(temporary); throw new PlatformProfileError('platform_login_cancelled', '登录操作已取消'); }
    await fs.rename(temporary, target);
  });
  profileWrites.set(profileDir, pending);
  try { await pending; } finally { if (profileWrites.get(profileDir) === pending) profileWrites.delete(profileDir); }
}
