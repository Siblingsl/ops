# RC-03 第 4 条：真实主页多页采集

判定：**PASS（真实历史运行证据；本轮未重跑）**

## 运行事实

| 项 | 值 |
|---|---|
| run id | `5df84196-8894-44c6-a05d-3cd4ad32b497` |
| trigger / task_kind | `daily` / `collect` |
| 开始/结束 | `2026-11-19 09:13:43.616Z` / `09:14:06.823Z` |
| status | `partial`（预算停止，不是失败） |
| stop_reason | `budget` |
| counters | `{"coverage":{"has_more":true,"pages_read":3,"incomplete_reason":"page_budget"},"stop_reason_raw":"budget"}` |
| pages_read | 3 |
| `page_repeated` | 未出现；`stop_reason` 与 `incomplete_reason` 均不含该值 |
| 入库观测 | batch_seq=0，accepted=10、rejected=0、duplicate=0、pending=0 |
| 平台来源 | `platform_metric_observation` 的 10 行 source=`xhs_browser`，quality_state=`needs_confirmation`，match_state=`bound`，含真实 like/comment/share/favorite/view_times |

原始证据：

- `02-ttl-and-multipage-runs.txt`（run 的 status/stop_reason/counters）
- `04-multipage-run-receipt.txt`（accepted=10、rejected=0、batch_seq=0）
- `04-multipage-db.txt`（10 条 metric observation；39 条真实作品镜像）
- `04-multipage-operation.txt`（同账号 account_sync 操作：created=39、discovered=39、metrics_observed=39）

## 真实数据核对

- `platform_metric_observation`：该 run 10 行，`first_observed=last_observed=2026-11-19 09:13:50.44Z`。
- `platform_work_mirror`：账号 `05dfeb67-c0b0-401d-905a-edddddb63f40`、平台 `xhs` 共 39 行，`updated_at` 覆盖 `2026-10-27 01:37:10Z`～`01:47:17Z`，来源 run `1c5a91b3-9704-47df-a080-72723f524aec`（manual account_sync，succeeded）。这些是真实作品镜像，不是夹具。
- 该 run 的 10 条观测已真实入库；`mirrors_created=0` 是因为同批作品镜像已存在，不是“没有数据”。

## 口径与限制（不冒充本轮新跑）

- 本条采用 **2026-11-19 的真实 daily collect** 作为证据，不是今天新发起的采集；今天连接已 `login_required`，无法重跑。
- 证据明确证明“真实主页 ≥3 页、真实数据入库、stop_reason 不含 `page_repeated`”，满足条文的最小事实要求。
- 若验收方要求“RC-03 执行当日重跑一次”，则本条只能保持“历史真实证据已取得、待重登后复跑”，不能按当日新跑计。本轮报告按前者标注 PASS，并把“未重跑”作为限制写明。
- 未使用夹具、未把 mock 行计入；39 条镜像与 10 条观测均来自真实连接/真实浏览器路径。
