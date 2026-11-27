# RC-11 SMTP 成员邀请与密码重置闭环

> 状态：**已闭环（2026-11-27，4/4 通过标准全 PASS；生产提交 254dab4 + 桌面端 D-225 / 8f4f47e9）**

## 环境与方法

- 服务端：线上生产 `https://ops-api.88813888.xyz`（提交 `254dab4`），真实 163 SMTP、真实 QQ 收件箱，非 mock。
- 客户端：打包产物 `desktop/out/OPS Desktop-win32-x64/OPS Desktop.exe`（版本 `0.1.0`，构建时间 `2026-11-26 21:37:27 +08:00`），每次启动均使用独立 `--user-data-dir`（系统临时目录），结束即删除。
- 测试身份：Phase A 使用 `rc11_inv_2611262210`、`rc11_own_2611262220`、`rc11_ed_2611262220`、`rc11_vwr_2611262220`、`rc11_own_2611262222`、`rc11_pwd_2611262222`；Phase B 新增 `rc11_rbac_own_2611271027`、`rc11_rbac_ed_2611271027`、`rc11_rbac_vwr_2611271027`。均为独立测试账号，未触碰 `skyeder` 工作区与生产容器。
- HTTP 实测：Node.js 22 `fetch`，显式清空代理环境变量后直连；桌面端操作经 Electron 渲染进程的真实点击与输入完成。
- 业务源码零改动，未执行 `git commit` / `git push`。

## 口径（D-225 / D-036 / FR-M1-08）

- 邀请：工作区所有者配置真实 SMTP 后可发送邀请邮件；被邀请人用邀请码加入，角色为 `editor` 或 `viewer`，权限按 `owner / editor / viewer` 隔离。
- 密码重置：遵循 D-036 / FR-M1-08，由系统超管后台或服务器 CLI `ops reset-password <username>` 完成；登录页不提供邮件自助找回。重置后旧密码失败、旧会话失效，临时密码登录后可改新密码。
- `GET /api/v1/settings`：全体成员可读（观察者只读），`smtp` 仅下发 `host / port / username / from / has_password`，不下发明文密码或密文。
- `PUT /api/v1/settings`：仅工作区所有者可写；非所有者携带有效 CSRF 时返回 `403 forbidden`。

## 通过标准逐项结果

| # | 通过标准 | 实测结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 真实 SMTP 成员邀请发信 | **PASS**：163 `smtp.163.com:465` SSL，真实 QQ 收件箱收到邀请邮件，中文主题与正文无乱码；`workspace_invite_email` 记录 `sent` | `step2-password-reset-and-write-rbac.json` → `prod_smtp_and_db_checks` |
| 2 | 被邀请人桌面端加入与 `editor` / `viewer` 隔离 | **PASS**：被邀请人用真实邮件邀请码在打包桌面端加入；editor 可读写、viewer 只读，成员页无邀请/角色管理入口；Phase A 矩阵 46/49，3 项为同一 `GET /settings` 期望错误（已裁决），Phase B 补测 10/10 | `01-invitee-desktop-editor-mail-readonly.png`、`02-viewer-desktop-members-readonly.png`、`step1-invite-rbac.json`、`step2-password-reset-and-write-rbac.json` |
| 3 | 密码重置闭环（旧密码失败、旧会话失效、临时密码登录后改密） | **PASS**：旧会话 `GET /auth/me` 401、旧密码登录 401；打包桌面端用临时密码登录 200、`/auth/me` 200；`PUT /auth/password` 200，界面绿色提示「密码已修改，其他设备上的登录已失效」且三个输入框清空；临时密码改密后 401，新密码登录 200、`/auth/me` 200、登出 200 | `03-pwd-reset-desktop-change-success.png`、`step2-password-reset-and-write-rbac.json` |
| 4 | 失败与恢复（错误授权码 / 无效邮箱 / 改回正确配置） | **PASS**：错授权码 toast `邮件发送失败：535 "Error: authentication failed"（请求 ID：oCl1I-006204）`，DB 行 `failed`；改回正确授权码后 toast「邀请邮件已发送」，DB 行 `sent`；无效邮箱 422「请填写有效邮箱」，未尝试发信；`app_setting(key='smtp')` 无明文密码键、`enc_len=60`；`audit_log` 8 行无密码字段 | `step1-invite-rbac.json`、`step2-password-reset-and-write-rbac.json` |

## `GET / PUT /settings` 权限口径核验

Phase A 的任务书要求 `editor` / `viewer` 的 `GET /api/v1/settings` 返回 403，实测均为 200，形成口径冲突 RC11-PA-C1。经核对 `server/internal/app/settings.go`、`docs/08` 第六十轮与 `docs/16` `settings__get`，现行设计为**成员可读、smtp 整体脱敏、仅 owner 可写**。Phase B 用独立三账号补测：

| 角色 | `GET /settings` | 响应明文 | 携带有效 CSRF 的 `PUT /settings` | 无 CSRF 对照 |
| --- | --- | --- | --- | --- |
| editor | 200 | 无明文密码、无 `password_enc` | 403 `forbidden`（需要工作区所有者权限） | 403 `csrf_invalid` |
| viewer | 200 | 无明文密码、无 `password_enc` | 403 `forbidden`（观察者仅可浏览） | 403 `csrf_invalid` |

结论：`GET 200` 与既有设计一致，Phase A 的 403 期望应修正；`PUT` 在 CSRF 有效的前提下仍为 403 `forbidden`，写入隔离成立。该冲突为验收脚本期望错误，不是产品缺陷；本批只测不改码。

## 证据清单

| 文件 | 说明 | 字节 | 尺寸 / SHA-256 |
| --- | --- | --- | --- |
| `01-invitee-desktop-editor-mail-readonly.png` | 被邀请人（editor）桌面端「邀请邮件」只读提示 | 50,449 | 1803x1020；`f43dc7ec…` |
| `02-viewer-desktop-members-readonly.png` | 观察者桌面端成员页只读形态 | 87,155 | 1803x1020；`a966a041…` |
| `03-pwd-reset-desktop-change-success.png` | 桌面端改密成功：输入框清空 + 绿色成功提示（已裁去含 IP 的上次登录提示） | 50,826 | 1802x620；`1ef1d93a…` |
| `step1-invite-rbac.json` | Phase A：真实邀请码加入、editor/viewer 矩阵、零明文、密码重置前置 | 11,768 | 合法 JSON |
| `step2-password-reset-and-write-rbac.json` | Phase B：密码重置全链路、`PUT /settings` 403 补测、SMTP/DB 核验归档、清理 | 14,089 | 合法 JSON |

## 脱敏核验

- 证据目录内全部 `.md` / `.json` 与截图均不含：真实邀请码原文、临时密码 / 新密码 / 旧密码、QQ 或 163 邮箱地址、公网 IPv4、会话凭据、Windows 用户目录或应用数据目录。
- 03 截图在取证时先核对画面：零密码明文、零邮箱、零公网 IP、零本机路径；并自「上次登录」提示下方裁切，避免带出 IP。
- 临时密码仅运行时内存使用；仓库外状态文件与隔离 `--user-data-dir` 已删除，真实用户应用数据目录未读写。
- 最终扫描：本目录全部 `.md` / `.json` 与本次 `git diff` 新增行对既定禁用项（真实密码值、邀请码原文、邮箱地址、公网 IPv4、会话凭据、本机路径）0 命中；`step1` / `step2` 均通过 `ConvertFrom-Json`；全部文本纯 LF 且单结尾换行。

## 最终判定

**RC-11 四条通过标准全部 PASS，正式闭环（2026-11-27）。** 真实 163 SMTP 邀请、真实收件箱收码、桌面端加入与角色隔离、超管密码重置与桌面改密、失败与恢复均已闭环；`GET / PUT /settings` 权限口径已按既有设计裁决并有 Phase B 补测证据。业务源码零改动、未 `git commit` / `git push`，等待架构师终审。

边界：本闭环只覆盖 RC-11 的 SMTP 邀请与密码重置路径；全量真实外部批次（真 API / SMTP / 模型）仍归 `RC-25` 总验收收口，`CF-P2-QA-03` 完成度不抬。
