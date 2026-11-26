# RC-17 生产部署、HTTPS/WSS 与多租户工作区冒烟 — 线上实测证据汇总（VERIFY-05）

> **状态：已闭环（2026-11-26，6/6 标准全 PASS，D1/D8/D9/P1/P2 全部复验闭环）。** RC-17 的 6 条通过标准均已在公网生产环境实测通过；首轮捕获的 D8 / D9 / D1 三个真实缺陷已在生产提交 `254dab4` 上修复并复验闭环，P1 真实公众号凭据白名单出站与 P2 宿主机定时备份 cron 均已实测通过。
>
> 本目录只做实测取证与脱敏汇总；业务源码（`server/`、`renderer/`、`desktop/`、`shared/`、`deploy/`）零改动，未 `git commit` / `git push`。

## 1. 环境与拓扑

- **生产主机**：阿里云青岛 **2C2G**（1613M RAM + 2047M Swap，`/` 40G）。
- **反向代理**：容器 `edge-nginx`；`443 ssl`，**TLSv1.3**，证书 Let's Encrypt；`/api/v1/desktop/channel` 支持 **WebSocket Upgrade**；向后端传递 `X-Forwarded-For`。
- **业务容器**：`postgres` + `app` + 文档解析沙箱等共 4 个，升级后全部 `healthy`；同机其余业务容器零触碰。
- **公网域名**：`https://ops-api.88813888.xyz`。生产出口为阿里云青岛固定 IPv4 **`<prod-public-ip>`**，与生产 `.env` 的 `OPS_PUBLIC_IP` 一致。
- **本机验收环境**：Windows 11 10.0.26200；Node.js 22.23.2；打包 Electron 44.9.1 / OPS Desktop 0.1.1；桌面隔离目录 `%TEMP%\ops-verify05-userdata`，真实用户应用数据目录（OPS Desktop）零触碰。
- **代码基线**：生产镜像构建自提交 `1942145`（`origin/main`）；本机验收仓库 `HEAD=d2e8eb47`，仅比生产多 1 个 VERIFY-04 证据提交，业务源码无差异。

## 2. Step 1：平滑升级与固定出口（服务器侧执行，此处汇总引用）

- 经官方 `./update.sh` 升至提交 **`1942145`**，镜像构建耗时 **254.4s**；镜像 `sha256:d4fddec755f3a49703247c04ee72b77128fe3ab1fccabbe65f83b4840904ff84`（`2026-11-26T15:09:54+08:00`），4 个容器全部 `healthy`。
- 运行态：`OPS_DEV=0`、`OPS_STATIC_DIR` 置空、`HTTP_PROXY` / `HTTPS_PROXY` 置空、`NO_PROXY=*`、`OPS_TRUSTED_PROXIES=172.16.0.0/12`；`OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 未开启（关）。
- **固定出口**：宿主机无代理直连公网出口为阿里云青岛固定 IPv4（`<prod-public-ip>`，与 `.env` 中 `OPS_PUBLIC_IP` 一致）；直连 `https://api.weixin.qq.com/cgi-bin/token` 返回 **HTTP 200**。
- **微信真实凭据白名单校验：首轮未完成（已于 2026-11-26 补验闭环，见 §10.6）。** 首轮线上 `wechat_credential=0`（无已配置凭证），`POST /accounts/{id}/wechat-credential/test` 未执行，未冒充该子项通过。

## 3. Step 2：HTTPS / CORS / WSS、打包客户端、多租户与公网预览

### 3.1 HTTPS、CORS 与静态站关闭

- TLS：`TLSv1.3` / `TLS_AES_256_GCM_SHA384` / ALPN `http/1.1`；证书由 Let's Encrypt 签发，SAN 覆盖 `ops-api.88813888.xyz` 与 `ops.88813888.xyz`。
- `GET /healthz`、`GET /api/v1/healthz` 均 **200 `ok`**；`GET /api/v1/desktop/release?current=0.1.1` **200**（未配置更新源）。
- CORS：桌面来源 `ops-desktop://business` 预检 **204**，允许凭据；非可信来源 `https://evil.example.invalid` 预检 **403** 且不回 `Access-Control-Allow-Origin`。
- 静态站：`GET /` 与 `GET /works` 均 **404 `404 page not found`**，不再返回旧 Web SPA（`OPS_STATIC_DIR=""` 生效）。

### 3.2 WSS 与打包客户端

- `wss://ops-api.88813888.xyz/api/v1/desktop/channel` 原始 HTTP Upgrade **101 Switching Protocols**；握手消息 `channel.hello → channel.ready → channel.ready_ack → channel.heartbeat → channel.heartbeat_ack`。
- 真实打包桌面端：`isPackaged=true`、版本 `0.1.1`、页面源 `ops-desktop://business`、生产 HTTPS 登录成功；诊断 IPC 16 键齐全，初始 `disconnected` → 最终 `ready`（“WSS 通道已连接；桌面 AI 模式尚未应用。”），设备已登记、心跳往返成功。
- 特性开关：A 档 **11/11 开**；B/C 档 **8/8 关**（`chrome_connect`、`browser_workspace`、`personal_memories`、`plugin_mcp`、`subagents`、`voice_dictation`、`voice_realtime`、`computer_use`）；`auto_adopt` 未在公开能力中暴露，部署值为关。
- 截图：`01-desktop-prod-connected.png`（真实桌面 8 路由巡检，0 console error / 0 pageerror）；`02-feature-gates-prod.png` 为真实 `GET /api/v1/agent/bootstrap` 结果的只读渲染（测试 owner 非系统管理员，产品内无该矩阵页面，已如实标注）。

### 3.3 双工作区与三角色隔离

- 工作区：`RC17-WS-A-1530`（账号 `RC17V05-A-公众号-1530`、作品 `workA`）与 `RC17-WS-B-1530`（账号 `RC17V05-B-公众号-1530`、作品 `workB`）；`owner / editor / viewer` 三角色经邀请码真实加入 WS-A。
- 权限矩阵 **49 项断言，首轮 48 PASS / 1 FAIL**（D1 已于 `254dab4` 修复，复验 49/49 全 PASS，见 §10.4）：
  - viewer：读 workA 200；新建/修改/删除作品与段落 403；发起公众号推送 403；删除资产 403。
  - editor：可改 workA 段落 200；创建邀请 403；修改账号公众号凭证 403。
  - 跨工作区：editor / viewer 访问 workB、accountB 均 404/403，标题与账号名零泄漏。
- 审计：WS-A 审计查询最终 18 条，`workspace_b_target_leaks=0`、`entries_with_detail_ip=0`、`action=login=0`；登录 IP 以 `GET /api/v1/auth/me.prev_login_ip` 核对，服务端记录与客户端国内直连出口一致（均为 `39.88.x.x`），非 Docker 网关/私网地址。
- **首轮唯一失败 D1（已修复，见 §10.4）**：viewer `GET /api/v1/works/{workA}/wechat/push-preview` 返回 **200**，未按只读角色拦截；响应仅含凭证状态对象，无明文 AppSecret。

### 3.4 公网预览页（OPT-W03）

- 真实 `workA` 生成 215 字符 token 的公网链接（`https://ops-api.88813888.xyz/preview/<token>`，token 未写入仓库）；手机视口 Playwright（390×844、DPR 2、无 Cookie）：**200**，`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、CSP 生效。
- XSS 探针在标题/正文中原样存储（写入侧未净化），但预览模板实体转义 + CSP 阻止执行：`window.__rc17_xss=undefined`、`script_nodes=0`，探针仅作为文本显示；未观察到执行。
- 匿名图片资产：`GET /api/v1/public-previews/<token>/assets/1f97a63f-...` **200 `image/png` 4915B**，SHA-256 `29f46bad…`，与 Step 2 上传压缩结果一致。
- 负例：无效 token **404**；作品删除后原链接 **404**，均返回可读中文提示。
- 截图 `03-public-preview-mobile.png`。
- **首轮缺陷 D8（已修复，见 §10.5）**：桌面预览页二维码与“打开手机预览”链接使用 `window.location.origin + '/preview/' + token`，在 Electron 下变成 `ops-desktop://business/preview/<token>`，**不是公网 https 地址**，手机扫码无法打开；根因 `renderer/pages/work/Preview.tsx`。

## 4. Step 3A：备份 → 破坏 → 恢复演练

- 备份前生产基线：`app_user=10 / workspace=12 / platform_account=10 / work=4 / asset=2 / image_assets=2 / audit_log=163 / goose_max_ver=141`。
- `ENV_FILE=.env ./backup.sh` 产出 `ops-db-20261126-160718.sql.gz`（**119K**）与 `ops-assets-20261126-160718.tar.gz`（**191K**）。
- **首轮缺陷 D9（已修复，见 §10.2）**：原样执行 `restore.sh` 失败——脚本无 `+x` 位；且 `OPS_COOKIE_SECURE=0` 与 `docker-compose.prod.yml` 默认 `OPS_COOKIE_SAMESITE:-none` 冲突，触发 `config.go:143-146` 校验退出。
- 显式传入 `OPS_COOKIE_SAMESITE=lax BACKUP_DIR=/var/backups/ops bash ./restore.sh` 后完整通过：`/healthz` 正常；最新 PNG `1f97a63f-84d0-486f-a6f9-964d23000e99` 字节数 **4915**、SHA-256 `29f46bad…` 校验通过；整库 `COPY` 行数与基线一致；临时容器/卷 **0** 残留；全程 **18 秒**。
- **首轮未完成项 P2（已补配闭环，见 §10.3）**：宿主机尚未配置定时备份 `crontab`（核验结果 `NO OPS CRON`）。

## 5. Step 3B：`OPS_DESKTOP_PLATFORM_ENABLED=0` 关闭态（OPT-U06）

- 真实打包桌面端、生产 `enabled=false / server_env_disabled`：设置页正确渲染提示条“服务端未开启 OPS_DESKTOP_PLATFORM_ENABLED=1，本机自动采集与状态心跳已暂停”（`data-testid=platform-collection-disabled-notice`，790×43 CSS px，可见）。
- 32 秒窗口内 `presence` 心跳 0 次、主进程 0 条 platform-presence 日志；`presence_status=offline`、`collection_status=idle`，两次采样跨越 30 秒周期仍提前返回，证明心跳被真实抑制。
- 0 pageerror / 0 应用级 console.error / 0 平台采集相关报错；仅 2 条公众号草稿箱缺凭证的 409 网络 console 消息（UI 已明确说明、非循环、与本步无关）。
- 截图 `04-platform-disabled-explicit.png`；细节见 `step3b-platform-disabled.json`。

## 6. Step 3C：数据库短暂停机 503 → 客户端可读报错 → 重连 200

- 监听：每 1 秒 `GET /healthz`（超时 4s），忽略 502 与网络闪断。`16:44:41.967` 捕获 app 重建的 **502** 闪断（2 个采样），`16:44:43.985` 恢复 200。
- **停机捕获**：`16:44:46.019` 精确 **503**，正文 `数据库不可用`；同一时刻 `GET /api/v1/healthz` 亦 **503**。
- **桌面真实撞库**：在 503 窗口内从作品页切到工作台再切回作品页，触发 `GET /accounts/{accountId}/works` 真实重载；窗口内 23 个业务 API 调用、**17 个失败且全部 500**（含 works 3 次、`auth/me`、`accounts`、`dashboard` 等）。作品页显示 **“加载失败 / 服务器内部错误，请稍后重试（请求 ID：5HdJS-000036）” + “重试”**，无 toast、无静默空白。
- 截图 `05-db-outage-503.png`（1802×1020，74548B）。
- **恢复**：`16:45:06.550` 连续第 2 次 **200 `ok`**，中断总时长 **20.5 秒**（与 18 秒停/启 postgres 吻合）。
- `GET /api/v1/desktop/capabilities` 恢复 **200 且 `platform_collection.enabled=true`**——证明 Tabby 已成功还原 `.env`（Step 3B 时为 false）；`GET /api/v1/auth/me` **200**（`rc17v05_1530_owner / owner / RC17-WS-A-1530`）。
- 桌面点击“重试”：作品列表 1 行恢复、报错消失；打开 `workA`（`/works/fd6543e7-...`）正文与“01 引言 / 02 正文 / 148 字”可读。截图 `06-db-recovered-200.png`（1802×1020，157293B）。
- 退出：原生确认框“退出客户端”优雅关闭，残留进程 **0**、CDP 端口关闭；`%TEMP%\ops-verify05-userdata` 与 `state.json` 已删除；真实用户应用数据目录（OPS Desktop）文件数 19374→19374、最新写入时间未变。
- 细节见 `step3c-db-outage-recovery.json`。

## 7. 缺陷与未完成项（已全部修复并在生产复验闭环）

| 编号 | 级别 | 领域 | 真实发现 | 根因 / 影响 | 处理（2026-11-26 终态） |
| --- | --- | --- | --- | --- | --- |
| **D8** | 中 | 桌面公网预览 | 桌面二维码/“打开手机预览”指向 `ops-desktop://business/preview/<token>`，非公网 https | `renderer/pages/work/Preview.tsx` 以 `window.location.origin` 拼接；手机扫码不可用 | **已修复**（改用服务端公网基址）；`254dab4` 打包复验二维码与链接精确指向公网 HTTPS、零 `ops-desktop://`，见 §10.5 |
| **D9** | 中 | 备份恢复脚本 | `restore.sh` 无 `+x`；`OPS_COOKIE_SECURE=0` 与 compose 默认 `OPS_COOKIE_SAMESITE:-none` 冲突，`config.go:143-146` 退出 | 默认路径不可直接执行；需手工传 `OPS_COOKIE_SAMESITE=lax` 才能完成恢复 | **已修复**（`restore.sh` 补 `100755` + SameSite 默认兼容）；`254dab4` 上不传额外环境变量原生 `./restore.sh` 一次通过，20 秒、0 残留，见 §10.2 |
| **D1** | 中 | viewer 权限 | viewer `GET /works/{id}/wechat/push-preview` 返回 200 而非 403 | `blockViewerWrites` 只拦写方法，只读预览端点无角色校验；响应无明文密钥 | **已修复**（`push-preview` 增加角色校验）；`254dab4` 上线 owner/editor=200、viewer=403，49/49 全 PASS，见 §10.4 |
| **P1** | 补验 | 微信白名单 | 线上无已配置公众号凭证（`wechat_credential=0`），真实凭据 `POST /accounts/{id}/wechat-credential/test` 未执行 | 固定出口已实测 200，但真实凭据白名单校验未闭环 | **已闭环**：服务器固定出口 IP 入公众号 API IP 白名单，打包桌面端「测试连接」实测 `last_check_ok=t`、成功获取 `access_token`，见 §10.6 |
| **P2** | 补配 | 定时备份 | 宿主机无 `crontab` 备份任务（`NO OPS CRON`） | 仅有手工 `backup.sh`，无跨日自动备份 | **已闭环**：宿主机 `crontab` 幂等配置每日 `30 3 * * *` 备份 + 日志 `/var/log/ops-backup.log`（`640`），见 §10.3 |

## 8. 证据清单

| 文件 | 内容 |
| --- | --- |
| `01-desktop-prod-connected.png` | 打包桌面端生产 HTTPS 登录后 8 路由巡检，WSS ready |
| `02-feature-gates-prod.png` | A 档 11/11 开、B/C 档 8/8 关（真实 bootstrap 结果只读渲染） |
| `03-public-preview-mobile.png` | 公网 `/preview/{token}` 手机视口 390×844，图片与中文正文渲染 |
| `04-platform-disabled-explicit.png` | `OPS_DESKTOP_PLATFORM_ENABLED=0` 显式提示条 + 心跳抑制 |
| `05-db-outage-503.png` | 停库窗口作品页“加载失败 / 服务器内部错误” + 重试 |
| `06-db-recovered-200.png` | 恢复后 workA 正文与目录可读、报错消失 |
| `07-d8-desktop-qr-public-https.png` | 打包桌面端排版预览页：二维码与「打开手机预览」精确指向公网 HTTPS（D8 复验） |
| `08-d1-viewer-push-readonly.png` | 打包桌面端 viewer 进入 `/works/{id}/push`：只读卡片 +「返回作品预览」，`push-preview` 请求 0（D1 复验） |
| `step2-client-multitenant-preview.json` | Step 2 全量脱敏数据（HTTPS/CORS/WSS/多租户/预览/缺陷 D1/D8） |
| `step3b-platform-disabled.json` | Step 3B 关闭态提示、心跳抑制与日志核对 |
| `step3c-db-outage-recovery.json` | Step 3C 503/500/200 全时序、截图哈希与清理核对 |
| `step4-fix-reverify.json` | Step B 全量脱敏数据（`pnpm package` / D1 三角色矩阵 / D8 二维码与无会话手机视口 / 清理核对） |

## 9. 判定

- **RC-17 第 1～6 条通过标准：全部 PASS（6/6）。**
- **RC-17 正式闭环（2026-11-26）。** D1 / D8 / D9 三个真实缺陷已在生产提交 `254dab4` 上修复并复验闭环；P1 真实公众号凭据白名单出站与 P2 宿主机定时备份 cron 均已实测通过。
- 本轮只做验收取证与文档归档，业务源码零改动，未 `git commit` / `git push`。

## 10. 最终复验与闭环记录（2026-11-26，生产提交 `254dab4`）

### 10.1 线上升级

- 经官方 `./update.sh` 升至 `254dab4`：镜像 `sha256:a1b2fcf397ca30e8c032f5158a73e07bd3bc1b8e9d9d1e20557dda8e`（`2026-11-26T17:50:48+08:00`）；4 个容器全部 `Up (healthy)`，`GET /healthz` 返回 `ok`。

### 10.2 D9 线上闭环（备份恢复脚本原生可执行）

- `/opt/ops/deploy/restore.sh` 权限实测 `-rwxr-xr-x`（`100755`）。
- **不传任何额外环境变量**，原生直跑 `BACKUP_DIR=/var/backups/ops ./restore.sh` 一次通过：使用 `ops-db-20261126-173739.sql.gz` + `ops-assets-20261126-173739.tar.gz`；`/healthz` 正常，图片字节数 `4915`、SHA-256 校验通过；**耗时 20 秒**；临时容器 `0`、临时卷 `0` 残留。

### 10.3 P2 闭环（宿主机定时备份）

- `crontab` 已幂等配置每日定时备份：`30 3 * * * /opt/ops/deploy/backup.sh >> /var/log/ops-backup.log 2>&1`；日志文件 `/var/log/ops-backup.log` 权限 `640`。

### 10.4 D1 线上复验闭环（viewer 只读）

- 公网 `GET /works/{id}/wechat/push-preview` 实测：`owner=200 / editor=200 / viewer=403 forbidden`，多租户权限矩阵 **49/49 全 PASS**。
- 重打打包客户端（带 `254dab4`）以 `viewer` 进入 `/works/{id}/push`：展示只读卡片「观察者只读，不能写入草稿」+「返回作品预览」；发向 `/wechat/push-preview` 的请求数为 **0**（截图 `08-d1-viewer-push-readonly.png`）。

### 10.5 D8 线上复验闭环（桌面公网二维码）

- `pnpm package` 重打带 `254dab49` 的 `OPS Desktop.exe` 连线上；预览页二维码与「打开手机预览」`href` 精确指向 **`https://ops-api.88813888.xyz/preview/<token:215chars>`**（零 `ops-desktop://`）。
- 无会话手机视口直开 **200**，`Referrer-Policy: no-referrer`（截图 `07-d8-desktop-qr-public-https.png`）。

### 10.6 P1 真实公众号白名单出站闭环

- 用户经微信开发者平台将服务器固定出口 IP（`<prod-public-ip>`）加入公众号 API IP 白名单。
- 在打包桌面端连线上保存加密凭据并点击「测试连接」（`POST /api/v1/accounts/{accountId}/wechat-credential/test`）。
- 生产库 `wechat_credential` 只读核验实录：`last_check_ok = t`；`last_check_result = 连接正常，已成功获取 access_token`；`last_check_at = 2026-11-26 12:54:37.060885+00`（东八区 `20:54:37`）。无 `40164` 错误，全程零明文凭据外泄。
