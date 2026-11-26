# VERIFY-01 真机验证批次记录（RC-23 / OPT-U01~U06 + POLISH-02 + OPT-E02）

- 批次：`VERIFY-01`（RC-23 真机验证，只做验证不新增功能）
- 日期：2026-11-26 11:20–11:35（Asia/Shanghai）
- 仓库基线：`main` @ `a3d412d7`，开始时工作树干净，无未提交改动
- 结论：**6 项客观验收全部 PASS，未发现真实 UI/UX 缺陷**。RC-23 仍不得标记“已闭环”：第 5 条通过标准里的“邀请 1 位未参与开发的真实操作者完成首篇作品”和“新用户首跑录屏”本批次未执行（需真人 + 录屏，见文末未完成项）。

## 1 执行环境与隔离

| 项目 | 事实 |
| --- | --- |
| 操作系统 | Windows 11 专业工作站版 10.0.26200 |
| 桌面客户端 | `desktop/.build/main.js`（构建产物 2026-11-26 09:53，包含 POLISH-02 / E02 / U03 IPC），Electron 44.9.1 |
| 服务端 | `go run ./cmd/ops serve`，Go 1.24.5，`OPS_DEV=1` |
| 数据库 | 独立库 `ops_verify01`（`ops-dev-postgres-1` / PostgreSQL 16.14，端口 5440）；**未使用也未启动 `ops-prod-e2e-*` 容器** |
| 前端 | Vite 6.4.5 开发服务器 `127.0.0.1:15281`（独立端口，不占 5173） |
| API / 模拟模型 | `127.0.0.1:18081` / `127.0.0.1:18091`（独立端口，不占 8080/8091） |
| 桌面用户目录 | `%TEMP%\ops-verify01\userData`（独立 `--user-data-dir`，不碰真实用户配置） |
| 平台采集开关 | `OPS_DESKTOP_PLATFORM_ENABLED=0`（验证 U06 禁用提示，**未开启**自动采用闸门） |
| 账号 | `verify01-user`（本地首跑 `/setup` 注册，零平台账号起步）、`verify01-xhs`（普通小红书图文账号） |

未请求、未伪造任何真实平台写权限；未改动仓库中的生产配置与数据。

## 2 逐项实测

判定口径：每项按“操作 → 期望 → 实际”记录；逐条 PASS/FAIL 原始输出见 `command.log`。

### 项 1 OPT-U01 冷启动 + 示例工作区（截图 `01-onboarding-and-demo.png`）

- 操作：真实 Electron 窗口冷启动 → 首跑 `/setup` 注册 → 工作台（零平台账号）→ 点「先用示例体验（5 分钟）」→ 浏览示例作品 → 对示例作品发起真实外发。
- 期望：不硬拦截；示例账号带「示例」标注；示例外发被后端硬拦且界面可继续操作。
- 实际：
  - 零账号出现冷启动欢迎页，入口文案为「先用示例体验（5 分钟）」；`POST /demo` 生成 2 个账号：`wechat_mp:示例 · 职场成长笔记`、`xhs:示例 · 效率工具手账`，首页与账号页均有「示例」徽标（`01a`、`01`）。
  - 示例作品推送页前端先给检查闸门（`01b`）；直接调 `POST /works/{id}/wechat/push` 返回 **HTTP 409** `demo_account_readonly`「示例账号仅供体验写作与预览，不能写入真实平台草稿，请先绑定真实账号」。拦截后作品列表仍可正常浏览（`01c`）。
- 判定：PASS。

### 项 2 信息架构 + 技能管理 + 采集禁用提示 + 诊断 + 更新（截图 `02-skills-and-ia.png`、`03-...png`、`04-update-dialog.png`）

- 操作：侧栏第一组 → 点「AI 对话」；打开设置窗；展开「写作与风格 → 写作技能」；偏好设置「此电脑」查看采集提示与本机诊断；导出诊断（先取消、再保存到临时文件）；点「检查更新」→ 底栏提示 → 打开更新弹窗。
- 期望 / 实际：
  - 侧栏固定 3 组且顺序为 `AI 助手 | 创作 | 资产与复盘`（与仓库既有 E2E 同口径校验 DOM），「运营」仍在资产与复盘组；点「AI 对话」直达 `/agent`。侧栏为 64px 图标铁路（折叠态，悬停不展开），属既有桌面设计。
  - 设置窗 6 个分组：`账号与平台 | AI 模型 | 写作与风格 | 团队与工作区 | 本机客户端 | 高级与诊断`；高级组默认 `aria-expanded=false`，与常用组之间有分隔线。
  - 写作技能页完整可用：可见「新建技能」「另存副本」「导出」等管理入口，无“仅网页可用”锁死提示（`02`）。
  - 偏好设置「此电脑」：采集禁用提示条真实文案「服务端未开启 OPS_DESKTOP_PLATFORM_ENABLED=1，本机自动采集与状态心跳已暂停」。
  - 诊断摘要：`业务连接：已连接 · 客户端 v44.9.1 · Electron 44.9.1 · win32/x64`、`AI 执行模式：服务器 AI`、`本机通道/安全加密存储/本机配置/设备登记/本机模型/在途模型请求` 全部渲染（`03`）。IPC 摘要严格 16 键：`appVersion,electronVersion,platform,arch,connectionState,mode,channelState,channelMessage,routeRevision,signedIn,reauthRequired,storageAvailable,localConfigAvailable,deviceRegistered,modelCount,activeModelRequests`，不含 `nodeVersion/service` 等落盘字段。
  - 导出取消分支：拦截 `dialog.showSaveDialog` 返回 `canceled`，界面既不报成功也不报错。
  - 导出保存分支：真实写盘到临时目录并弹「已导出脱敏诊断信息」；JSON 结构 `generated_at/app/service/business_connection/client` 完整，全文不含 token/cookie/password/secret/api_key（脱敏样本见 `diagnostics-sample.json`，`service` 端口已脱敏为 `<port>`）。
  - 更新：点「检查更新」后行内显示「当前版本 v44.9.1 · 发现新版本 v44.9.2」，底栏出现「发现新版本 v44.9.2」提示按钮，**弹窗没有自动弹出**；点提示按钮打开「客户端版本更新」弹窗，含当前/最新版本、真实发布说明、64 位 SHA-256、「前往下载」（本次未点击外链），「稍后」可关闭（`04`）。
- 参数偏差（如实记录）：验收说明里的“最新版本 9.9.9 / current=0.1.0”在本机不成立——未打包的 dev 窗口 `app.getVersion()` 返回 **44.9.1**，9.9.9 会被判为“已是最新”。为使“发现新版本”分支真实可测，服务端测试参数改为 `OPS_DESKTOP_LATEST_VERSION=44.9.2`（`OPS_DESKTOP_DOWNLOAD_URL/SHA256/RELEASE_NOTES` 同步），这是环境参数而非代码改动。
- 判定：PASS。

### 项 3 快写模式 + 检查页分级 + Q-14（截图 `05-quick-draft-and-check-q14.png`、`05c-...png`）

- 操作：新建普通小红书图文账号与作品 → 编辑器确认默认「快写模式」→ 一句话生成初稿 → 写入正文 → 生成标题并采纳 → 话题建议写入 → 进入检查页「开始检查」→ 滚到底部点击最后一项并核对按钮。
- 实际：
  - 小红书空稿默认 `writing-mode-quick`（`aria-pressed=true`），页面无“先写核心观点/先确认大纲”的硬门（无 H-02/H-03 阻断）。
  - 一句话写入成功（提示「已生成大纲并写入正文，现在可逐段修改或生成标题」），作品正文 2 段，观点自动兜底非空（未被 H-02 卡住）。
  - 标题接口返回候选并采纳；话题建议接口返回并写入（`05a`、`05b`）。
  - 检查页分级摘要：`必须处理 2 项 / 格式问题 1 / 待逐条确认 1 / 已通过格式规则 2 项（默认折叠）`；页面无「全部确认」按钮。
  - **Q-14 回归**：检查页右列 `position=static`（非 sticky）；检查页自身是滚动出口（`scrollHeight 954 / clientHeight 294`，滚到底 `scrollTop=661`）；最底部检查项读到的 `getBoundingClientRect` 为 `top 575 / bottom 646`（root 视口 479–773），完整落在视口内；点击最底部“可逐条确认”项后 `已确认 0/1 → 1/1` 真实变化；「确认完成检查」始终完整可见（`05`）。
  - 1280×800 视口下同样 PASS：最底部检查项 `552–622` 落在 root 视口 `465–749` 内，主按钮 `49–81` 可点（`05c`）。
- 观察（非缺陷）：检查页上方的“发布字段/平台能力”面板按既有设计占 `max-h-[38vh]`（`WorkLayout.tsx` REF41 P3），因此 1440×900 下检查页滚动出口只有约 294px；滚动本身正常，Q-14 的“底部项与按钮不可达”问题确已不复现。
- 判定：PASS。

### 项 4 小红书填草稿失败人工接管（截图 `06-xhs-manual-fallback.png`）

- 操作：给小红书作品上传 2 张真实 PNG（900×1200，3:4）→ 补封面/标签 → 生成 manifest（`valid`）→ 创建发布任务 → 进入账号运营页。
- 期望：失败/未登录态出现兜底栏；可复制标题、复制正文（含内联 `#话题`）、打开有序图片文件夹；无“直接发布/批量执行”入口；返回值不含本机绝对路径。
- 实际：
  - 2 张真实素材上传成功，manifest 校验通过（期间先失败过一次：缺封面 `cover_ratio`、标签 0 个；补齐后通过，这属于校验器的正常拦截）。
  - 兜底栏原因文案「小红书登录会话已过期或未登录：请重新登录后重试，或直接用下方「复制标题 / 复制正文（含内联 #话题） / 打开有序图片文件夹」完成人工发布。」
  - 「复制标题」→ Electron 剪贴板真实读到 `想把「每天写 300 字」这`；「复制正文」→ 正文末尾含 `#写作习惯 #效率 #自律`。
  - 「打开有序图片文件夹」走真实 IPC `publish-pack:open-xhs-images`（仅拦截 `shell.openPath` 防止弹资源管理器）：落盘到 `%TEMP%\ops-xhs-manual-pack\<workId>-<ts>\`，文件名 `01_封面.jpg`、`02.jpg`（服务端 asset 端点输出 JPEG，扩展名随之），两个文件均非空且文件头为真实 JPEG（`ffd8ffdb`，34,046 / 29,625 字节）；界面不出现任何本机绝对路径。
  - 页面只有逐条「重试 / 改为手动 / 跳过 / 登记已发布」，没有直接发布或批量执行按钮。
- 辅助触发披露（**必须如实说明**）：真实小红书登录态无法在本批次内伪造。为了让“失败/未登录态”真实出现，任务仍由真实接口 `POST /works/{id}/publish-tasks` 创建（`state=ready`），随后只在隔离开发库执行了一条：
  `UPDATE publish_task SET state='failed', last_error_code='not_logged_in', last_error_message='小红书未登录或登录已失效，请先在本机重新登录' ... WHERE id='<task id>'`
  界面读取的仍是真实接口返回的任务数据；本批次**没有**真实小红书登录会话，也没有任何真实小红书写入。
- 判定：PASS（失败态由已披露的库状态辅助触发，非伪造截图）。

### 项 5 复盘页截图粘贴逐行核对（截图 `07-review-screenshot-paste.png`）

- 操作：复盘页 → 向窗口派发真实 `ClipboardEvent('paste')`（携带 900×1200 PNG `File`）→ 二次确认 → 逐行核对弹窗。
- 实际：
  - 粘贴入口挂载可见，说明含 `Ctrl+V`，文案明确“逐行核对、无全部导入”。
  - 首次粘贴先出现诚实二次确认「还没有指定图片识别模型 … 默认模型不支持图片输入时会识别失败」，点「仍要上传」后进入真实识别链路（`07b`）。
  - `POST /accounts/{id}/metrics/screenshots` 返回 1 行可确认数据：观看 12000、点赞 36、收藏 8；界面提示“标题没对上作品”“评论在截图文字里找不到，已丢弃”等可读原因（`07`）。
  - 弹窗只有逐行「导入这一行」和「完成」，无「全部确认 / 全部导入 / 一键入库」。
- 观察（非缺陷）：dev 种子模型未标 vision，所以先弹二次确认；本次 mock 仍返回了可解析结果，真实非视觉模型时会按该文案失败，行为与文案一致。
- 判定：PASS。

### 项 6 一键清空示例（截图 `08-after-clear-demo.png`）

- 操作：示例账号页 → 横幅「清空所有示例账号与示例稿件」→ 确认对话框「清空示例数据」。
- 实际：`DELETE /api/v1/demo` 后示例账号 0 个；普通账号数量清空前 1、清空后 1（`verify01-xhs` 未受影响）；自动落到普通账号工作台，示例横幅消失，提示「示例账号与示例稿件已清空」（`08`）。
- 判定：PASS。

## 3 未完成 / 不可替代项

1. **新用户盲测**：RC-23 通过标准第 5 条要求“邀请 1 位未参与开发的真实操作者走完首篇作品”，本批次为开发侧真机验证，无法替代真人盲测。
2. **新用户首跑录屏**：本批次只归档截图（`01a`→`08`），RC-23 完成判定要求的录屏尚未产出。
3. 因以上两项未满足，`docs/42` 中 RC-23 只能登记为“真机验证批次 VERIFY-01 通过（客观项 6/6）”，**不得**标记“已闭环”。

## 4 清理

测试结束后：关闭 Electron 与 Playwright 驱动、停止 Vite（15281）与 API（18081/18091）、停止 `ops-dev-postgres-1`、删除验证库 `ops_verify01`、删除 `%TEMP%\ops-verify01` 与 `%TEMP%\ops-xhs-manual-pack`。仓库内只保留本目录证据与文档改动，无锁文件、冲突标记或临时目录。

`ops-prod-e2e-*` 容器本批次未启动、未停止、未写入；收尾时观察到其中 app/postgres/parser_a/parser_b 处于 `Up`（约 2 小时前启动，早于本批次开始），属其他进程的既有状态，本批次未触碰。

## 5 复现命令块（占位符，按需替换）

本批次使用的驱动脚本与临时环境已按清理要求删除，下面给出可复现的最小步骤（变量均为占位符，端口/库名/账号按需替换）：

```powershell
# 0) 基线核对（必须在干净工作树开始）
cd <repo>
git rev-parse --short HEAD; git status --short; git diff --stat

# 1) 隔离库（只用开发库容器，不动 ops-prod-e2e-*）
docker start ops-dev-postgres-1
docker exec ops-dev-postgres-1 psql -U <db_user> -d postgres -c "CREATE DATABASE <verify_db>;"

# 2) 服务端（后台，端口自选，一次配好全部 env）
#    OPS_DESKTOP_PLATFORM_ENABLED=0 用于 U06；OPS_DESKTOP_LATEST_VERSION 必须 > 客户端 app.getVersion()
$env:OPS_DEV='1'; $env:OPS_DESKTOP_PLATFORM_ENABLED='0'
$env:OPS_DATA_DIR="$env:TEMP\<verify_dir>\data"; $env:NO_PROXY='127.0.0.1,localhost,::1'
$env:OPS_DESKTOP_LATEST_VERSION='44.9.2'
$env:OPS_DESKTOP_RELEASE_NOTES='VERIFY-01 真实窗口更新检查实测说明'
$env:OPS_DESKTOP_DOWNLOAD_URL='https://releases.example.com/ops-desktop/OPS-Desktop-Setup-44.9.2.exe'
$env:OPS_DESKTOP_SHA256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
# go run ./cmd/ops serve --addr 127.0.0.1:<api_port>（按仓库实际 flag 调整）

# 3) 前端开发服务器（独立端口，避免占用 5173）
#    OPS_API_TARGET=http://127.0.0.1:<api_port>; pnpm dev --host 127.0.0.1 --port <vite_port> --strictPort

# 4) 驱动（Playwright _electron，独立 userData，关闭 ELECTRON_RUN_AS_NODE）
#    node <verify_dir>\driver.mjs <step 1..6>

# 5) 仅当需要复现“小红书未登录失败态”时（必须在隔离库、并标注为辅助触发）
docker exec ops-dev-postgres-1 psql -U <db_user> -d <verify_db> -c "UPDATE publish_task SET state='failed', last_error_code='not_logged_in' WHERE id='<task_id>';"

# 6) 收尾：停进程/停容器/删库/删临时目录
docker exec ops-dev-postgres-1 psql -U <db_user> -d postgres -c "DROP DATABASE IF EXISTS <verify_db>;"
docker stop ops-dev-postgres-1
Remove-Item -Recurse -Force "$env:TEMP\<verify_dir>"
```

## 6 证据清单

| 文件 | 内容 |
| --- | --- |
| `01-onboarding-and-demo.png` | 示例工作区首页：示例横幅 + 「示例」徽标 + 示例作品 |
| `01a-cold-start-welcome.png` | 零平台账号冷启动欢迎页（5 分钟示例入口） |
| `01b-demo-push-gate.png` | 示例作品推送页检查闸门 |
| `01c-demo-still-usable.png` | 外发被 409 拦截后界面仍可正常浏览 |
| `02-skills-and-ia.png` | 设置窗 + 写作技能完整管理 |
| `02a-sidebar-ia.png` | 侧栏 3 组图标铁路 |
| `03-preferences-diagnostics-and-update-pill.png` | 采集禁用提示 + 诊断摘要 + 更新行 |
| `04-update-dialog.png` | 更新弹窗（版本、说明、SHA-256） |
| `05-quick-draft-and-check-q14.png` | 检查页分级摘要 + 最底部项已确认 + 主按钮 |
| `05a-quick-mode-editor.png` / `05b-quick-draft-result.png` | 快写模式与出稿结果 |
| `05c-check-q14-1280x800.png` | 1280×800 下 Q-14 回归 |
| `06-xhs-manual-fallback.png` | 失败任务 + 人工接管台 |
| `06b-xhs-fallback-copied.png` / `06c-xhs-fallback-images-exported.png` | 复制结果 / 图片导出完成 |
| `07-review-screenshot-paste.png` | 逐行核对弹窗 |
| `07a-review-dropzone.png` / `07b-review-model-notice.png` | 粘贴入口 / 未配视觉模型二次确认 |
| `08-after-clear-demo.png` | 清空示例后的普通账号工作台 |
| `command.log` | 6 个实测项的原始 PASS/FAIL 输出（含明细） |
| `diagnostics-sample.json` | 脱敏后的诊断导出样本（`service` 端口已脱敏） |
