const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PublishLoopLock, PUBLISH_LOOP_LOCK_MAX_AGE_MS } = require('../.build/publish-loop-lock.js');

const readLoopSources = () => [
  fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'publish-loop.ts'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'platform-loop.ts'), 'utf8')
].join('\n');

test('发布锁：同一时刻只有一个持有者，重复 acquire 返回 null', () => {
  const lock = new PublishLoopLock();
  const first = lock.acquire();
  assert.equal(typeof first, 'number');
  assert.equal(lock.isHeld(), true);
  assert.equal(lock.acquire(), null);
  assert.equal(lock.release(first), true);
  assert.equal(lock.isHeld(), false);
  const second = lock.acquire();
  assert.notEqual(second, first);
});

test('发布锁：超过最大持有时间才判定过期，未超时不误杀正常任务', () => {
  let now = 1000;
  const lock = new PublishLoopLock(60_000, () => now);
  const token = lock.acquire();
  now += 59_999;
  assert.equal(lock.isExpired(), false);
  now += 1;
  assert.equal(lock.isExpired(), true);
  assert.equal(lock.owns(token), true);
  assert.equal(lock.forceRelease(), token);
  assert.equal(lock.isHeld(), false);
});

test('发布锁：过期强制释放后，旧 tick 的 release 不能清掉新 tick 的锁', () => {
  let now = 0;
  const lock = new PublishLoopLock(10_000, () => now);
  const oldToken = lock.acquire();
  now = 11_000;
  assert.equal(lock.forceRelease(), oldToken);
  const newToken = lock.acquire();
  assert.equal(lock.release(oldToken), false);
  assert.equal(lock.isHeld(), true);
  assert.equal(lock.owns(newToken), true);
  assert.equal(lock.release(newToken), true);
  assert.equal(lock.isHeld(), false);
});

test('发布循环源码守卫：锁复位不依赖 pageSession.close，且有超时收尸', () => {
  const source = readLoopSources();
  assert.match(source, /new PublishLoopLock\(/);
  assert.match(source, /stopStuckPublishSession\(/);
  assert.match(source, /publishLock\.isExpired\(\)/);
  assert.match(source, /publishLock\.release\(token\)/);
  // 复位必须发生在页面关闭之前；不能再出现“await close 后才 publishInFlight=false”的旧写法。
  assert.doesNotMatch(source, /await pageSession\.close\(\)\.catch\(\(\) => undefined\);\s*publishInFlight/);
  assert.doesNotMatch(source, /let publishInFlight/);
  assert.ok(PUBLISH_LOOP_LOCK_MAX_AGE_MS >= 5 * 60_000);
});

test('采集循环源码守卫：发布锁占用时短延迟重试，不永久跳过 claim', () => {
  const source = readLoopSources();
  const claimLoop = source.slice(source.indexOf('function startPlatformClaimLoop'), source.indexOf('function stopPlatformClaimLoop'));
  assert.match(claimLoop, /const scheduleClaimRetry = \(\) => \{/);
  assert.match(claimLoop, /claimRetryTimer = setTimeout\(/);
  assert.match(claimLoop, /if \(publishLock\.isHeld\(\)\) \{\s*scheduleClaimRetry\(\);\s*return;\s*\}/);
  // 不能回到“锁被占用就直接 return、等下一个 30 秒”的写法；那会和发布 tick 永久撞车。
  assert.doesNotMatch(claimLoop, /if \(collectInFlight \|\| publishLock\.isHeld\(\) \|\| !desktopClient\) return;/);
  assert.match(source, /if \(claimRetryTimer\) \{\s*clearTimeout\(claimRetryTimer\);/);
});
