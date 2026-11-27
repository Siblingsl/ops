# RC-03 阶段更新：2026-11-27 生产环境验证与服务端派发修复上线

> 状态：**未闭环（待次日配额重置后补录 401 重登恢复录屏）**。本记录严格依据生产库查询与容器部署输出，不含账号昵称、外部键值、token、Cookie 或服务器 IP。

## 环境与连接事实

- **环境**：生产 `https://ops-api.88813888.xyz`（`OPS_DEV=0`、`OPS_DESKTOP_PLATFORM_ENABLED=1`、`OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 未开启）。
- **连接 ID**：`85ec702c-a627-45db-adb0-8fa9f19dae8f`（绑定当前打包桌面设备 `39db7e12-c551-4516-82cd-fa6635c875ca`）。
- **连接状态**：`state=active`、`availability=ready`、`last_verified_at=2026-11-27 08:18:16.121852+00`、`last_seen_at=2026-11-27 08:45:48.89915+00`。

## 分条核验进展

### 1. 第 1 条（presence 心跳可见）— PASS

- 打包态桌面端按 30s 周期稳定上报 presence 心跳，生产连接 `availability=ready`，桌面端“平台账号与凭证”设置页显示为“可用 / 已连接”。

### 2. 桌面产品内重登入口（OPT-U04）— 已打通

- 在打包态桌面端设置页通过 `openDesktopPlatformLogin` IPC 成功唤起官方登录并完成真实登录核验，消除了 2026-11-23 `window.open` 返回 `null` 导致的重登阻塞。

### 3. 第 4 条（能力快照如实刷新）— PASS

本次重登核验后，生产库 `platform_connection.capabilities` 已真实刷新（如实区分 `supported` / `unknown` 与 `sessionTtlObserved: null`）：

```json
{
  "workList": "supported",
  "detectedAt": "2026-11-27T08:17:34.027Z",
  "noteContent": "supported",
  "creatorLogin": "supported",
  "followerTotal": "unknown",
  "mainSiteLogin": "supported",
  "adapterVersion": "xhs-1",
  "browserVersion": "Chrome/158.0.8127.38",
  "mappingVersion": 1,
  "perNoteMetrics": "supported",
  "noteImpressions": "unknown",
  "noteContentReason": null,
  "sessionTtlObserved": null
}
```

### 4. 真实同步运行与服务端即时派发修复上线

- 操作 `ca4619c3-8627-4344-a67b-fdeab2c0e52d`（`account_sync`）在生产环境连续执行 3 个 run：
  - `2a7fa2fb-9c52-4e5e-a4c4-7f0ffd723185`（`profile` / `partial`，`2026-11-27 08:27:30.005145+00` → `08:28:04.78983+00`）
  - `78d95cda-adca-4051-be59-4e843962048e`（`catalog` / `succeeded`，`2026-11-27 08:37:30.008278+00` → `08:38:16.108182+00`）
  - `fe24b533-8a84-4ddc-8fb3-84b9e46d4a17`（`content` / `partial`，`2026-11-27 08:47:29.99806+00` → `08:49:54.710289+00`）
- 真实落库：`platform_work_mirror`（`platform='xhs'`）新增/累计 `mirror_cnt=2`、`platform_metric_observation`（`source='xhs_browser'`）`obs_cnt=2`。
- 因触及 `platformDailyRunsPerSubject = 3` 每日主体上限，操作自动进入 `status=waiting_budget`、`stage=content`、`pause_reason=budget`，下次可继续窗口 `next_allowed_at=2026-11-28 01:00:00+00`（北京时间 `2026-11-28 09:00`）。
- **排障与服务端修复**：上述运行暴露出 v2 阶段切换需空等 10 分钟周期扫描的问题；已提交修复 `6d9209da`（在 `claimPlatformRun` 客户端领单时按需派发待执行 v2 操作 + 1 分钟 `RunJobs` 兜底），并在 ECS 重新构建 `ops-app:local` 镜像 `7b46b603b46f` 重启上线，`http://127.0.0.1:44537/healthz` 返回 `ok`。

### 5. 第 5 条（长周期 TTL 观察附项）— 1/3，已登记第 2 次起点 T0

- **第 2 次自然失效观察起点 `T0`**：`2026-11-27T08:18:16Z`（本次生产真实重登核验成功 `last_verified_at`）。
- 历史自然失效实测样本仍为 `1/3`（2026-10-22 → 2026-11-23，`32d7h3m10s`），`sessionTtlObserved` 保持 `null`，未写入估算值。

## 剩余未闭环项与后续安排

- **第 2 条（真浏览器 401 重登恢复完整录屏）— 唯一核心待补项**：因本日 3/3 主体配额已满，安排在 **`2026-11-28 09:00`（北京时间）配额重置后** 在生产桌面端直接完成“真实制造 401 失效 → UI 提示需要重新登录 → 点击产品内重登按钮扫码 → 恢复并完成一次真实采集”完整录屏。
- **第 3 条（主页 ≥3 页且无 `page_repeated`）**：今日生产号仅 2 篇作品，不足 3 页；当前暂沿用 2026-11-19 真实 3 页 PASS 证据（`5df84196-8894-44c6-a05d-3cd4ad32b497`，39 篇镜像、10 条观测、无 `page_repeated`）。
