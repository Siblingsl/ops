# RC-03 第 2 条：会话 TTL 观测

判定：**未完成，已观测 1/3 次；`sessionTtlObserved` 仍为 null**

## 第 1 次观测（真实自然失效）

| 项 | 值 |
|---|---|
| 计时起点 | `2026-10-22 02:46:58Z`（连接的 `last_verified_at` / `consented_at`，也是首次真实验证成功时间） |
| 首次观测失效 | `2026-11-23 09:50:08Z`（daily collect 领取后失败，`error_code=platform_login_required`、`stop_reason=login_required`） |
| 区间 | `32 天 7 小时 3 分 10 秒` |
| 失效 run | `4545c3b5-d040-420d-85cf-c59ea12853a1`（failed） |
| 连接变化 | `availability=login_required`、`failure_count=1` |

原始 run 行见 `02-ttl-and-multipage-runs.txt`。

## 口径说明（不伪造、不外推）

- 该区间是“上次成功验证 → 首次观测到失效”的真实区间，不是推算值。
- 会话最后一次被证明仍可用是 `2026-11-19 09:13:43Z` 的 daily collect（`5df84196-8894-44c6-a05d-3cd4ad32b497`，status=partial，pages_read=3）；因此实际可用期至少延续到 11-19，`32d7h3m10s` 只是“验证→首次观测失效”的上界口径，不能当成精确 TTL。
- 按 `docs/21` DEV-PS88 口径，TTL 以“成功验证→下次失效”记录；单次不足三次不得写估算值。

## 当前写入状态

- `platform_connection.capabilities.sessionTtlObserved` 仍为 `null`，见 `05-capabilities-db.txt`。
- 代码核对：`desktop/src/platforms/xhs.ts` 的 `probeCapabilities` 只接受 `sessionTtlObserved` 入参，`desktop/src/platform-login-runtime.ts` 登录核验调用未传入该值；当前没有“观测后持久化”的写入路径。未为本条伪造写入。
- 观测计数：**1/3**。第 2、3 次必须等真实重新登录成功后重新计时，不能复用本次区间凑数。

## 下次续跑

- 第 2 次计时只能在真实重登成功后开始（记录 T0），在之后的自然失效时记录 T1。
- 按第 1 次区间长度（仅作排期参考，不是 TTL 值）估算，若在 2026-11-24 前后完成重登，下一次自然失效检查窗口约在 **2026-12-26 前后**；从 2026-12-26 起每日检查连接 availability，观测到失效即落第 2 次样本。实际日期以真实失效为准，不预设、不填估算。
