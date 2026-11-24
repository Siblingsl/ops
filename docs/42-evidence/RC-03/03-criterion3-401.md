# RC-03 第 3 条：真实 401 时序录屏

判定：**PARTIAL / 未通过**。已录到真实 401 登录页和用户可见“需要重新登录”提示，但未完成“重新登录成功 → 恢复采集”后半段，不能判 PASS。

## 已取得的真实证据

| 证据 | 内容 | 文件 |
|---|---|---|
| 用户可见提示 | 平台卡片显示“账号同步/指标刷新：平台连接状态为需要重新登录”，无账号昵称 | `00-platform-login-required.png` |
| 真实 401 登录页 | 真实 Chrome 打开 `https://creator.xiaohongshu.com/login?source=&redirectReason=401&lastUrl=%252Fnew%252Fnote-manager`，页面含短信登录框，地址栏可见 `redirectReason=401` | `02-401-landing.png`；视频帧取自录制 160s 处 |
| 真实屏幕录制 | 1920×1080、h264、8fps、1800 秒；覆盖 OPS 页面、真实 Chrome 401 登录页、登录页停留；结束于登录未完成状态 | `02-401-relogin-recovery.mp4`、`02-record-probe.txt`、`02-record.log` |
| 关键帧拼图 | 12 帧（每 150 秒一帧），可见 OPS 页面与 Chrome 401 页交替 | `02-contact-sheet.jpg` |

录制窗口约 `2026-11-23 18:48:44` 至 `19:18:44`（UTC+8，按文件结束时间与 1800 秒时长反推）；401 帧约在 `18:51:24`。时间仅用于定位证据，不作为平台日志时间。

## 时序缺口

实际时序为：

1. 连接会话自然失效，daily collect 报 `platform_login_required`，UI 出现“需要重新登录”提示（已截图）。
2. 通过主进程运行时诊断打开真实 Chrome 401 登录页（已录屏、截图；该动作是运行时诊断，不是产品“重登”入口）。
3. 登录页停在短信登录/等待用户操作，**用户未完成扫码或短信验证码登录**；录制结束时未恢复采集。

因此录屏只覆盖“失效 → 提示 → 401 登录页”，没有覆盖“重新登录 → 恢复采集”。

## 产品入口阻塞（如实登记）

- 桌面端“重登”按钮在当前 dev 构建中点击后跳到 `/settings/local/account-device`，主窗口显示“本机设置正在加载…”，未创建本地设置 `WebContentsView`，`window.open` 返回 null；`showLocalSettingsView` 断点未命中。
- 推断为 React effect 内的 `window.open('ops-desktop://ui/settings/account-device')` 无用户激活被 popup blocker 拦截。当前只以主进程运行时调用 `platformLoginFlow.open` 作诊断绕过，**不能作为产品路径通过证据**。
- 该阻塞已写入 `docs/21` 技术债段，后续需按产品缺陷修复“重登”入口并重录完整时序。

## 通过条件（未满足）

- 用户本人完成真实登录（扫码/短信），登录 flow 从 `waiting` 进入成功态；
- OPS UI 从“需要重新登录”恢复为可用，随后触发一次真实采集并成功入库；
- 同一段录屏包含“失效 → 用户可见提示 → 重新登录 → 恢复采集”全序列。

在用户完成真实登录前，本条保持未通过；不得用 401 登录页截图代替恢复段。
