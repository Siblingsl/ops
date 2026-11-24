# RC-04 补充证据：真实失败与服务恢复 UI

日期：2026-11-24（UTC+8）。范围：`renderer/pages/settings/Accounts.tsx` 的「平台登录与同步 / 账号同步进度」卡片；真实失败源为本地 API 进程停止，不是构造的错误响应。

## 操作

1. 08:30:45 左右停止本地 API 进程（原 PID 39752，`.tmp/rc04b/ops-rc04b.exe`），保持桌面端不关。
2. 08:30:56 截取卡片：显示「同步进度读取失败：请求失败（500） 重试进度」。
3. 08:31:01 以同一配置重启 API（`OPS_DEV=1`、`OPS_LISTEN=127.0.0.1:8080`、`OPS_DESKTOP_PLATFORM_ENABLED=1`）。
4. 08:31:17 截取同一卡片：失败提示消失，恢复为「等待读取窗口 / 排队中 / 下次可继续 今天 09:00」。

## 证据

- `07-sync-failure.png`：停止 API 后的真实失败 UI，含「同步进度读取失败：请求失败（500） 重试进度」。
- `08-sync-recovered.png`：API 重启后的恢复 UI，不残留失败提示。
- 桌面 stderr（`app-cdp4.err.log`）同时出现：
  - `[platform-presence] 上报失败 presence_failed Error: net::ERR_CONNECTION_REFUSED`
  - `[publish-auto] 循环异常 Error: net::ERR_CONNECTION_REFUSED`
  - `[platform-auto] 循环异常 Error: net::ERR_CONNECTION_REFUSED`
  - 重启后：`[platform-presence] 已恢复上报`
- API 重启后日志（`api3.err.log`）恢复 `POST /api/v1/desktop/platform/presence 200`；08:34:18 采集 claim 也恢复 200。

## 边界

- 这是“本地服务不可达”的真实失败/恢复，不是“平台拒绝/登录失效”的失败样本；后者仍只由原因码与定向单测覆盖，未在真实小红书连接上单独取证。
- 截图裁剪到同步卡片顶部到进度卡片底部，未包含平台账号 id、昵称、token 或 xsec_token。
