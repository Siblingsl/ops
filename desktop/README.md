# OPS Desktop

Windows x64 Electron 客户端。发行版从安装包本地资源加载桌面专用 UI，不加载普通 Web 部署页面；API 与 WebSocket 连接 `https://ops-api.88813888.xyz`。未打包开发版加载本地 Vite 服务并可代理到开发 API。桌面端提供隔离设置窗口、本机模型配置、系统加密存储、独立 WSS 通道、模型能力自检、任务映射草稿与应用、AI 模式切换、设备回收和脱敏诊断导出。未登录时不会建立 WSS 连接或声称 AI 已接通。

- [用户指南](./USER_GUIDE.md)
- [灰度发布与回退操作](./RELEASE_RUNBOOK.md)
- [桌面 UI 本地打包与 API 迁移步骤](../deploy/desktop-api-migration.md)

设置页的“清除此账号本机数据”只删除当前登录账号在本机保存的 AI 配置，并清理当前业务站点的 Cookie、站点存储与缓存后退出登录；不删除线上数据，也不撤销线上设备。多个账号需分别登录清理。Windows 卸载后可能保留用户目录中的应用数据。

桌面业务界面源码与依赖位于 `renderer-src/`，独立于仓库的 `web/`；共用功能的修改需要分别维护。

## 开发

要求 Node.js `22.22.1`、pnpm `10.14.0`。首次安装后可运行：

```powershell
pnpm install --frozen-lockfile
pnpm --dir renderer-src install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm test:renderer
pnpm test:e2e:renderer
pnpm start
```

renderer 单测位于 `renderer-src/tests/`，Playwright 配置与用例分别位于 `renderer-src/playwright.config.ts` 与 `renderer-src/e2e/`。桌面用例使用 5287 / 8287 / 8297 三组端口，不读取 `web/e2e/`，也不依赖 Web 的测试依赖；运行前只需安装 renderer 自身依赖（见上）。`web/` 侧另有独立的 Web 浏览器用例集，两端分别维护。

`pnpm start` 会读取 Windows 当前系统代理，在可用的回环端口启动一份全新的 Vite 前端，让未打包 Electron 加载当前源码中的桌面 UI，并将业务 API 与 WebSocket 默认代理到 `https://ops-api.88813888.xyz`。普通 Web 开发仍默认使用 `localhost:5173` 并代理到 `http://localhost:8080`。需要隔离本地数据时，可在启动 Electron 前设置 `OPS_API_TARGET=http://localhost:8080` 并按仓库根目录说明启动本地 API 和数据库。确需使用其他本地前端服务时，可显式设置 `OPS_DESKTOP_DEV_URL`，地址只接受 localhost、127.0.0.1 或 ::1。打包发行版忽略该变量并固定使用 HTTPS API。已打开的旧客户端不会热切换页面；切换到这套启动方式前需完整退出旧实例，再启动一次。

部分 Windows 机器上 Chromium 的 GPU 进程会在启动阶段反复崩溃（日志 `GPU process exited unexpectedly: exit_code=-1073741819`，随后 `GPU process isn't usable. Goodbye.`），表现为双击后没有任何窗口。这类环境可用两个启动前生效的环境变量降级：

```powershell
$env:OPS_DESKTOP_NO_SANDBOX = '1'   # 关闭渲染进程沙箱（GPU 沙箱受限的环境）
$env:OPS_DESKTOP_DISABLE_GPU = '1'  # 关闭硬件加速（显卡驱动不兼容的环境）
pnpm start
```

两者都是安全/性能降级，默认关闭，只在确认环境受限时使用。另外，业务窗口在 `did-finish-load` 后 2.5 秒做一次渲染检查；若渲染进程无响应，检查 6 秒后超时，窗口创建 20 秒后仍未显示则弹出失败窗口，不会停留在无提示的白屏。


模型 API Key 与手动代理认证仅由主进程使用 Electron `safeStorage` 加密保存，设置页面只收到掩码状态。模型服务地址限制为 HTTPS 公网或本机回环地址；公网 AI API 支持系统代理、手动 HTTP(S) 代理或直连，回环目标强制直连。代理 CONNECT 使用本机已校验的目标 IP，TLS 仍校验原域名；不支持 SOCKS、无法验证目标 IP 的远端 DNS 代理或代理失败后的自动直连。模型 API 的手动代理凭证只发往 HTTPS 代理；HTTP 代理仅允许回环地址。系统代理认证无法从 Electron 解析结果取得；模型 API 可改用手动代理凭证，WSS 系统代理须免认证或透明认证，否则连接失败关闭。业务 WSS 跟随系统代理解析，使用相同的目标 IP 固定策略。图片 CDN 必须按精确主机名显式列入配置，图片抓取只接受上一张图片生成响应授权的单个 URL，不跟随重定向，也不发送模型 API Key。

本地映射先保存为草稿，用户确认应用模式时才提交服务端。仅任务映射变化时保留已连接通道：新请求使用新版本；后台 Job 在入队时固定完整映射快照，继续使用原路由。供应商配置版本变化、通道断开、设备撤销或工作区授权收紧会使本机调用失败，不会静默改用服务器模型。通道确需重建且仍有模型请求时，客户端会提示等待，避免切换中断调用。

`pnpm test:e2e` 会启动真实 Electron 主进程与 utility process：用本机 mock 业务页验证远程页面无 Node/IPC 暴露，主帧、iframe、Service Worker 伪造的桌面特权头不会转发；以本机 OpenAI 兼容 mock 验证 AI worker 的回环请求、无鉴权、401、重定向拒绝、跨块密钥回显拦截和响应流；并用当前 `web/dist` 生产 Service Worker 验证 API 不缓存、静态资源缓存和页面头隔离。另有可选的 `OPS_DESKTOP_REAL_ELECTRON_E2E=1 go test ./internal/app -run '^TestDesktopChannelWithRealElectron$' -count=1 -v`，通过隔离 `ops_test` 验证真实 Electron Session 与 Go 鉴权/WSS handler 的集成。以上均为本机测试，不证明生产 HTTPS/WSS、真实公网/本机模型、签名安装或干净 Windows 覆盖升级；当前 Squirrel 制品未签名，自动更新保持关闭。

文件上传 E2E 在真实 Electron 业务窗口通过 CDP 为 `input[type=file]` 设置本机测试文件，并校验 multipart 请求中的文件名与字节内容。它验证文件选择后的上传链路，不替代操作系统原生文件选择对话框的 GUI 验收。

## Windows x64 打包

```powershell
pnpm make
```

Forge 使用 Squirrel.Windows 生成安装制品。当前没有签名凭据；生成的制品**未签名**。自动更新未实现且关闭，发行时使用人工下载和覆盖安装。`out/make/` 内的 `RELEASES` 和 nupkg 仅为 Squirrel 安装包产物，不表示客户端自动更新已启用。
