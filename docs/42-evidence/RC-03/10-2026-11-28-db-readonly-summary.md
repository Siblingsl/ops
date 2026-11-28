# RC-03 生产只读核对摘要（2026-11-28）

> 方式：通过已安装桌面端 CDP（`127.0.0.1:9333`）捕获生产 API 响应，**只读 GET**，未调用任何写接口。
>
> 边界：本机无生产 `psql`/SSH 直连条件，以下为**生产只读 API 投影**，不是数据库直连查询。

## 1. 连接

`GET /api/v1/accounts/{accountId}/platform-connection` → 200

```json
{
  "connection": {
    "id": "85ec702c-a627-45db-adb0-8fa9f19dae8f",
    "platform": "xhs",
    "state": "active",
    "availability": "ready",
    "failure_count": 0,
    "last_verified_at": "2026-11-28T17:45:39.228103+08:00",
    "last_seen_at": "2026-11-28T18:38:28.850073+08:00",
    "auto_collect": false,
    "auto_adopt": false,
    "sync_capabilities": {
      "catalog": "supported",
      "content": "unknown",
      "metrics": "supported"
    }
  }
}
```

> 省略字段：`account_id`、`external_account_key`、`adoption_revision`、`authorization_revision`、`consented_at`、`next_due_at`、`platform_consent_version`、`is_holder`。

## 2. 同步操作

`GET /api/v1/accounts/{accountId}/platform-sync-operations?limit=20` → 200

```json
{
  "items": [
    {
      "id": "ca4619c3-8627-4344-a67b-fdeab2c0e52d",
      "kind": "account_sync",
      "status": "partial",
      "stage": "complete",
      "revision": 17,
      "created_at": "2026-11-27T08:18:38.358819Z",
      "expires_at": "2026-12-05T17:48:24.632588+08:00",
      "last_error": { "code": "platform_login_required" },
      "counters": {
        "changed": 0,
        "content_received": 2,
        "created": 2,
        "discovered": 2,
        "failed": 1,
        "metrics_adopted": 0,
        "metrics_observed": 2,
        "pending_confirmation": 2,
        "skipped": 0,
        "unchanged": 0
      },
      "coverage": {
        "catalog": { "state": "complete", "reason": null, "failed": 0, "pending": 0 },
        "content": { "state": "complete", "reason": null, "failed": 0, "pending": 0, "capability_state": "supported" },
        "metrics": { "state": "complete", "reason": null, "failed": 0, "pending": 0 },
        "profile": { "state": "unknown", "reason": "profile_capability_unverified", "failed": 0, "pending": 0 }
      }
    }
  ]
}
```

> 省略字段：`account_id`、`connection_id`、`available_actions`、`effective_mode`、`frozen_scope`、`next_allowed_at`、`pause_reason`、`scope_upper_bound`、`next_cursor`。

## 3. 内容条目

`GET /api/v1/accounts/{accountId}/platform-sync-operations/ca4619c3-8627-4344-a67b-fdeab2c0e52d/items?limit=20&stage=content` → 200

| # | content_state | error_code | content_observed_at | source_run_id |
|---|---|---|---|---|
| 1 | `complete` | `null` | `2026-11-28T17:48:41.027+08:00` | `c1410f31-26bc-4240-b297-cafe3269f613` |
| 2 | `complete` | `null` | `2026-11-27T16:47:56.596+08:00` | `fe24b533-8a84-4ddc-8fb3-84b9e46d4a17` |

> 省略字段：`external_id`、`title`、`platform_work_id`、`remote_content_type`、`remote_status`、`initial_metrics_state`、`last_seen_at`、`created_at`。

## 4. 运行日志

| 次序 | runStatus | accepted | rejected | errorCode |
|---|---|---|---|---|
| 第 1/3 次 | `failed` | 0 | 0 | `platform_login_required` |
| 第 2/3 次 | `succeeded` | 1 | 0 | `null` |
| 第 3/3 次 | `succeeded` | 0 | 0 | `null`（附 `follower total unavailable platform_capability_denied`） |

## 5. 判定口径

- 连接 `availability=ready`、`last_verified_at=2026-11-28T17:45:39+08:00`、`failure_count=0`，证明重登后平台登录已恢复。
- 操作 `status=partial`、`stage=complete`；`content_received=2`、`metrics_observed=2`；coverage `catalog/content/metrics=complete`，证明继续采集真实落库。
- `last_error.code=platform_login_required` 为历史留痕（首次 401 运行写入）；不据此判当前失败。
- `profile=unknown/profile_capability_unverified` 与账号资料「未知」为能力边界，不阻塞主闭环。
- 本次 401 为人工制造，不计入自然 TTL；自然失效样本保持 1/3。
