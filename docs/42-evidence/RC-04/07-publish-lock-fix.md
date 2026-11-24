# RC-04 补充证据：发布锁泄漏与采集饿死修复

日期：2026-11-24（UTC+8）。范围：`desktop/src/main.ts`、`desktop/src/publish-loop-lock.ts`、`desktop/test/publish-loop-lock.test.cjs`。

## 根因

1. 旧发布 tick 用布尔量 `publishInFlight` 互斥，复位在 `finally` 末尾、且排在 `await pageSession.close()` 之后。发布流程里 `heartbeat`、`result`、打开页面、`browser.close()` 任一挂起，布尔量不会复位；采集 tick 每次都读到“发布进行中”，永久跳过 claim。
2. 只修复位还不够：发布循环先注册、采集循环后注册，二者都是 30 秒。每个周期边界发布 tick 先持锁，采集 tick 在同一时刻醒来，仍会每轮撞锁并跳过。

## 修复

- 新增 `PublishLoopLock`：最大持有 8 分钟；`acquire/isHeld/owns/isExpired/release/forceRelease`；旧 tick 的 token 不能清掉新 tick 的锁。
- 发布 tick 改为 token 锁；`finally` 先等页面关闭最多 5 秒，卡住则杀浏览器子进程；新增 `stopStuckPublishSession()`，超时强制释放并收尸。
- 采集 tick 遇到 `publishLock.isHeld()` 不再直接 `return` 等下一个 30 秒，而是 3 秒后重试（`claimRetryTimer`）；停止循环时清理该重试定时器。

## 验证

| 检查 | 结果 |
|---|---|
| `cd desktop; pnpm build` | EXIT=0 |
| `cd desktop; node --test test/publish-loop-lock.test.cjs` | 5/5 pass，0 fail，EXIT=0 |
| `cd desktop; pnpm test` | 774 tests：767 pass，7 skipped，0 fail，EXIT=0（63.9s） |

运行时 API 日志（`api.err.log` / `api3.err.log`）证明两个循环已错开，采集不再被发布锁永久挡住：

| 时间（CST） | 发布 claim | 采集 claim | 说明 |
|---|---|---|---|
| 08:23:45 | 200 | — | 发布 tick 先持锁 |
| 08:23:48 | — | 200 | 采集在锁释放后 3 秒 claim |
| 08:24:15 | 200 | — | 下一周期，仍先发布 |
| 08:24:18 | — | 200 | 采集 3 秒后 claim |
| 08:34:15 | 200 | — | API 故障恢复后的周期 |
| 08:34:18 | — | 200 | 采集 claim 正常发出 |

结论：采集 tick 已能稳定到达 `POST /api/v1/desktop/platform/runs/claim`，不再因发布锁跳过。该端点本轮返回 200 但无任务，原因是日预算，不是锁（见 `09-claim-budget-blocker.md`）。

## 未覆盖

- 本轮没有 claim 到新的 account_sync run，因此“claim 到任务并跑完”仍未用本轮数据复证；只证明了 claim 调用链不再被锁饿死。
- 没有把 `profile` 的 `unknown` 改成 `supported`；RC-04 五条不要求 profile 完成。
