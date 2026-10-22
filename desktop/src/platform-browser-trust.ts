// D-131：只使用本机可信签名的 Chrome / Edge，不接管日常浏览器。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { discoverPlatformBrowser, PlatformBrowserError, type BrowserCandidate } from './platform-worker';

export type LoginBrowserFamily = 'chrome' | 'edge';
const execFileAsync = promisify(execFile);

export function validBrowserSignature(family: string, value: unknown): boolean {
  const signature = value as { status?: unknown; subject?: unknown } | null;
  if (signature?.status !== 'Valid' || typeof signature.subject !== 'string') return false;
  const organization = family === 'chrome' ? 'Google LLC' : family === 'edge' ? 'Microsoft Corporation' : '';
  return !!organization && signature.subject.split(/,\s*/).some((part) => part === `O=${organization}`);
}

export async function verifyBrowserExecutable(candidate: BrowserCandidate): Promise<boolean> {
  if (process.platform !== 'win32' || !['chrome', 'edge'].includes(candidate.family)) return false;
  // 路径作为编码数据进入固定脚本，不拼接 shell 命令，也不允许页面传路径。
  const encodedPath = Buffer.from(candidate.executablePath, 'utf8').toString('base64');
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $s=Get-AuthenticodeSignature -LiteralPath $p; @{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`;
  try {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 从 PowerShell 7 启动 Node 时不能把其 PSModulePath 传给系统 PowerShell 5。
    const result = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000, maxBuffer: 8192, env: { ...process.env, PSModulePath: undefined } });
    return validBrowserSignature(candidate.family, JSON.parse(result.stdout.trim()));
  } catch { return false; }
}

export async function trustedLoginBrowsers(runtime: {
  discover?: () => Promise<BrowserCandidate[]>;
  verify?: (candidate: BrowserCandidate) => Promise<boolean>;
} = {}): Promise<BrowserCandidate[]> {
  const found = await (runtime.discover ?? discoverPlatformBrowser)();
  const trusted: BrowserCandidate[] = [];
  for (const candidate of found) {
    if (!['chrome', 'edge'].includes(candidate.family) || trusted.some((item) => item.family === candidate.family)) continue;
    if (await (runtime.verify ?? verifyBrowserExecutable)(candidate)) trusted.push(candidate);
  }
  return trusted;
}

export function selectLoginBrowser(candidates: BrowserCandidate[], family?: string): BrowserCandidate {
  const candidate = family ? candidates.find((item) => item.family === family) : candidates[0];
  if (!candidate) throw new PlatformBrowserError('platform_browser_unsupported', '未找到此连接需要的可信 Chrome／Edge，请安装或重新检测');
  return candidate;
}
