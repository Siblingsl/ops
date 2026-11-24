# RC-04 补充证据：真实自动 claim 到任务并跑完（S3）

日期：2026-11-24（UTC+8）。本项用于补齐 `09-claim-budget-blocker.md` 中被日预算挡住的最后一个严格补充项。

## 结论

**S3 PASS**。在用户明确授权临时放宽本地验收日上限后，桌面端通过真实 `POST /api/v1/desktop/platform/runs/claim` 自动 claim 到操作 `829dc798-e179-4967-b2d5-52d31c6dab3d` 的 4 个 run（profile / catalog / content / metrics），没有使用 `OPS_DESKTOP_RC04_SKIP_PUBLISH`、没有跳过发布领取、没有改 claim 路由。完成后已恢复代码常量与工作区策略为 3。

## 临时放宽与恢复

| 项 | 临时值 | 恢复值 | 恢复证据 |
|---|---|---|---|
| `platformDailyRunsPerSubject`（代码常量） | 100 | 3 | `platform_sync_budget.go:12`；`go build` EXIT=0 |
| `platform_collection_policy.daily_run_limit`（本地工作区） | 100 | 3 | DB 查询 `daily_run_limit=3`，`updated_at=2026-10-22 09:54:16.51553+00` |
| `platform_collection_policy_daily_run_limit_check`（本地临时约束） | `<=100` | `>=1 AND <=3` | `pg_get_constraintdef` 输出原定义 |
| 操作 `next_allowed_at` | 手动置 `now()` 并置 `queued` | 不适用（操作已完成） | 最终 `partial/complete` |

> 该调整仅用于本地验收，不是产品默认值；代码常量和 DB 约束均已恢复并复核。没有删除 38 条历史 run。

## 真实时间线

| 时间 | 事件 | 证据 |
|---|---|---|
| 10:15:45 | 临时放宽策略并把 `829dc798...` 的 `next_allowed_at` 置为当前 | DB |
| 10:17:56 | API 启动调度创建 profile run `407fbedb-e9df-4bee-bc3a-5710d890129b` | DB `created_at` |
| 10:18:20 | 桌面真实 claim 200，profile run 开始 | `api-limit2.err.log`；run `started_at` |
| 10:18:25 | profile run 结束：`partial`，`profile_capability_unverified`；操作进入 catalog | DB |
| 10:20:20 | 桌面真实 claim 200，catalog run `c349a3ef-cbd8-4796-bbec-f5dd58cef859` 开始 | `api-limit3.err.log`；run `started_at` |
| 10:20:29 | catalog `succeeded`；操作进入 content | DB |
| 10:21:20 | 桌面真实 claim 200，content run `e676bbe6-87c9-4ccb-a476-0615e5807a38` 开始 | `api-limit4.err.log`；run `started_at` |
| 10:21:24 | content `succeeded`；`body_hash=88db...`、`unchanged=1`、`content_received=0`（正文哈希未变，未伪造新正文） | run `batch_receipts` |
| 10:22:20 | 桌面真实 claim 200，metrics run `e7b18957-ac98-408c-a1da-446443e8d123` 开始 | `api-limit5.err.log`；run `started_at` |
| 10:22:28 | metrics `succeeded`；操作 `partial/complete` | DB |

四次 claim 的 `started_at` 与 API 日志时间一一对应，均 200；不是手动插入 run，也不是只调 API。

## 业务结果复核

- `platform_work_mirror`：`external_id=6a7c6caf0000000005033660`、`title=哪个更真实？`、`length(body_text)=832`、`content_state=complete`、`last_sync_operation_id=829dc798...`。
- `comment_inbox`：2 条历史真实评论仍在；`图1吧，图2人太大了` 仍为 `category=question`、`reply_status=copied`、`reply_draft` 29 字、`sent_manual_at` 为空；没有自动外发。
- 操作最终 `status=partial`、`stage=complete`，原因是 profile 能力 `profile_capability_unverified`；catalog/content/metrics 三个 run 均 `succeeded`。这是既有能力缺口，不是本次 claim 或正文/评论链路失败。
- 今日该连接 run 数从 38 增至 **42**（38 + 4），全部是本次真实 claim 产生；没有删除或重置历史 run。

## 复核命令

```powershell
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select id,status,operation_stage,started_at,finished_at from platform_sync_run where operation_id='829dc798-e179-4967-b2d5-52d31c6dab3d' order by created_at;"
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select status,stage,finished_at from platform_sync_operation where id='829dc798-e179-4967-b2d5-52d31c6dab3d';"
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select daily_run_limit from platform_collection_policy where workspace_id='4e2bd06c-210c-4840-9cfa-db2b36101083';"
Select-String -Path 'F:\code\project\OPS\.tmp\rc04b\api-limit*.err.log' -Pattern 'platform/runs/claim'
```

## 恢复验证（2026-11-24 10:24–10:26）

- `cd server; go build -o ... ./cmd/ops` → `BUILD_RESTORED_OK`。
- `cd server; go test ./internal/app -run '^TestPlatformV2Content|^TestP04CommentIngestEndpoint$|^TestPlatformBudget' -count=1` → `ok ops/internal/app 8.254s`。
- `cd desktop; node --test test/publish-loop-lock.test.cjs` → 5/5 pass、0 fail。
- `platform_sync_budget.go` 当前 `platformDailyRunsPerSubject = 3`，`git diff` 该文件为空。
- DB：`platform_collection_policy.daily_run_limit=3`、`updated_at=2026-10-22 09:54:16.51553+00`；约束恢复为 `CHECK (daily_run_limit >= 1 AND daily_run_limit <= 3)`。
- 重启恢复后的 API（PID 14220）后，10:25:50、10:26:20 claim 仍 200；今日 run 数保持 42，没有新增。

## 边界

- 只临时放宽本地日 run 上限；未改查询/作品/静态资源预算，未改真实平台频率限制。
- 未删除历史 run，未改 `profile` 能力状态，未把 `unknown` 改成 `supported`。
- 完成后已恢复代码常量 3、工作区策略 3、DB 约束 `<=3`，重建并重启 API，claim 仍每 30 秒 200。
