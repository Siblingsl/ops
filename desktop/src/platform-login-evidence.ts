// B-01.6 / B-03.7 真实登录取证：默认关闭，只有 OPS_PLATFORM_LOGIN_EVIDENCE=1 时写本地 JSONL。
//
// 只记录风控分类所需字段；URL 去掉 query/hash，不写 cookie/token/手机号/账号标识。
// 该记录只用于 E 项验收取证，不改变登录流程、不阻塞轮询、不影响运行时不开启时的行为。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChallengeOutcome } from './platforms/challenge-detect';

export const LOGIN_CHALLENGE_EVIDENCE_FILE = 'platform-login-challenge-evidence.jsonl';

export interface LoginChallengeEvidenceInput {
  platform: string;
  outcome: ChallengeOutcome;
  at?: string;
}

/** 只保留 http(s) 的 origin + pathname；无效/非 http(s) 返回空串。 */
export function redactEvidenceUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

export function buildLoginChallengeEvidenceLine(input: LoginChallengeEvidenceInput): string {
  const outcome = input.outcome;
  return JSON.stringify({
    ts: input.at ?? new Date().toISOString(),
    platform: input.platform,
    vendor: outcome.vendor,
    kind: outcome.kind,
    status: outcome.status,
    recommendation: outcome.recommendation,
    signal: outcome.signal,
    url: redactEvidenceUrl(outcome.url),
    waitedMs: outcome.waitedMs
  });
}

export function loginChallengeEvidenceEnabled(): boolean {
  return process.env.OPS_PLATFORM_LOGIN_EVIDENCE === '1';
}

/** 追加一行证据；未开启返回 null，写入失败由调用方吞掉，不阻断登录。 */
export async function appendLoginChallengeEvidence(
  dir: string,
  input: LoginChallengeEvidenceInput
): Promise<string | null> {
  if (!loginChallengeEvidenceEnabled()) return null;
  const file = path.join(dir, LOGIN_CHALLENGE_EVIDENCE_FILE);
  await fs.appendFile(file, `${buildLoginChallengeEvidenceLine(input)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}
