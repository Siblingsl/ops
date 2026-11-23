// B-02A：人类化输入轨迹（纯函数，可复算）。
//
// 参数逐条对齐 `docs/41-browse可借鉴实现清单.md` §2.1（browse `human.rs`）：
//   * 距离 < 2 px 直接返回空轨迹；
//   * 时长 (70 + 90 * log2(distance/40 + 1)) * U(0.85,1.2)，上限 700 ms；
//   * 三次贝塞尔，c1 20%–35%、c2 65%–80%，bow = ±U(0.04,0.18)*distance，c2 的 bow 取 0.6 倍；
//   * minimum-jerk s(t)=t³(10−15t+6t²)；
//   * 每步 U(8,17) ms，最后一个点丢弃，由调用方精确落点；
//   * 手抖 (1−s)*0.9，噪声 = 三个均匀分布之和 −1.5；
//   * 距离 >250 px 且 U(0,1)<0.25 时过冲 U(4,12) px，再用 3–7 步回拉；
//   * 落点偏移 dx=noise(2.2)、dy=noise(1.6) px，同一目标 1 px 内复用；
//   * 无历史指针时起点在目标 ±260×±180 px 随机；
//   * 按下前停留 U(45,130) ms（减去已到达时间），按住 U(60,140) ms；
//   * 连续按键间隔 U(30,110) ms；距上次按键超过 1 s 不额外等待；
//   * 滚轮 <40 px 一帧；否则帧数 (140+0.45*distance, cap 650) * U(0.85,1.15) / 16.7，
//     按 easeOutCubic 分摊，每帧 U(15.5,18) ms。
//
// 本模块只产生计划，不接触 DOM/CDP；扩展内的页面函数按同一常量执行。

export interface Point {
  x: number;
  y: number;
}

export interface TrajectoryPoint extends Point {
  delayMs: number;
  progress: number;
}

export interface ClickPlan {
  points: TrajectoryPoint[];
  pressDelayMs: number;
  holdMs: number;
  target: Point;
}

export interface KeyStep {
  char: string;
  delayMs: number;
}

export interface WheelStep {
  delta: number;
  delayMs: number;
}

export type Rng = () => number;

const MIN_DISTANCE_PX = 2;
const DURATION_BASE_MS = 70;
const DURATION_LOG_FACTOR = 90;
const DURATION_CAP_MS = 700;
const SAMPLE_MIN_MS = 8;
const SAMPLE_MAX_MS = 17;
const OVERSHOOT_DISTANCE_PX = 250;
const OVERSHOOT_CHANCE = 0.25;
const OVERSHOOT_MIN_PX = 4;
const OVERSHOOT_MAX_PX = 12;
const PRESS_DELAY_MIN_MS = 45;
const PRESS_DELAY_MAX_MS = 130;
const HOLD_MIN_MS = 60;
const HOLD_MAX_MS = 140;
const KEY_MIN_MS = 30;
const KEY_MAX_MS = 110;
const KEY_IDLE_RESET_MS = 1000;
const WHEEL_SMALL_PX = 40;
const WHEEL_BASE_PX = 140;
const WHEEL_FACTOR = 0.45;
const WHEEL_CAP_PX = 650;
const WHEEL_FRAME_MS = 16.7;
const WHEEL_STEP_MIN_MS = 15.5;
const WHEEL_STEP_MAX_MS = 18;
const START_JITTER_X = 260;
const START_JITTER_Y = 180;

function uniform(min: number, max: number, rng: Rng): number {
  return min + (max - min) * rng();
}

export function noise(scale: number, rng: Rng = Math.random): number {
  // 三个均匀分布之和减 1.5：范围 ±1.5，近似正态。
  return (rng() + rng() + rng() - 1.5) * scale;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** minimum-jerk 进度曲线：t³(10−15t+6t²)。 */
export function minimumJerk(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped ** 3 * (10 - 15 * clamped + 6 * clamped ** 2);
}

/** 三次贝塞尔（单轴）。 */
function bezier(p0: number, c1: number, c2: number, p3: number, s: number): number {
  const u = 1 - s;
  return u ** 3 * p0 + 3 * u ** 2 * s * c1 + 3 * u * s ** 2 * c2 + s ** 3 * p3;
}

export function trajectoryDuration(distancePx: number, rng: Rng = Math.random): number {
  const raw = (DURATION_BASE_MS + DURATION_LOG_FACTOR * Math.log2(distancePx / 40 + 1)) * uniform(0.85, 1.2, rng);
  return Math.min(DURATION_CAP_MS, raw);
}

/**
 * 生成从 from 到 target 的轨迹。controls 可注入用于确定性测试。
 * 返回点不含最后一点（调用方负责精确落点/按下）。
 */
export function planTrajectory(
  from: Point,
  target: Point,
  options: {
    rng?: Rng;
    durationMs?: number;
    bow?: number;
    c1Ratio?: number;
    c2Ratio?: number;
    overshoot?: boolean | number;
  } = {},
): TrajectoryPoint[] {
  const rng = options.rng ?? Math.random;
  const dist = distance(from, target);
  if (dist < MIN_DISTANCE_PX) return [];
  const durationMs = options.durationMs ?? trajectoryDuration(dist, rng);
  const c1Ratio = options.c1Ratio ?? uniform(0.2, 0.35, rng);
  const c2Ratio = options.c2Ratio ?? uniform(0.65, 0.8, rng);
  const bow = options.bow ?? uniform(0.04, 0.18, rng) * (rng() < 0.5 ? -1 : 1) * dist;
  const perpendicular = { x: -(target.y - from.y) / dist, y: (target.x - from.x) / dist };
  const c1 = {
    x: from.x + (target.x - from.x) * c1Ratio + perpendicular.x * bow,
    y: from.y + (target.y - from.y) * c1Ratio + perpendicular.y * bow,
  };
  const c2 = {
    x: from.x + (target.x - from.x) * c2Ratio + perpendicular.x * bow * 0.6,
    y: from.y + (target.y - from.y) * c2Ratio + perpendicular.y * bow * 0.6,
  };

  // 过冲：终点外推后回拉。返回点仍不含最后落点。
  const wantOvershoot = options.overshoot ?? (dist > OVERSHOOT_DISTANCE_PX && rng() < OVERSHOOT_CHANCE);
  let end = target;
  let overshootSteps = 0;
  if (wantOvershoot) {
    const extra = uniform(OVERSHOOT_MIN_PX, OVERSHOOT_MAX_PX, rng);
    end = { x: target.x + ((target.x - from.x) / dist) * extra, y: target.y + ((target.y - from.y) / dist) * extra };
    overshootSteps = Math.floor(uniform(3, 7.999, rng));
  }

  const points: TrajectoryPoint[] = [];
  let elapsed = 0;
  let travelled = 0;
  while (elapsed < durationMs) {
    const step = uniform(SAMPLE_MIN_MS, SAMPLE_MAX_MS, rng);
    elapsed = Math.min(durationMs, elapsed + step);
    const t = elapsed / durationMs;
    const s = minimumJerk(t);
    const tremor = (1 - s) * 0.9;
    points.push({
      x: bezier(from.x, c1.x, c2.x, end.x, s) + noise(tremor, rng),
      y: bezier(from.y, c1.y, c2.y, end.y, s) + noise(tremor, rng),
      delayMs: step,
      progress: s,
    });
    travelled = elapsed;
  }
  // 最后一个点丢弃：调用方用精确坐标按下。
  points.pop();
  if (wantOvershoot && overshootSteps > 0) {
    const start = points.length ? points[points.length - 1] : from;
    for (let i = 1; i <= overshootSteps; i += 1) {
      const s = minimumJerk(i / overshootSteps);
      points.push({
        x: start.x + (target.x - start.x) * s,
        y: start.y + (target.y - start.y) * s,
        delayMs: uniform(SAMPLE_MIN_MS, SAMPLE_MAX_MS, rng),
        progress: s,
      });
    }
    points.pop();
  }
  void travelled;
  return points;
}

export interface AimEntry {
  target: Point;
  point: Point;
}

export class AimCache {
  private last: AimEntry | null = null;

  /** 同一目标 1 px 内复用落点，避免每次点击抖动。 */
  aim(target: Point, rng: Rng = Math.random): Point {
    if (this.last && distance(this.last.target, target) <= 1) return this.last.point;
    const point = { x: target.x + noise(2.2, rng), y: target.y + noise(1.6, rng) };
    this.last = { target, point };
    return point;
  }

  reset(): void {
    this.last = null;
  }
}

/** 无历史指针时，起点在目标附近 ±260×±180 px 随机。 */
export function randomStart(target: Point, rng: Rng = Math.random): Point {
  return {
    x: target.x + uniform(-START_JITTER_X, START_JITTER_X, rng),
    y: target.y + uniform(-START_JITTER_Y, START_JITTER_Y, rng),
  };
}

export function planClick(
  target: Point,
  options: {
    from?: Point;
    aimCache?: AimCache;
    rng?: Rng;
    durationMs?: number;
    overshoot?: boolean | number;
  } = {},
): ClickPlan {
  const rng = options.rng ?? Math.random;
  const aim = options.aimCache ? options.aimCache.aim(target, rng) : target;
  const from = options.from ?? randomStart(aim, rng);
  const points = planTrajectory(from, aim, { rng, durationMs: options.durationMs, overshoot: options.overshoot });
  const travelMs = points.reduce((sum, p) => sum + p.delayMs, 0);
  const pressDelayMs = Math.max(0, uniform(PRESS_DELAY_MIN_MS, PRESS_DELAY_MAX_MS, rng) - travelMs);
  return { points, pressDelayMs, holdMs: uniform(HOLD_MIN_MS, HOLD_MAX_MS, rng), target: aim };
}

export function planKeys(
  text: string,
  options: { rng?: Rng; lastKeyAt?: number; now?: number } = {},
): KeyStep[] {
  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now();
  const idle = typeof options.lastKeyAt === 'number' && now - options.lastKeyAt > KEY_IDLE_RESET_MS;
  return Array.from(String(text)).map((char, index) => ({
    char,
    delayMs: index === 0 || idle ? 0 : uniform(KEY_MIN_MS, KEY_MAX_MS, rng),
  }));
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** 滚轮分摊；各帧 delta 求和严格等于请求量。 */
export function planWheel(distancePx: number, options: { rng?: Rng } = {}): WheelStep[] {
  const rng = options.rng ?? Math.random;
  const total = Number(distancePx) || 0;
  if (Math.abs(total) < WHEEL_SMALL_PX) return [{ delta: total, delayMs: 0 }];
  const raw = Math.min(WHEEL_BASE_PX + WHEEL_FACTOR * Math.abs(total), WHEEL_CAP_PX) * uniform(0.85, 1.15, rng);
  const frames = Math.max(1, Math.round(raw / WHEEL_FRAME_MS));
  const steps: WheelStep[] = [];
  let allocated = 0;
  for (let i = 1; i <= frames; i += 1) {
    const target = total * easeOutCubic(i / frames);
    const delta = i === frames ? total - allocated : Math.round((target - allocated) * 100) / 100;
    allocated += delta;
    steps.push({ delta, delayMs: uniform(WHEEL_STEP_MIN_MS, WHEEL_STEP_MAX_MS, rng) });
  }
  // 浮点余量并入最后一帧，保证严格求和。
  const sum = steps.reduce((s, x) => s + x.delta, 0);
  if (Math.abs(sum - total) > 1e-9) steps[steps.length - 1].delta += total - sum;
  return steps;
}

export const HUMAN_INPUT_CONSTANTS = {
  MIN_DISTANCE_PX,
  DURATION_BASE_MS,
  DURATION_LOG_FACTOR,
  DURATION_CAP_MS,
  SAMPLE_MIN_MS,
  SAMPLE_MAX_MS,
  OVERSHOOT_DISTANCE_PX,
  OVERSHOOT_CHANCE,
  OVERSHOOT_MIN_PX,
  OVERSHOOT_MAX_PX,
  PRESS_DELAY_MIN_MS,
  PRESS_DELAY_MAX_MS,
  HOLD_MIN_MS,
  HOLD_MAX_MS,
  KEY_MIN_MS,
  KEY_MAX_MS,
  KEY_IDLE_RESET_MS,
  WHEEL_SMALL_PX,
  WHEEL_BASE_PX,
  WHEEL_FACTOR,
  WHEEL_CAP_PX,
  WHEEL_FRAME_MS,
  WHEEL_STEP_MIN_MS,
  WHEEL_STEP_MAX_MS,
  START_JITTER_X,
  START_JITTER_Y,
} as const;
