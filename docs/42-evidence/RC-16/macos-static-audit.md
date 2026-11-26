本机为 Windows，本清单仅作静态前置排查，未执行 macOS 实际打包。

# macOS 打包适配前置静态排查（RC-16 / VERIFY-03a）

- 基线：`main` / `HEAD = 1a864b44`（2026-11-26）
- 扫描范围：`desktop/forge.config.cjs`、`desktop/package.json`、`desktop/src/**`、`renderer/layout/DesktopTitlebar.tsx`、`renderer/styles/desktop-creative.css`
- 结论：Windows x64 打包链路可产出并启动；**macOS 目前不具备可发布构建条件**。缺口集中在 Forge maker、签名/公证、图标与 bundle id、Windows-only 能力降级、标题栏/菜单/窗口生命周期五类。

## 1. 打包与产物配置缺口

| 项目 | 现状（精确位置） | macOS 需要 | 影响 |
| --- | --- | --- | --- |
| Maker 仅 Windows | `desktop/forge.config.cjs:1`、`desktop/forge.config.cjs:41-46` 仅 `MakerSquirrel` | 增加 `@electron-forge/maker-dmg`、`@electron-forge/maker-zip`，并按 `process.platform` 条件注册 | 在 macOS 执行 `pnpm make` 无 `.dmg` / `.zip` 产物，Squirrel maker 不支持 darwin |
| 架构硬编码 x64 | `desktop/package.json:23-24` 固定 `--arch=x64` | Apple Silicon 增加 `--arch=arm64`；Intel 保留 x64；或评估 `--universal` | Apple Silicon 只能产出 x64（依赖 Rosetta），不能原生运行 |
| 未设置应用图标 | `desktop/forge.config.cjs:4-7` 的 `packagerConfig` 无 `icon`；仓库未发现 `.icns` 资产 | 增加 `packagerConfig.icon: 'build/icon.icns'`，提供 1024px 源图与 `.icns` | macOS 包使用 Electron 默认图标，Dock/Finder/安装包辨识度与品牌不一致 |
| 未显式设置 bundle id | `desktop/forge.config.cjs:4-7` 无 `appBundleId`；`desktop/src/main.ts:299` 只设 Windows AppUserModelId | 增加 `packagerConfig.appBundleId`（与 Windows Squirrel id 口径统一或明确区分） | macOS 的 userData、Keychain、通知、签名与更新身份不稳定，默认 `com.electron.*` 不宜作为正式 id |
| 无签名/公证配置 | `desktop/forge.config.cjs:4-7` 无 `osxSign` / `osxNotarize` | 增加 Developer ID 签名、hardened runtime、entitlements、notarytool 公证与 staple | Gatekeeper 拦截下载后的 `.dmg` / `.zip`；无法作为对外分发件 |
| 无 macOS 用途说明 | `desktop/forge.config.cjs:4-7` 无 `extendInfo` | 按首发能力补 `NSMicrophoneUsageDescription` 等 Info.plist 键 | 调用麦克风/自动化时系统直接拒绝或崩溃，且无法向用户解释用途 |
| devDependencies 缺 maker | `desktop/package.json:31-39` 仅 `@electron-forge/maker-squirrel` | 增加 `maker-dmg` / `maker-zip`（版本与 Forge 8.0.1 对齐） | 无法在 macOS 出安装包 |
| Squirrel 运行时依赖 | `desktop/package.json:27`、`desktop/src/main.ts:130`、`desktop/src/main.ts:149-153` | macOS 可保留（`electron-squirrel-startup` 在非 Windows 返回 false，实际 no-op）；如追求包体可条件化 | 非阻塞；仅多一个无用依赖与分支 |

## 2. 签名与公证前置清单

1. **证书**：Apple Developer Program 的 `Developer ID Application` 证书导入构建机 Keychain；确认 `security find-identity -v -p codesigning` 可见。
2. **签名配置**：`packagerConfig.osxSign` 指定 identity；`hardenedRuntime: true`；`entitlements` / `entitlementsInherit` 指向 plist；`gatekeeperAssess: false`。
3. **entitlements**：Electron 通常需要 `com.apple.security.cs.allow-jit`、`com.apple.security.cs.allow-unsigned-executable-memory`；若首发语音输入，增加 `com.apple.security.device.audio-input`；若使用 Apple Events 自动化，增加 `com.apple.security.automation.apple-events`。按最小权限逐项确认，不整包放开。
4. **公证**：`packagerConfig.osxNotarize` 使用 notarytool（Apple ID + Team ID，或 App Store Connect API Key）；构建后 `xcrun stapler staple`，并用 `xcrun stapler validate`、`spctl -a -vv`、`codesign --verify --deep --strict` 复核。
5. **内部试用口径**：未签名/未公证包只能用于开发机隔离试用；不得把 `xattr -dr com.apple.quarantine` 之类的本机绕过写成正式分发方案，也不得声称已通过 Gatekeeper。
6. **CI**：签名证书与公证凭据只放 macOS 构建机的 Keychain / CI secret，不进入仓库、日志、截图、evidence。

## 3. Windows-only 能力降级点

| 能力 | Windows 实现（精确位置） | macOS 现状 | 需要动作 |
| --- | --- | --- | --- |
| 本机窗口枚举 / UIA 读取与动作 / 窗口截图 | `desktop/src/computer-worker/native.js:29`、`:69-70`、`:125-126`、`:155-157`、`:202-203`、`:379-380`；`desktop/src/computer-worker/capture.js:92-95`、`:136`；`desktop/src/computer-worker-host.ts:117-119` | 依赖 `powershell`、`System.Windows.Automation`、`user32.dll`、`PrintWindow`；macOS 无这些组件，相关 `computer:list-windows` / `computer:uia-*` / 截图能力会失败 | 用 AXUIElement / ScreenCaptureKit 重做，申请 TCC「辅助功能」「屏幕录制」；未实现前在 macOS 明确置灰或返回 `unsupported_platform`，不得崩溃 |
| 平台浏览器发现与可信校验 | `desktop/src/platform-worker.ts:67-109`、`:111-141`、`:204-215`、`:234-247`；`desktop/src/platform-browser-trust.ts:18`、`:21-25`、`:37-38` | 标准路径均为 Windows `Program Files` / 注册表；可信校验仅 `process.platform === 'win32'` 且只认 Authenticode `O=Google LLC` / `O=Microsoft Corporation`。macOS 仅有 Playwright Chromium 候选（`platform-worker.ts:160-184`），`trustedLoginBrowsers()` 会得到空集 | 增加 macOS `/Applications` 发现；用 `codesign` / `spctl` / Team ID 替代 Authenticode；否则 `selectLoginBrowser` 抛 `platform_browser_unsupported`（`platform-browser-trust.ts:43-46`），公众号/小红书平台登录与发布不可用 |
| 平台浏览器启动环境 | `desktop/src/platform-worker.ts:477-482` 仅传 Windows 系统根目录、临时目录与用户目录等变量 | macOS 缺少 `HOME`、`TMPDIR`、`PATH`、`LANG` 等，Chrome 可能无法正常建 profile / 崩溃 | 按平台补环境变量；macOS 至少 `HOME`、`TMPDIR`、`PATH`、`LANG`、`__CF_USER_TEXT_ENCODING` |
| Native Messaging 注册 | `desktop/src/native-host/register.cjs:4`、`:77`、`:87` 仅写 `HKCU\Software\Google\Chrome\NativeMessagingHosts` | W02 扩展与 native-host 当前不随包分发（`src/` 被 asar 排除）；若未来产品化，macOS 无注册实现 | 若启用扩展宿主，macOS 写 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<host>.json`；否则明确标注该能力不支持 macOS |
| Windows 通知/任务栏身份 | `desktop/src/main.ts:299` `app.setAppUserModelId('com.squirrel.OpsDesktop.OPSDesktop')` | macOS 该 API 为 no-op；通知与 Dock 身份由 bundle id 决定 | 用 `packagerConfig.appBundleId` 固定 macOS 身份；通知权限与系统设置按 bundle 验证 |
| 自绘标题栏与窗口控制 | `desktop/src/main.ts:529-530`（业务窗）、`:1120-1121`（设置窗）使用 `titleBarStyle:'hidden'` + `titleBarOverlay`；`renderer/layout/DesktopTitlebar.tsx:16-24`；`renderer/styles/desktop-creative.css:314-321` 使用 `env(titlebar-area-*)`，回退 `0px/100%/38px` | `titleBarOverlay` 仅 Windows/Linux 生效；macOS 显示原生红黄绿交通灯，但 `env(titlebar-area-x)` 回退 0，左侧菜单可能压住交通灯；设置窗同样 | macOS 使用 `trafficLightPosition` 或给标题栏增加左侧安全区；100% / Retina 缩放下复核不遮挡、不重叠 |
| 应用菜单 | `desktop/src/main.ts:1406-1432` 仅「客户端/编辑/视图」三组；`role:'quit'` 在 `:1426` | macOS 全局菜单栏需要标准 App 菜单（关于/服务/隐藏/隐藏其他/显示全部/退出）与 Window 菜单；当前模板缺少 macOS role，`autoHideMenuBar`（`:531`、`:1118`）在 macOS 也无效 | 按 `process.platform === 'darwin'` 增加标准 role 与 Window 菜单；保留现有中文业务菜单 |
| 窗口生命周期 | `desktop/src/main.ts:475-477` `window-all-closed` 直接 `app.quit()` | macOS 惯例是关闭窗口后应用留在 Dock，点击 Dock 再开窗（已有 `activate` 处理在 `:467-473`） | 明确产品选择：遵循 macOS 保持驻留，或继续退出；若驻留需验证 `activate` 重建窗口与状态恢复 |
| 键盘缩放 | `desktop/src/main.ts:495-517` 自定义 `before-input-event` 只判断 `input.control` | macOS 标准为 Command；菜单 role 已提供缩放，但自定义 Ctrl 逻辑不应在 macOS 生效 | macOS 跳过该自定义 handler 或同时识别 `input.meta`；实测 Cmd +/-/0 |

## 4. 已跨平台、无需因 macOS 重做的部分

- **renderer 资源根**：`desktop/src/main/protocol.ts:290-296` 在打包态使用 `process.resourcesPath/renderer`；与 `desktop/forge.config.cjs:7` 的 `extraResource: ['renderer']` 在 macOS `Contents/Resources/renderer` 布局一致。
- **userData 路径**：`desktop/src/client/config.ts:26`、`desktop/src/platform-profile.ts:56-77`、`desktop/src/mcp-oauth.ts:56-65` 均基于 `app.getPath('userData')`；macOS 会落到 `~/Library/Application Support/OPS Desktop`，无需改代码，但需在验收中记录新路径。
- **自定义协议**：`desktop/src/main.ts:170` 注册 `ops-desktop` 为 privileged scheme，`desktop/src/main/protocol.ts:235-237` 在 session 内 `protocol.handle`；这是进程内协议，不依赖 Info.plist URL Types，macOS 可直接复用。
- **更新检查 / safeStorage / 文件对话框 / shell.openExternal / 单实例 / activate**：均使用 Electron 跨平台 API；macOS 只需按 bundle id 与签名后的权限复核。
- **asar 白名单**：`desktop/forge.config.cjs:25-39` 使用根路径正则，macOS packager 的 asar 路径同样以 `/` 开头，预期一致；仍需在 macOS 产物上重跑一次 asar 审计。
- **Playwright 缓存路径**：`desktop/src/platform-worker.ts:144-156` 已有 `darwin` 分支 `~/Library/Caches/ms-playwright`；`platform-worker.ts:160-184` 已包含 `chrome-mac/Chromium.app/Contents/MacOS/Chromium` 布局。

## 5. macOS 构建前检查清单（未来在 macOS 机器执行）

1. 构建机：Apple Silicon 或 Intel Mac；Xcode Command Line Tools；Node 22.12–24；pnpm 10.14.0；足够磁盘（Electron + 双架构产物）。
2. 配置：补 `icon.icns`、`appBundleId`、`maker-dmg` / `maker-zip`、`osxSign` / `osxNotarize`、`extendInfo`；按首发能力决定麦克风/Apple Events 用途说明。
3. 构建：
   - `cd desktop; pnpm install --frozen-lockfile`
   - `pnpm --dir ../renderer install --frozen-lockfile`
   - `pnpm build:renderer && pnpm build`
   - `pnpm make --arch=arm64` 与 `pnpm make --arch=x64`（或评估 universal）
4. 产物核对：记录 `.dmg` / `.zip` 文件名、字节数、SHA-256；`codesign --verify --deep --strict`、`spctl -a -vv`、`xcrun stapler validate` 全部通过；未签名/未公证包只能标为内部试用。
5. 安装冒烟：挂载 `.dmg` → 拖入 `/Applications` → 首启；核验 `app.isPackaged=true`、`app.getVersion()=0.1.0`、`ops-desktop://business/login` 首屏、`window.opsDesktopUI` 7 项白名单、诊断 16 键、更新状态 9 键、退出确认框。
6. TCC 权限：辅助功能、屏幕录制、麦克风（若首发语音）逐项弹窗与拒绝路径；未授权时相关能力必须明确提示，不得静默崩溃。
7. 显示与输入：Retina / 100% / 125% / 150% 等效缩放、中文 IME、交通灯位置、菜单栏、窗口关闭/驻留行为。
8. 降级声明：`computer:list-windows` / `computer:uia-*` / 窗口截图、平台浏览器可信登录若未实现 macOS 版本，必须在 UI 与文档明确标注「macOS 暂不支持」，不得让用户误以为可用。

## 6. 明确未验证

本清单仅基于 Windows 上的源码与配置静态扫描；**未在 macOS 实机构建、签名、公证、安装、启动**，未验证 Gatekeeper、TCC、Retina/DPI、macOS 中文 IME、Dock/菜单栏、通知与文件对话框。上述任何一项都不能据此宣称 macOS 版本可用或已发布就绪。
