# RC-04 补充证据：自动 claim 被日预算挡住（历史阻塞，已由 10 闭环）

日期：2026-11-24（UTC+8）。这是严格补充项中当时唯一未闭环项，原因不是发布锁，也不是代码错误。

## 事实

- 08:19 左右通过 UI「同步」创建 account_sync 操作 `829dc798-e179-4967-b2d5-52d31c6dab3d`；DB 状态 `waiting_budget`，`pause_reason=budget`，`next_allowed_at=2026-11-24 09:00:00+08`。
- 该小红书主体（`platform=xhs`、`external_account_key=<redacted>`）在 2026-11-24 00:00 之后已有 **38 条** `platform_sync_run`；服务端日 run 上限 `min(3, workspace daily_run_limit=3)=3`。
- 因此即使 09:00 读取窗口打开，`platformCanReserveRun` 仍会判定超预算，把 `next_allowed_at` 推到 **2026-11-25 09:00**；今天不可能再 claim 到新的 account_sync run。

## 已经证明的部分

- 修复后的采集循环确实每 30 秒发出 `POST /api/v1/desktop/platform/runs/claim`，且在发布 claim 后 3 秒（锁释放后）发出：08:23:48、08:24:18、08:34:18，均 HTTP 200。
- 这不是“锁占用导致跳过”：API 停止期间，桌面 stderr 明确出现 `[platform-auto] 循环异常 Error: net::ERR_CONNECTION_REFUSED`；API 恢复后该错误停止，claim 恢复 200。
- 但没有 claim 到 task，所以不能把“真实自动采集 claim 到任务”写成 PASS。

## 09:00 窗口实测（2026-11-24 09:00–09:01）

- 09:00 前 Vite 5174 已停止监听（桌面配置指向该端口），桌面侧从 08:34 起持续 `ERR_CONNECTION_REFUSED`；09:00:20 重新启动 Vite 5174，09:00:45 桌面恢复请求。
- `api3.err.log`：09:00:45 `GET /accounts/{accountId}/platform-sync-operations` 200；09:00:48 `POST /desktop/platform/runs/claim` 200；09:01:18 再次 claim 200。**两次 claim 均未返回 task**。
- DB：操作 `829dc798...` 在 09:01:05 被更新，`status=waiting_budget`、`stage=queued`、`pause_reason=budget`、`next_allowed_at=2026-11-25 01:00:00+00`（即 2026-11-25 09:00+08）。
- 同日 run 数仍为 **38**（本地日 00:15–01:34 产生），没有新增 run；说明服务端确实执行了预算判定并推进到次日，而不是桌面未发 claim。
- 持续健康性：09:05:19、09:05:49、09:06:19 三次 claim 均 200，间隔 30 秒，说明采集循环恢复后持续在跑，不是单次偶发。
- 证据命令输出见本节；截图未取到，因为页面在 Vite 恢复后处于无 `window.opsDesktop` 的窗口，同步卡片未渲染，不能把非桌面窗口截图当证据。

## 复核命令

```powershell
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select id,status,stage,pause_reason,next_allowed_at,updated_at from platform_sync_operation where id='829dc798-e179-4967-b2d5-52d31c6dab3d';"
docker exec ops-dev-postgres-1 psql -U ops -d ops -c "select count(*),min(created_at),max(created_at) from platform_sync_run where connection_id='90137936-c681-4047-ae7c-1870a9ea5d43' and (created_at at time zone 'Asia/Shanghai') >= date_trunc('day', now() at time zone 'Asia/Shanghai');"
Select-String -Path 'F:\code\project\OPS\.tmp\rc04b\api3.err.log' -Pattern '2026/11/24 09:0.*platform/runs/claim'
```

## 结论

- 发布锁泄漏与采集饿死：**已修复**，有 5/5 单测、774 项桌面测试与运行时 claim 日志。
- 真实失败/恢复 UI：**已取证**，见 `08-sync-failure-recovery.md`。
- 真实 claim 到任务：**本文件记录时未完成**。09:00 窗口实测仍被同日 38 条 run 的日预算挡回，`next_allowed_at` 已推进到 **2026-11-25 09:00**；随后用户明确授权临时放宽本地日上限，`10-auto-claim-success.md` 已用四次真实 claim 补齐 S3。
