const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LOGIN_CHALLENGE_EVIDENCE_FILE,
  appendLoginChallengeEvidence,
  buildLoginChallengeEvidenceLine,
  loginChallengeEvidenceEnabled,
  redactEvidenceUrl
} = require('../.build/platform-login-evidence.js');

const outcome = {
  vendor: 'cloudflare',
  kind: 'interactive',
  signal: 'cloudflare turnstile: verify you are human',
  status: 'handoff',
  url: 'https://creator.xiaohongshu.com/new/home?token=secret#frag',
  waitedMs: 0,
  recommendation: 'handoff'
};

test('B-03.7 证据：URL 只留 origin + pathname，不落 query/hash', () => {
  assert.equal(redactEvidenceUrl(outcome.url), 'https://creator.xiaohongshu.com/new/home');
  assert.equal(redactEvidenceUrl('not a url'), '');
  assert.equal(redactEvidenceUrl('file:///C:/tmp/x.html?a=1'), '');
});

test('B-03.7 证据：行内只含分类字段，不带 cookie/token/账号标识', () => {
  const line = buildLoginChallengeEvidenceLine({ platform: 'xhs', outcome, at: '2026-11-17T00:00:00.000Z' });
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'kind', 'platform', 'recommendation', 'signal', 'status', 'ts', 'url', 'vendor', 'waitedMs'
  ]);
  assert.equal(parsed.url, 'https://creator.xiaohongshu.com/new/home');
  assert.equal(parsed.kind, 'interactive');
  assert.equal(parsed.status, 'handoff');
  assert.doesNotMatch(line, /token|secret|cookie|phone/i);
});

test('B-03.7 证据：默认关闭时不落盘，开启后追加 JSONL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-login-evidence-'));
  const previous = process.env.OPS_PLATFORM_LOGIN_EVIDENCE;
  try {
    delete process.env.OPS_PLATFORM_LOGIN_EVIDENCE;
    assert.equal(loginChallengeEvidenceEnabled(), false);
    assert.equal(await appendLoginChallengeEvidence(dir, { platform: 'xhs', outcome }), null);
    const file = path.join(dir, LOGIN_CHALLENGE_EVIDENCE_FILE);
    assert.equal(fs.existsSync(file), false);

    process.env.OPS_PLATFORM_LOGIN_EVIDENCE = '1';
    assert.equal(loginChallengeEvidenceEnabled(), true);
    const written = await appendLoginChallengeEvidence(dir, { platform: 'xhs', outcome, at: '2026-11-17T00:00:00.000Z' });
    assert.equal(written, file);
    await appendLoginChallengeEvidence(dir, { platform: 'wechat_mp', outcome, at: '2026-11-17T00:00:01.000Z' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).platform, 'xhs');
    assert.equal(JSON.parse(lines[1]).platform, 'wechat_mp');
  } finally {
    if (previous === undefined) delete process.env.OPS_PLATFORM_LOGIN_EVIDENCE;
    else process.env.OPS_PLATFORM_LOGIN_EVIDENCE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
