const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const srcDir = path.join(__dirname, '..', 'src');
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.ts'), 'utf8');
const clientSrc = fs.readFileSync(path.join(srcDir, 'desktop-client.ts'), 'utf8');
const platformClientSrc = fs.readFileSync(path.join(srcDir, 'platform-client.ts'), 'utf8');

// DEV-PS33/34 静态校验：自动采集能跑起来依赖三件事，缺一条链路就断。
// 这三条都是实测中真实缺失过的，用源码契约锁住防止回退。

test('presence 心跳必须存在且按 30 秒上报', () => {
  // 服务端 presenceTTL 是 90 秒、调度每 10 分钟一次：没有周期性 presence，
  // 调度时设备永远被判离线（20 文档 §5.2）。
  assert.match(mainSrc, /startPlatformPresence/);
  assert.match(mainSrc, /PLATFORM_PRESENCE_INTERVAL_MS\s*=\s*30_000/);
  // 启动时立即发一次，否则刚启动的客户端在调度眼里仍是离线。
  assert.match(mainSrc, /立即发一次/);
  // 退出时必须停止，避免进程悬挂。
  assert.match(mainSrc, /stopPlatformPresence/);
  // 只定义不调用等于没有心跳：必须在启动流程里真的被调用。
  assert.match(mainSrc, /^\s*startPlatformPresence\(\);/m, '启动流程必须调用 startPlatformPresence');
});

test('后台 claim 循环必须存在：只有 presence 没有 claim 时任务会一直排队', () => {
  assert.match(mainSrc, /startPlatformClaimLoop/);
  assert.match(mainSrc, /PLATFORM_CLAIM_INTERVAL_MS/);
  assert.match(mainSrc, /stopPlatformClaimLoop/);
  // 同一时刻只允许一个采集：浏览器与 profile 不能并发。
  assert.match(mainSrc, /collectInFlight/);
  // 登录进行中不得抢 profile。
  assert.match(mainSrc, /platformLoginFlow\.active/);
});

test('接管已领任务时必须以另一个 client 实例 adopt，否则提交会报没有任务', () => {
  // 后台循环用一个实例 claim，采集流程内部新建自己的实例（独立提交状态），
  // 新实例不知道已有 run 时会报"当前没有已领取的平台采集任务"。
  assert.match(platformClientSrc, /adopt\(run: PlatformClaimedRun\)/);
  assert.match(mainSrc, /client\.adopt\(run\)/);
});

test('采集必须用连接命名空间的 profile，不能用账号 slot', () => {
  // 账号 slot 只存归属元数据，里面**没有**平台登录态；
  // 用它当 profileDir 会让浏览器跳 /login?redirectReason=401。
  assert.match(mainSrc, /profileDir = connectionProfileDir\(/);
  assert.match(mainSrc, /connectionNamespaceId/);
  // 反向断言：不能再把 stored.profileDir 当作采集目录。
  assert.equal(/const profileDir = stored\.profileDir/.test(mainSrc), false,
    '采集目录不能取自账号 slot（stored.profileDir）');
});

test('登录成功后两个平台都要写账号 slot 的归属 meta', () => {
  // 采集侧 readAccountProfile 依赖这个 meta 判断"这条 run 属于本机哪个账号"。
  // 只在公众号路径写、小红书漏写，会让小红书自动采集一律判 login_required。
  assert.match(mainSrc, /writeAccountProfileMeta/);
  const calls = mainSrc.match(/writeAccountProfileMeta\(\{/g) ?? [];
  assert.ok(calls.length >= 2, `两个平台都应调用，实际 ${calls.length} 处`);
  // meta 必须带 accountId，否则采集侧无法核对归属。
  assert.match(mainSrc, /accountId: input\.accountId/);
});
