const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NetworkCaptureBudget,
  Redactor,
  MAX_ENTRIES,
  MAX_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
  DEFAULT_MAX_DURATION_MS,
  FINALIZER_CONCURRENCY,
  REDACTED
} = require('../.build/platforms/network-redaction.js');

test('B-06.1 采集预算：1000 条 / 1 MiB / 25 MiB / 30 分钟 / 并发 4', () => {
  assert.equal(MAX_ENTRIES, 1000);
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
  assert.equal(MAX_TOTAL_BODY_BYTES, 25 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_DURATION_MS, 30 * 60 * 1000);
  assert.equal(FINALIZER_CONCURRENCY, 4);
  const budget = new NetworkCaptureBudget();
  assert.deepEqual(budget.consider({ bodyBytes: 2, durationMs: 10 }), { allowed: true });
  assert.deepEqual(budget.consider({ bodyBytes: MAX_BODY_BYTES + 1, durationMs: 0 }), { allowed: false, reason: 'TOO_LARGE' });
  budget.stop('UNSUPPORTED_ENCODING');
  assert.deepEqual(budget.consider({ bodyBytes: 1, durationMs: 0 }), { allowed: false, reason: 'UNSUPPORTED_ENCODING' });
});

test('B-06.1 预算累计与超时停止；finalizer 并发上限', () => {
  const budget = new NetworkCaptureBudget({ maxEntries: 2, maxBodyBytes: 10, maxTotalBodyBytes: 100, maxDurationMs: 100, concurrency: 4 });
  assert.equal(budget.consider({ bodyBytes: 5, durationMs: 60 }).allowed, true);
  assert.equal(budget.consider({ bodyBytes: 5, durationMs: 40 }).allowed, true, '正好 100ms 仍允许');
  assert.equal(budget.consider({ bodyBytes: 1, durationMs: 0 }).reason, 'BUDGET_USED', '第三条超过 maxEntries=2');
  const b2 = new NetworkCaptureBudget();
  for (let i = 0; i < 4; i += 1) assert.equal(b2.beginFinalize(), true);
  assert.equal(b2.beginFinalize(), false);
  b2.endFinalize();
  assert.equal(b2.beginFinalize(), true);
  const b3 = new NetworkCaptureBudget({ maxEntries: 1, maxBodyBytes: 10, maxTotalBodyBytes: 100, maxDurationMs: 1000 });
  assert.equal(b3.consider({ bodyBytes: 1, durationMs: 0 }).allowed, true);
  assert.equal(b3.consider({ bodyBytes: 1, durationMs: 0 }).reason, 'BUDGET_USED');
});

test('B-06.2 名字匹配：authorization/cookie/token/xsrf 一律替换', () => {
  const r = new Redactor();
  const headers = r.redactHeaders({
    Authorization: 'Bearer abcdef123456',
    Cookie: 'sid=abcdef123456',
    'X-XSRF-Token': 'abcdef123456',
    'X-Trace': 'normal',
  });
  assert.equal(headers.Authorization, REDACTED);
  assert.equal(headers.Cookie, REDACTED);
  assert.equal(headers['X-XSRF-Token'], REDACTED);
  assert.equal(headers['X-Trace'], 'normal');
});

test('B-06.2 名字匹配：手机号/邮箱等 PII 字段也被替换', () => {
  const r = new Redactor();
  assert.equal(r.redactField('phone', '13800138000'), REDACTED);
  assert.equal(r.redactField('mobile', '13800138000'), REDACTED);
  assert.equal(r.redactField('email', 'person@example.com'), REDACTED);
});

test('B-06.2 一次性字段任意长度替换：otp=123456 即使 6 位', () => {
  const r = new Redactor();
  assert.equal(r.redactField('otp', '123456'), REDACTED);
  assert.equal(r.redactField('password', 'abc'), REDACTED);
  assert.equal(r.redactField('pin', '1234'), REDACTED);
});

test('B-06.3 值记忆：同一值在普通字段/正文再次出现也替换；短值 abc 不误伤', () => {
  const r = new Redactor();
  r.redactField('token', 'abcdef123456');
  assert.equal(r.redactField('title', 'prefix abcdef123456 suffix'), `prefix ${REDACTED} suffix`);
  assert.equal(r.redactField('title', 'abc'), 'abc', '非一次性短值不替换');
});

test('B-06.4 URL：query 按名字洗，path 长随机段才洗，fragment 丢弃', () => {
  const r = new Redactor();
  r.redactField('token', 'abcdef123456');
  const url = r.redactUrl('https://mp.weixin.qq.com/cgi-bin/home?token=abcdef123456&page=2#frag');
  assert.match(url, /token=%5Bredacted%5D|token=\[redacted\]/);
  assert.match(url, /page=2/);
  assert.doesNotMatch(url, /abcdef123456/);
  assert.doesNotMatch(url, /#frag/);
  const long = 'Abcdef1234567890abcdef1234567890';
  const tokenUrl = r.redactUrl(`https://x.test/api/${long}/list`);
  assert.match(tokenUrl, /%5Bredacted%5D|\[redacted\]/);
  assert.doesNotMatch(tokenUrl, new RegExp(long));
});

test('B-06.5 JSON 递归脱敏：嵌套 token/password 与已知值', () => {
  const r = new Redactor();
  const out = r.redactJson({
    data: { token: 'abcdef123456', password: 'p', list: [{ name: 'ok', note: 'see abcdef123456' }] },
  });
  assert.deepEqual(out, { data: { token: REDACTED, password: REDACTED, list: [{ name: 'ok', note: `see ${REDACTED}` }] } });
});

test('B-06.5 form 按字段名脱敏', () => {
  const r = new Redactor();
  const out = r.redactForm('username=ops&password=secret&csrf_token=abcdef123456');
  assert.match(out, /username=ops/);
  assert.match(out, /password=%5Bredacted%5D|password=\[redacted\]/);
  assert.doesNotMatch(out, /secret/);
});

test('B-06.5 multipart：filename 保留、secret part 值替换', () => {
  const r = new Redactor();
  const boundary = 'X-BOUNDARY';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="a.txt"',
    'Content-Type: text/plain',
    '',
    'file-content',
    `--${boundary}`,
    'Content-Disposition: form-data; name="password"',
    '',
    'secret-value',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const out = r.redactMultipart(body, boundary);
  assert.match(out.body, /filename="a.txt"/);
  assert.match(out.body, /file-content/);
  assert.doesNotMatch(out.body, /secret-value/);
  assert.match(out.body, new RegExp(REDACTED));
});

test('B-06.5 JSON 无法解析：body 为空并标 UNREDACTABLE', () => {
  const r = new Redactor();
  assert.deepEqual(r.redactBody('application/json', '{"token":'), { body: '', reason: 'UNREDACTABLE' });
  assert.deepEqual(r.redactBody('multipart/form-data', 'no boundary'), { body: '', reason: 'UNREDACTABLE' });
});
