# RC-16 / VERIFY-03a：Windows x64 打包与解压态真机冒烟

- 批次：VERIFY-03a（RC-16 上半场）
- 日期：2026-11-26
- 基线：`main` / `HEAD = 1a864b4419234e5cedc080cca31e04642b3ab7e3`（短号 `1a864b44`）
- 工作树：干净（`git status --short --branch` 仅 `## main...origin/main [ahead 4]`）
- 结论：**打包、asar 白名单、renderer 产物、解压态启动/诊断/更新/退出均 PASS；RC-16 仍未闭环**，安装/覆盖升级/卸载与 DPI/IME/通知/中文长路径留待 `VERIFY-03b`。

## 1. 环境与工具链

| 项目 | 实测值 |
| --- | --- |
| OS | Microsoft Windows 11 专业工作站版，10.0.26200（64 位） |
| CPU / 内存 | 11th Gen Intel Core i5-11400H / 12 逻辑处理器 / 15.7 GiB |
| PowerShell | 7.6.4 |
| 构建 Node | v22.22.1（nvm `v22.22.1`） |
| 构建 pnpm | 10.14.0（与 `desktop/package.json` 的 `packageManager` 一致） |
| Electron（devDependency） | 44.9.1 |
| 打包版本 | `0.1.0` |
| 网络变量 | `NO_PROXY=127.0.0.1,localhost,::1`；`no_proxy` 同值；已移除 `ELECTRON_RUN_AS_NODE` |

## 2. 打包前清理与打包结果

- 清理前 `desktop/out` 为 2026-11-22 的历史产物，共 668.24 MiB；`git ls-files desktop/out/` 为空，未被 Git 跟踪。
- 已执行 `Remove-Item -Recurse -Force desktop/out`，确保本次产物 100% 来自 `HEAD = 1a864b44`。
- 命令：`cd desktop; pnpm make`（内部为 `pnpm build:renderer && pnpm build && electron-forge make --arch=x64`）。
- 退出码：`0`；总耗时：`153.3 s`（`02:33`）。
- 构建日志：184 行、29,995 字节；仅 Vite 的 3 条 CSS 优化 warning 与 1 条动态/静态 import warning，无 error / failed，退出码 0。
- 本次 `desktop/out` 合计 170 个文件、701,358,361 字节（668.87 MiB）。

## 3. 产物清单与 SHA-256

| 相对仓库路径 | 字节 | MiB | SHA-256（小写） |
| --- | ---: | ---: | --- |
| `desktop/out/OPS Desktop-win32-x64/OPS Desktop.exe` | 246,588,416 | 235.17 | `62a1be27a24d4478167efc5c56c203edd907c1db2e0c51dc5b5ea2e252c986d5` |
| `desktop/out/make/squirrel.windows/x64/OPS Desktop-0.1.0 Setup.exe` | 155,339,264 | 148.14 | `702e986e82c1a7bf4939fbf49b70ad97605832750935a7e6126888554d2d14ac` |
| `desktop/out/make/squirrel.windows/x64/OPSDesktop-0.1.0-full.nupkg` | 154,590,637 | 147.43 | `bcfaa33f764e36a114777a4683ad16056e6ab5d562b71eff519d1e2d6b868ca7` |
| `desktop/out/make/squirrel.windows/x64/RELEASES` | 81 | 0.00 | `e08ab1ecb6099f1f7efc6fa4227876502568834a4d9b4ccc6a20714a65f2ff83` |

- `RELEASES` 内容：`CFB8F32344E49855E587A9B038A60D14F45F8EDC OPSDesktop-0.1.0-full.nupkg 154590637`（SHA-1 为 Squirrel 自带格式，仅作清单核对，不是发布签名）。
- 文件版本：`Setup.exe` 与解压态 `OPS Desktop.exe` 的 `FileVersion` / `ProductVersion` 均为 `0.1.0`；`ProductName` 分别为 `OPS 线上业务桌面壳` 与 `OPS Desktop`。

## 4. 签名状态（诚实口径）

| 文件 | `Get-AuthenticodeSignature` Status | 说明 |
| --- | --- | --- |
| `OPS Desktop-0.1.0 Setup.exe` | `NotSigned` | 未做代码签名；不满足 `desktop/RELEASE_RUNBOOK.md` 的发布门槛 |
| `OPS Desktop.exe`（解压态） | `NotSigned` | 同上 |

- 本批次未采购/未使用商业代码签名证书，**不冒充已签名**。
- 两条 `StatusMessage` 均为标准未签名文案（`The file <artifact> is not digitally signed...`，路径已脱敏为 `<artifact>`），`SignerCertificate` 为空。
- 当前仅可用于内部开发与隔离试用；按发布手册，正式灰度必须 `Status=Valid` 且发布者证书匹配。内部/个人试用校验方式应理解为 SHA-256 与文件来源核对，不代表 Windows 信任链已通过。

## 5. `resources/app.asar` 防泄漏审计

- 文件：`desktop/out/OPS Desktop-win32-x64/resources/app.asar`，2,451,007 字节。
- 解析方式：纯 Node 读取 asar header JSON（本次 header JSON 起点 offset 16），递归展开条目；不依赖外网 `npx`。
- 条目总数：**198 个文件 / 32 个目录**；未压缩条目合计 2,399,487 字节。
- 顶层仅：`.build/`、`node_modules/`、`public/`，以及 `package.json`、`forge.config.cjs`。
- 必含运行时项 **9/9 命中**：
  - `.build/main.js`
  - `.build/bootstrap.js`
  - `.build/business-ui-preload.js`
  - `.build/ipc/client-diagnostics.js`（POLISH-02）
  - `.build/ipc/update.js`（OPT-E02）
  - `.build/computer-worker/`（目录）
  - `.build/browser-bridge/diagnostics.html`
  - `public/settings/index.html`
  - `package.json`
- 禁含泄漏项 **0 命中**（按 asar 根路径核对，非 `node_modules` 内部同名片段）：
  - 目录：`src/`、`test/`、`chrome-extension/`、`scripts/`、`.playwright-results/`、`.workbuddy-ai/`
  - 文件：`pnpm-lock.yaml`、`tsconfig.json`、`README.md`、`RELEASE_RUNBOOK.md`、`USER_MANUAL.md`
- 额外核对：非 `node_modules` 路径中不存在 `src|test|tests|scripts|chrome-extension` 片段，命中 0。
- 详细逐项日志见 `docs/42-evidence/RC-16/asar-audit.log`。

## 6. `resources/renderer/` 产物核对

- 共 92 个文件、3,283,244 字节（3.13 MiB）。
- `index.html` 与 `assets/*.js` / `assets/*.css` 均存在，时间戳为本次构建 `2026-11-26 12:14:32`。
- 最新功能特征串均命中打包后的 JS bundle：
  - `desktop-client-diagnostics-row` → `assets/Preferences-BZqu0xiM.js`（POLISH-02）
  - `desktop-update-pill` → `assets/Shell-Ce4UdC5Q.js`（OPT-E02）
  - `xhs-manual-fallback-bar` → `assets/xhs-manual-fallback-C4nDChUu.js`（OPT-U03）

## 7. 解压态 `OPS Desktop.exe` 真机启动冒烟

- 驱动方式：临时脚本放在系统临时目录（未写入仓库），复用 `renderer/node_modules/@playwright/test` 的 `_electron.launch`；`executablePath` 指向解压态 `OPS Desktop.exe`，`args` 仅 `--user-data-dir=<临时目录>/userData`（打包态不传 `main.js`）。
- 使用独立临时 userData，**未触碰本机真实用户数据目录**；已移除 `ELECTRON_RUN_AS_NODE`。

| 核验项 | 实测结果 | 判定 |
| --- | --- | --- |
| 主进程启动 / 窗口创建 | 正常；窗口标题 `OPS Desktop — 未登录 · 服务器 AI`；窗口数 1 | PASS |
| 崩溃 / 未捕获异常弹窗 | 未出现崩溃或异常弹窗；首屏完整渲染，非白屏 | PASS |
| `app.isPackaged` | `true` | PASS |
| `app.getVersion()` | `0.1.0`（与 dev 态 Electron `44.9.1` 明确区分） | PASS |
| 实际加载 URL | `ops-desktop://business/login?next=%2F` | PASS |
| 页面标题 / 首屏文案 | `AI 内容运营助手`；登录页「观点是你的，文字一起打磨」「欢迎回来，继续今天的写作」等完整渲染 | PASS |
| 登录态 | 全新临时 userData，**停留在登录页，未伪造已登录** | 如实记录 |
| `typeof window.opsDesktopUI` | `object` | PASS |
| 7 项白名单方法 | `getClientDiagnostics`、`exportClientDiagnostics`、`getUpdateStatus`、`checkUpdate`、`openPlatformLogin`、`setLocalSettingsPanel`、`openXhsManualImageFolder` 均为 `function` | PASS |
| 隔离守卫 | `typeof window.opsDesktopSettings === 'undefined'` | PASS |
| `getClientDiagnostics()` | `ok: true`；严格 16 键；`appVersion=0.1.0`、`platform=win32`、`arch=x64`；无 `apiKey/token/cookie/deviceId/filePath/path/service/nodeVersion/hostname` 等敏感键；无本机路径值 | PASS |
| `getUpdateStatus()` | `ok: true`；严格 9 键；`currentVersion=0.1.0`、`status=idle`、`updateAvailable=false` | PASS |
| 脱敏截图 | `docs/42-evidence/RC-16/01-packaged-unpacked-smoke.png`，1803×1020，69,616 字节；仅登录页，无账号、无本机路径 | PASS |

- 非致命日志说明：两次启动期间仓库根生成过 `debug.log`，仅 4 条 Chromium crashpad `TransactNamedPipe 0xEA` 日志，无崩溃堆栈；窗口与进程均正常。该临时文件已删除，未纳入证据。

诊断摘要原文（脱敏，无路径）：

```json
{"appVersion":"0.1.0","electronVersion":"44.9.1","platform":"win32","arch":"x64","connectionState":"online","mode":"server","channelState":"disconnected","channelMessage":"通道尚未连接","routeRevision":0,"signedIn":false,"reauthRequired":false,"storageAvailable":true,"localConfigAvailable":true,"deviceRegistered":false,"modelCount":0,"activeModelRequests":0}
```

更新状态原文（脱敏）：

```json
{"status":"idle","currentVersion":"0.1.0","latestVersion":"","updateAvailable":false,"releaseNotes":"","downloadUrl":"","sha256":"","checkedAt":null,"error":""}
```

### 关闭路径（重要说明）

- Playwright 的 `app.close()` 在 20 s 内超时；原因不是崩溃，而是应用**故意**在 `before-quit` / 窗口 `close` 中拦截退出并弹出原生确认框「退出 OPS Desktop」（`desktop/src/main.ts:479-487`、`desktop/src/main.ts:684-688`）。自动化直接 `app.close()` 无法越过该人工确认。
- 随后按真实用户路径关闭：向主窗口发送 `WM_CLOSE` → 原生确认框出现 → UI Automation 点击「退出客户端」→ 应用保存/清理后正常退出。
- 结果：4 个 `OPS Desktop` 进程在 5 s 内全部退出，`Get-Process -Name "OPS Desktop"` 返回空；**无残留进程**。该关闭路径判定 PASS（以真实确认框为准，不把 Playwright 超时当作产品缺陷）。

## 8. 本批次未执行 / 留给 VERIFY-03b

1. 系统级**安装**、首启、**覆盖升级**、**卸载**与 `userData` / 登录态 / 平台 profile 保留策略。
2. Windows 100% / 125% / 150% DPI（及多显示器条件允许时）布局与中文 IME（搜狗/微软拼音）组合输入、Enter 选词不误发送。
3. Windows 通知中心 Toast 真实弹出与点击跳转。
4. 中文长路径 / 大文件附件上传与取消边界。
5. 打包安装态跑通 `HC-01~31` 核心守卫（T5-1）。
6. macOS 实际打包、签名、公证与 TCC 权限；本批次仅完成静态排查，见 `docs/42-evidence/RC-16/macos-static-audit.md`。

- `desktop/out/` 已按要求保留在磁盘（被 `.gitignore` 忽略），供 `VERIFY-03b` 直接复用本次 `Setup.exe`、`RELEASES` 与 `.nupkg`。
- 临时驱动目录与临时 userData 在用完证据后删除，未写入仓库。
- 本批次**未执行 `git commit` / `git push`**。

## 9. 证据列表

| 文件 | 内容 |
| --- | --- |
| `docs/42-evidence/RC-16/run-03a.md` | 本报告：基线、环境、产物、SHA-256、签名口径、asar/renderer 摘要、冒烟逐项、关闭路径、剩余缺口 |
| `docs/42-evidence/RC-16/asar-audit.log` | asar 条目总数、必含项、禁含项 0 命中、renderer 特征串、脱敏诊断 JSON |
| `docs/42-evidence/RC-16/macos-static-audit.md` | macOS 打包前置静态排查清单（未执行 macOS 构建） |
| `docs/42-evidence/RC-16/01-packaged-unpacked-smoke.png` | 解压态真机启动脱敏截图（登录页） |
