const assert = require('node:assert/strict');
const test = require('node:test');

const {
  planTrajectory,
  trajectoryDuration,
  minimumJerk,
  distance,
  noise,
  randomStart,
  AimCache,
  planClick,
  planKeys,
  planWheel,
  easeOutCubic,
  HUMAN_INPUT_CONSTANTS
} = require('../.build/platforms/human-input.js');

// 可复算的确定性随机源：按队列循环。
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('B-02A.1 轨迹常量与时长公式可复算', () => {
  const c = HUMAN_INPUT_CONSTANTS;
  assert.equal(c.MIN_DISTANCE_PX, 2);
  assert.equal(c.DURATION_BASE_MS, 70);
  assert.equal(c.DURATION_LOG_FACTOR, 90);
  assert.equal(c.DURATION_CAP_MS, 700);
  assert.equal(c.SAMPLE_MIN_MS, 8);
  assert.equal(c.SAMPLE_MAX_MS, 17);
  assert.equal(c.OVERSHOOT_DISTANCE_PX, 250);
  assert.equal(c.PRESS_DELAY_MIN_MS, 45);
  assert.equal(c.PRESS_DELAY_MAX_MS, 130);
  assert.equal(c.HOLD_MIN_MS, 60);
  assert.equal(c.HOLD_MAX_MS, 140);
  assert.equal(c.KEY_MIN_MS, 30);
  assert.equal(c.KEY_MAX_MS, 110);
  assert.equal(c.KEY_IDLE_RESET_MS, 1000);
  assert.equal(c.WHEEL_SMALL_PX, 40);
  assert.equal(c.WHEEL_BASE_PX, 140);
  assert.equal(c.WHEEL_FACTOR, 0.45);
  assert.equal(c.WHEEL_CAP_PX, 650);

  // 不缩放：直接从公式算，rng=0.5 -> 系数 1.025。
  const d = 600 - 40;
  const expected = Math.min(700, (70 + 90 * Math.log2(d / 40 + 1)) * 1.025);
  assert.ok(Math.abs(trajectoryDuration(d, seq([0.5])) - expected) < 1e-9);
  assert.equal(trajectoryDuration(1e6, seq([1])), 700);
});

test('B-02A.1 距离 <2px 返回空轨迹；轨迹点数/间隔/终点符合形状', () => {
  assert.deepEqual(planTrajectory({ x: 0, y: 0 }, { x: 1, y: 0 }), []);
  const pts = planTrajectory({ x: 0, y: 0 }, { x: 400, y: 300 }, { rng: seq([0.5, 0.6, 0.7, 0.8]), overshoot: false });
  assert.ok(pts.length > 5, `轨迹点数 ${pts.length}`);
  for (const p of pts) {
    assert.ok(p.delayMs >= 8 && p.delayMs <= 17, `每步 ${p.delayMs}ms`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  const last = pts[pts.length - 1];
  assert.ok(distance(last, { x: 400, y: 300 }) < 40, `末点距目标 ${distance(last, { x: 400, y: 300 })}`);
  assert.ok(pts.every((p, i) => i === 0 || p.progress >= pts[i - 1].progress), '进度单调');
});

test('B-02A.1 minimum-jerk 端点与单调性', () => {
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);
  let prev = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const s = minimumJerk(t);
    assert.ok(s >= prev, `t=${t} 非单调`);
    prev = s;
  }
});

test('B-02A.1 手抖噪声近似正态且范围有界', () => {
  const rng = seq([0, 0.25, 0.5, 0.75, 1]);
  const values = Array.from({ length: 200 }, () => noise(1, rng));
  const max = Math.max(...values.map(Math.abs));
  assert.ok(max <= 1.5 + 1e-9, `噪声上限 ${max}`);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean) < 0.2, `均值 ${mean}`);
});

test('B-02A.1 落点偏移同目标 1px 内复用，超 1px 重算', () => {
  const cache = new AimCache();
  const rng = seq([0.2, 0.7, 0.4, 0.9]);
  const first = cache.aim({ x: 100, y: 100 }, rng);
  const again = cache.aim({ x: 100.6, y: 99.4 }, rng);
  assert.deepEqual(first, again, '1px 内复用');
  const moved = cache.aim({ x: 102, y: 100 }, rng);
  assert.notDeepEqual(first, moved, '超过 1px 重算');
  cache.reset();
  const afterReset = cache.aim({ x: 100, y: 100 }, seq([0.8, 0.1]));
  assert.notDeepEqual(first, afterReset, 'reset 后重算');
});

test('B-02A.1 无历史指针时起点在目标 ±260×±180 内', () => {
  const rng = seq([0, 1, 0.5, 0.5]);
  const start = randomStart({ x: 500, y: 400 }, rng);
  assert.ok(start.x >= 240 && start.x <= 760, `x=${start.x}`);
  assert.ok(start.y >= 220 && start.y <= 580, `y=${start.y}`);
});

test('B-02A.2 点击计划：按下前停留 45–130ms 减已用时长，按住 60–140ms', () => {
  const plan = planClick({ x: 300, y: 200 }, { from: { x: 0, y: 0 }, rng: seq([0.5, 0.5, 0.5, 0.5]), overshoot: false });
  assert.ok(plan.points.length > 5);
  assert.ok(plan.pressDelayMs >= 0 && plan.pressDelayMs <= 130);
  assert.ok(plan.holdMs >= 60 && plan.holdMs <= 140);
  assert.ok(distance(plan.target, { x: 300, y: 200 }) <= 2.2 + 1.6, '落点偏移有界');
});

test('B-02A.3 连续按键间隔 30–110ms，10 字符总耗时在区间内', () => {
  const steps = planKeys('abcdefghij', { rng: seq([0.1, 0.9, 0.5]), now: 10_000, lastKeyAt: 9_990 });
  assert.equal(steps.length, 10);
  const delays = steps.slice(1).map((s) => s.delayMs);
  assert.ok(delays.every((d) => d >= 30 && d <= 110), `间隔 ${delays}`);
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(total >= 9 * 30 && total <= 9 * 110, `总耗时 ${total}`);
  assert.ok(total > 0 && total < 1000, '一秒内不能完成 10 次按键');
});

test('B-02A.3 距上次按键超过 1s 不额外等待', () => {
  const steps = planKeys('ab', { rng: seq([1]), now: 10_000, lastKeyAt: 8_000 });
  assert.deepEqual(steps.map((s) => s.delayMs), [0, 0]);
});

test('B-02A.4 滚轮 <40px 一帧；大距离多帧且各帧 delta 严格求和', () => {
  const small = planWheel(24, { rng: seq([0.5]) });
  assert.equal(small.length, 1);
  assert.equal(small[0].delta, 24);
  for (const dy of [300, 1200, -800]) {
    const steps = planWheel(dy, { rng: seq([0.5, 0.6, 0.7]) });
    assert.ok(steps.length > 1, `帧数 ${steps.length}`);
    assert.ok(Math.abs(steps.reduce((s, x) => s + x.delta, 0) - dy) < 1e-9, `求和 ${dy}`);
    for (const s of steps) assert.ok(s.delayMs >= 15.5 && s.delayMs <= 18, `帧间隔 ${s.delayMs}`);
  }
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test('B-02A.5 过冲：>250px 且命中概率时轨迹加长并回到目标', () => {
  const normal = planTrajectory({ x: 0, y: 0 }, { x: 320, y: 0 }, { rng: seq([0.5]), overshoot: false });
  const over = planTrajectory({ x: 0, y: 0 }, { x: 320, y: 0 }, { rng: seq([0.5]), overshoot: true });
  assert.ok(over.length > normal.length, `${over.length} > ${normal.length}`);
  const last = over[over.length - 1];
  assert.ok(distance(last, { x: 320, y: 0 }) < 40, '回拉后接近目标');
  assert.ok(normal.every((p) => p.x <= 320 + 40), '非过冲不越过目标太远');
});
