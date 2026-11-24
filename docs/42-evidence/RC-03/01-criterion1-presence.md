# RC-03 第 1 条：真实账号 + 平台开关 + presence 心跳

判定：**PASS**

## 运行配置

- API：`http://127.0.0.1:8080`，进程以 `OPS_DEV=1`、`OPS_LISTEN=127.0.0.1:8080`、`OPS_DESKTOP_PLATFORM_ENABLED=1` 启动（平台开关只在进程启动时读取，本轮已重启后验证）。
- 桌面端：真实 Electron 主进程，业务 origin `http://localhost:5174`，业务分区 `persist:ops-business-development`，使用既有 xhs 专用 profile。
- 真实连接：`85b42915-3459-4d89-958e-fe0a47ce50fb`；账号/设备/外部键核对见 `00-connection.md`。

## 服务端开关证据

`GET /api/v1/desktop/capabilities` 原样响应见 `01-capabilities.json`：

- `platform_collection.enabled=true`
- `platform_collection.v2.enabled=true`
- `platform_collection.account_sync_platforms=["xhs"]`
- `platform_collection.v2.platform_capabilities.xhs` 四键均为 `unknown`

## presence 心跳证据

API 日志中 `POST /api/v1/desktop/platform/presence` 每 30 秒一次、均 200，workspace 一致。连续 20 个样本覆盖 `19:22:22` 至 `19:31:52`（本地 UTC+8），见 `01-presence.log`；节选：

- `19:22:22`、`19:22:52`、`19:23:22`
- `19:30:22`、`19:30:52`、`19:31:22`、`19:31:52`

DB 复核：连接 `last_seen_at=2026-11-23 11:30:52Z`，与日志最后一个 presence 样本一致，说明心跳不只是日志噪声，已落到连接行。原始行见 `01-db-connection.txt`。

## 说明

presence 可见不等于登录态有效。该连接当前 `availability=login_required`，这是第 2/3 条要处理的真实失效状态；第 1 条只验证“开关打开后心跳可达”。
