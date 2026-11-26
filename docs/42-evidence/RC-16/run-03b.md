# RC-16 / VERIFY-03b：Windows 真实安装、覆盖升级、卸载与系统集成验证

- 批次：VERIFY-03b（RC-16 下半场）
- 日期：2026-11-26
- 基线：`main` / `HEAD = 61346eff71e897858bd77bfe376bd32debf34946`（短号 `61346eff`）
- 工作树：开批时干净（`git status --short --branch` 仅 `## main...origin/main [ahead 5]`）
- 路径记法：`[Local]` = Windows 本机应用数据目录（Local），`[Roaming]` = 漫游用户目录（Roaming）；本报告不写真实用户名、主机名与应用数据目录字面名。
- 结论：**安装 / 首启 / 覆盖升级 / `userData` 保留 / 卸载 / 三档 DPI / 安装态原生通知触发 / 中文长路径附件 / 超限大文件拒收 / `HC-01~31` 全部 PASS**；真实物理输入法候选窗与通知中心点击跳转仍需人工 10 秒补点，商业代码签名仍未具备，**RC-16 仍为进行中，未闭环**。

## 1. 环境与工具链

| 项目 | 实测值 |
| --- | --- |
| OS | Microsoft Windows 11 专业工作站版，10.0.26200（64 位） |
| CPU / 内存 | 11th Gen Intel Core i5-11400H / 12 逻辑处理器 / 15.7 GiB |
| PowerShell | 7.6.4 |
| Node / pnpm | v22.23.2 / 10.14.0（与 `packageManager` 一致） |
| Electron（devDependency） | 44.9.1 |
| 本机物理显示器缩放 | **125%**（安装态默认实测 `devicePixelRatio = 1.25`） |
| 网络变量 | `NO_PROXY=127.0.0.1,localhost,::1`（`no_proxy` 同值）；`ELECTRON_RUN_AS_NODE` 已清除 |

## 2. 双版本安装包（零仓库残留）

| 产物 | 版本 | 字节 | SHA-256 |
| --- | --- | ---: | --- |
| `desktop/out/make/squirrel.windows/x64/OPS Desktop-0.1.0 Setup.exe`（复用 03a） | 0.1.0 | 155,339,264 | `702e986e82c1a7bf4939fbf49b70ad97605832750935a7e6126888554d2d14ac` |
| `OPS Desktop-0.1.1 Setup.exe`（本批现打） | 0.1.1 | 155,338,752 | `b8e1ca440f70c48c861664d8d0cdd3c19f9f30d93b74de4869b7d5364843c99d` |

- `v0.1.1` 构建：`cd desktop; pnpm make`，exit `0`，**114.3 s**；构建日志 199 行 / 29,994 字节，仅有 Vite 的 CSS 优化 warning 与 1 条 `api.ts` 动态/静态 import warning（文件名含 `error-boundary.tsx` 只是正则误命中），**无 build error / failed**。
- `OPS Desktop-0.1.1 Setup.exe` 的 `FileVersion` / `ProductVersion` 均为 `0.1.1`，`ProductName` 为 `OPS 线上业务桌面壳`。
- 为打 `0.1.1` 临时改过 `desktop/package.json` 的 `version`；产出后立即 `git checkout -- desktop/package.json`，`git diff desktop/package.json` **输出为空**，工作树恢复零 diff。
- 双版本安装包均已复制到 `%TEMP%\ops-verify03b\v0.1.0|v0.1.1`，复制后 SHA-256 与源文件逐字节一致。
- 说明：`pnpm make` 会重建 `desktop/out`，构建 `0.1.1` 前已先把 `0.1.0` 安装包复制到临时目录；当前 `desktop/out` 内是 `0.1.1` 产物（该目录被 `.gitignore` 忽略，不影响仓库）。
- 签名口径与 03a 一致：本批仍未采购商业证书，两个 `Setup.exe` 均为 `NotSigned`，**不冒充已签名**，仅供内部/个人试用校验（SHA-256 + 来源核对）。

## 3. 既有用户数据保护与干净安装

### 3.1 安装前基线

- `[Local]\OPSDesktop`：**不存在**（确认干净安装基线）。
- `[Roaming]\OPS Desktop`：存在；**19,373 个文件 / 2,202,207,774 字节**（含目录共 20,668 项）。
- 已完整 `robocopy /E` 备份到 `%TEMP%\ops-verify03b\userData-backup`，源/备份均为 19,373 文件、2,202,207,774 字节，逐项一致。
- 写入专用哨兵 `[Roaming]\OPS Desktop\verify03b-upgrade-sentinel.json`（44 字节），SHA-256 = `87960cd252a802b34d29a58b2382e277ac42b86cee0c8676b302b686f6a89004`。
- 桌面既有 `OPS Desktop 最新界面.lnk`：存在，1,230 字节，时间戳 `2026-10-17 21:44:29`。

### 3.2 安装 `v0.1.0`（`Setup.exe --silent`）

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| 安装进程 | `Start-Process -Wait` 返回，用时 **9.1 s** | PASS |
| `[Local]\OPSDesktop\Update.exe` | 存在 | PASS |
| `[Local]\OPSDesktop\app-0.1.0\OPS Desktop.exe` | 存在 | PASS |
| 注册表 `HKCU\...\Uninstall\OPSDesktop` | 存在；`DisplayName=OPS Desktop`、`DisplayVersion=0.1.0`、`InstallLocation=[Local]\OPSDesktop` | PASS |
| 桌面快捷方式 | 新建 `OPS Desktop.lnk`（2,259 字节） | PASS |
| 开始菜单快捷方式 | `[Roaming]\Microsoft\Windows\Start Menu\Programs\OPS\OPS Desktop.lnk` | PASS |
| Toast 激活标识 | `Squirrel-Shortcut.log` 记录 `toastActivatorCSLID 1edfc547-6f1c-5e84-a05c-949339b61200` | PASS |
| 既有 `OPS Desktop 最新界面.lnk` | 完好，1,230 字节 / `2026-10-17 21:44:29` 未变 | PASS |
| 安装拉起进程 | 无自动残留进程 | 如实记录 |

### 3.3 首启 `v0.1.0`（真实默认 `userData`）

- 驱动方式：`%TEMP%\ops-verify03b\launch-check.cjs`（Playwright `_electron.launch`，**不传 `--user-data-dir`**），`executablePath=[Local]\OPSDesktop\app-0.1.0\OPS Desktop.exe`。

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| `app.isPackaged` | `true` | PASS |
| `app.getVersion()` | `0.1.0` | PASS |
| `app.getPath('userData')` | `[Roaming]\OPS Desktop`（真实用户目录） | PASS |
| 窗口 | 1 个；标题 `OPS Desktop — 未登录 · 服务器 AI`；URL `ops-desktop://business/login?next=%2F` | PASS |
| 首屏 | `document.title = AI 内容运营助手`，登录页完整渲染，零白屏/零崩溃 | PASS |
| `getClientDiagnostics()` | `ok: true`，严格 16 键，`appVersion=0.1.0`、`electronVersion=44.9.1`、`platform=win32`、`arch=x64`、`signedIn=false` | PASS |
| 布局 | `scrollWidth 1442 == clientWidth 1442`、`scrollHeight 816 == clientHeight 816`，无横向溢出 | PASS |
| 哨兵 | 存在，SHA-256 `87960cd2…89004` **未变** | PASS |
| 截图 | `02-installed-v010-launch.png`，1803×1020，69,616 字节，仅登录页无账号隐私 | PASS |
| 关闭 | 主窗口 `WM_CLOSE` → 原生确认框 → 真实点击「退出客户端」→ **0 残留进程** | PASS |

- 关闭路径说明：Electron 的 `showMessageBox` 按钮为 `CCPushButton`，UI Automation 报 `Unsupported Pattern`（`InvokePattern` 不可用），改用与真人一致的鼠标点击（按钮中心坐标）完成「退出客户端」，属测试驱动方式差异，**不是产品缺陷**。
- 首启后 `[Roaming]\OPS Desktop` 为 20,669 项（= 原有 20,668 + 哨兵 1），未新增任何 Chromium 缓存文件（既有用户目录本就含缓存）。

## 4. 真实覆盖升级 `0.1.0` → `0.1.1`

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| 升级进程 | `Start-Process -Wait` 返回，用时 **9.0 s** | PASS |
| `app-0.1.0` | 已被 Squirrel 移除 | PASS |
| `[Local]\OPSDesktop\app-0.1.1\OPS Desktop.exe` | 存在 | PASS |
| 注册表 `DisplayVersion` | `0.1.1` | PASS |
| `[Roaming]\OPS Desktop` | 20,669 项，**未减少** | PASS |
| 哨兵 SHA-256 | `87960cd2…89004` **100% 一致** | PASS |
| 既有快捷方式 | 完好（1,230 字节 / 时间戳未变） | PASS |
| 残留进程 | 0 | PASS |

### 4.1 升级后首启 `v0.1.1` 与安装态原生通知

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| `app.getVersion()` | `0.1.1` | PASS |
| `getClientDiagnostics().appVersion` | `0.1.1` | PASS |
| `userData` | `[Roaming]\OPS Desktop`（沿用，未被重置） | PASS |
| 布局 | 1442/1442，无横向溢出 | PASS |
| 截图 | `03-upgraded-v011-launch.png`，1803×1020，69,616 字节 | PASS |
| `Notification.isSupported()` | `true` | PASS |
| `new Notification(...).show()` | `show` 事件真实触发；`failed = null`，无报错/无崩溃 | PASS |
| Toast 窗口 | 顶层 UIA 扫描仅见应用自身窗口，未捕获独立 Toast 窗口（Windows 通知由 Shell 托管且展示时间短） | 如实记录 |
| 通知中心点击跳转 | **未人工点击** | 待人工 10 秒补勾 |
| 关闭 | 原生确认框「退出客户端」→ 0 残留进程 | PASS |

- 截图 01/02/03/04b 的 PNG 字节完全相同（69,616 字节，SHA-256 前 16 位 `59090438C260FE30`），原因是同一登录页、同一窗口尺寸、同一 DPR 下 Chromium 渲染确定性；**版本差异以运行时 `app.getVersion()`、诊断 `appVersion` 与注册表 `DisplayVersion` 为准，不是复用截图**。

## 5. 打包安装态 100% / 125% / 150% DPI

- 使用已安装的 `[Local]\OPSDesktop\app-0.1.1\OPS Desktop.exe`，每档独立临时 `--user-data-dir`，**未触碰真实 `userData`**；逐档干净关闭，0 残留进程。

| 档位 | `window.devicePixelRatio` | `scrollWidth / clientWidth` | 截图尺寸 | 结论 |
| --- | --- | --- | --- | --- |
| `--force-device-scale-factor=1` | **1** | 1440 / 1440 | 1440×900（52,261 字节） | PASS |
| `--force-device-scale-factor=1.25` | **1.25** | 1442 / 1442 | 1803×1020（69,616 字节） | PASS |
| `--force-device-scale-factor=1.5` | **1.5** | 1280 / 1280 | 1920×1020（97,912 字节） | PASS |

- 三档 `document.documentElement.scrollWidth <= clientWidth + 1` 均成立，**无横向溢出**。
- 逐张人工核对 `04a/04b/04c`：自绘标题栏（客户端/编辑/视图）完整可见，登录表单（用户名/密码/邀请码/登录按钮）无裁切、无重叠；150% 档左右分栏按比例收窄但内容完整。
- 证据：`docs/42-evidence/RC-16/04a-dpi-100.png`、`04b-dpi-125.png`、`04c-dpi-150.png`。

## 6. 真实卸载核查

- 命令：`Start-Process -FilePath "[Local]\OPSDesktop\Update.exe" -ArgumentList "--uninstall","-s" -Wait`；退出码 **0**，用时 **1.0 s**；0 个 `Update.exe` / `OPS Desktop.exe` 残留进程。

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| `app-0.1.0` | 已清除 | PASS |
| `app-0.1.1` | 主程序已清除，目录仅剩 `squirrel.exe`（1,899,520 字节） | 如实记录 |
| 其他 Squirrel 残余 | `Update.exe`（1,899,520 字节）与 `.dead`（1 字节）留在 `[Local]\OPSDesktop` | 如实记录（Squirrel 自卸载无法删除运行中的自身） |
| 注册表 `HKCU\...\Uninstall\OPSDesktop` | 已移除 | PASS |
| 桌面 `OPS Desktop.lnk` | 已移除 | PASS |
| 桌面 `OPS Desktop 最新界面.lnk` | **完好保留**（1,230 字节 / `2026-10-17 21:44:29`） | PASS |
| 开始菜单 `Programs\OPS` | 目录仍在，内部快捷方式已移除（空目录） | 如实记录 |
| `[Roaming]\OPS Desktop` | **完整保留**；哨兵 SHA-256 `87960cd2…89004` 100% 一致（符合 `desktop/RELEASE_RUNBOOK.md` 第 37 行的“Windows 可能保留用户目录”口径） | PASS |

- 与开批备份对照（19,373 个原始文件）：**19,372 个仍在**，仅 `Partitions\ops-business-production\DIPS-wal`（Chromium SQLite 临时日志，运行期 checkpoint 后消失）缺失；新增 2 个 `Code Cache\electron-preload` 缓存条目（安装态运行产生）与哨兵本身。
- 对 543 个业务语义相关文件（Local Storage / Network / Preferences / Local State / platform-profiles 等）逐文件 SHA-256 比对：**10 个不一致**，全部是 Chromium 运行态的 LevelDB 追加日志（`000003.log`、`LOG`、`LOG.old`）、`Network Persistent State` 与 Session Storage 日志；**无任何作品、草稿、账号或平台 profile 用户数据丢失**。
- 收尾：仅删除专用哨兵；`[Roaming]\OPS Desktop` 仍有 19,374 个文件（原始 19,373 − 1 个 DIPS-wal + 2 个预加载缓存），哨兵已不存在，既有用户文件零删除。

## 7. 中文长路径 / 大文件附件边界（隔离补测）

- 现有 `g8-system-electron.spec.ts` **不含**中文长路径与超限大文件附件用例；按任务要求在本地临时隔离验证中补测（临时 spec/config 在跑完后立即删除，仓库零残留）。

| 场景 | 构造 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 中文长路径附件 | 路径长度 **186 字符**（12 级中文目录 + `长路径附件.txt`，53 字节） | 附件行 `长路径附件.txt ready` 出现；发送请求 `attachment_ids` 长度 **1** | PASS |
| 超限大文件附件 | 21 MiB `超限大文件附件.pdf`（客户端上限 20 MB） | 明确显示「**文件超过大小限制**」，行标记 `failed`，发送按钮禁用；`POST /api/v1/agent/attachments` 计数 **0**（上传前即拒收） | PASS |

- 隔离用例结果：`1 passed (18.8s)`，原始指标 `{"longPathLength":186,"longPathAccepted":true,"attachmentIdsCount":1,"oversizeRejected":true,"oversizeUploadPostCount":0}`。
- 附注：Windows 传统 260 字符 MAX_PATH 限制内，本用例 186 字符未触发长路径 API；>260 字符场景需系统开启 LongPathsEnabled，未在本批覆盖。

## 8. 真实 Electron 系统集成 E2E

- 前置：`deploy/docker-compose.dev.yml` 的 PostgreSQL `:5440` 原为停止状态，本批 `docker start ops-dev-postgres-1` 启动（healthy）后执行，测完已停回；**未触碰任何 `ops-prod-e2e-*` 容器**。

| 命令 | 归属 project | 实测结果 |
| --- | --- | --- |
| `pnpm exec playwright test --project=desktop-renderer g8-system-electron.spec.ts` | `desktop-renderer` | **2 passed (50.5 s)** |
| `pnpm exec playwright test --project=desktop-windows-electron desktop-window-zoom.spec.ts g8-notifications-electron.spec.ts` | `desktop-windows-electron` | **4 passed (48.5 s)** |

- `g8-system-electron.spec.ts` 实际含 2 例：命令面板/通知空态/主题重载、**G8-09 输入法组字不发送**。G8-09 原始指标：`transport=CDP composition + DOM keyboard event`，20 次采样 p50 `19.8 ms` / p95 `40.7 ms`，组字期间会话写入 **0**，组字结束后普通 Enter 落库 1 条。
- `desktop-window-zoom.spec.ts` 覆盖 Q-27 键盘缩放（Ctrl+= / Ctrl+- / Ctrl+0）。
- `g8-notifications-electron.spec.ts` 覆盖非空通知 SSE、逐条/全部已读、系统拒绝态、桌面通知开关保留、未启用时不派发。
- **诚实口径**：G8-09 为 CDP 组合事件 + DOM `keydown` 的自动化模拟（`isComposing=true` / `keyCode=229`），**不是物理输入法的真实候选窗**；真实搜狗/微软拼音候选窗遮挡与 Enter 选词需人工在安装态再点一次。

## 9. `HC-01~31` 核心守卫（T5-1）

- 命令：`cd server; go test ./internal/app -run 'TestHC' -count=1`（本批加 `-v` 取明细）。
- 结果：**37 个用例 PASS / 0 FAIL**，包耗时 **46.176 s**（墙钟 51.4 s），退出码 0。
- HC-01~HC-31 覆盖完整（HC-28 4 例、HC-31 3 例、HC-02 2 例，其余各 1 例）。

## 10. 未完成 / 仍需人工的项

1. **真实物理输入法**：安装态下用搜狗/微软拼音实际组合输入，确认候选窗不遮挡、Enter 选词不误发送（自动化仅覆盖 `isComposing/keyCode=229` 事件路径）。
2. **通知中心点击跳转**：安装态 Toast 已真实 `show`，但未人工点通知中心条目验证跳转（待 10 秒人工补勾）。
3. **商业代码签名**：两个 `Setup.exe` 均 `NotSigned`，不满足 `RELEASE_RUNBOOK.md` 发布门槛。
4. **macOS**：仍仅有静态排查，未实际打包/签名/公证。
5. **Squirrel 卸载残余**：`[Local]\OPSDesktop` 保留 `Update.exe`、`.dead` 与 `app-0.1.1\squirrel.exe`，属 Squirrel 自卸载常规行为；未手工清理，后续重装前需注意该目录已存在。
6. **>260 字符长路径**：本批仅验证 186 字符中文路径，未开启 Windows LongPathsEnabled 做极限验证。

## 11. 证据列表

| 文件 | 内容 |
| --- | --- |
| `docs/42-evidence/RC-16/run-03b.md` | 本报告 |
| `docs/42-evidence/RC-16/install-upgrade-uninstall.log` | 安装/升级/卸载、注册表、哨兵 SHA-256、DPI、通知、附件、E2E 与 HC 原始摘要 |
| `docs/42-evidence/RC-16/02-installed-v010-launch.png` | 安装态 `v0.1.0` 首启（登录页，脱敏） |
| `docs/42-evidence/RC-16/03-upgraded-v011-launch.png` | 覆盖升级后 `v0.1.1` 首启（登录页，脱敏） |
| `docs/42-evidence/RC-16/04a-dpi-100.png` | 100% DPI |
| `docs/42-evidence/RC-16/04b-dpi-125.png` | 125% DPI |
| `docs/42-evidence/RC-16/04c-dpi-150.png` | 150% DPI |

## 12. 完成前核验（本批实跑值）

- `git status --short`：仅 `docs/42-evidence/RC-16/*`、`docs/42-真实闭环验收总台账.md`、`docs/43-桌面端主攻与全局优化实施方案.md`；`desktop/package.json` 与全部源码零 diff。
- 脱敏检索：按任务书给定的本机用户目录、主机名与应用数据目录关键词，在 `docs/42-evidence/RC-16/*.md|*.log` 检索，**0 命中**。
- `git diff --check` 退出码 0。
- `Get-Process -Name "OPS Desktop"` 为空；`[Roaming]\OPS Desktop\verify03b-upgrade-sentinel.json` 为 `False`；桌面 `OPS Desktop 最新界面.lnk` 为 `True`。
- **未执行 `git commit` / `git push`**。
