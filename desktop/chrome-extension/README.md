# OPS Browser Bridge（DEV-AI27-02 W02 技术验证）

自有 MV3 扩展：在本人日常 Chrome 与 OPS 桌面之间建立受控桥接。**仅执行本包 `background.js` 动作登记表内的动作**（tabs_list / observe / navigate / click / type / extract / screenshot），不接收任意 JS、CDP 方法或远程下发的执行逻辑。W02 为技术验证，不随产品分发。

## 文件

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 声明；`key` 字段由 `register.cjs` 生成固定扩展 ID（公钥，非敏感） |
| `background.js` | service worker：Native Messaging 连接、配对、信封校验（版本/HMAC/seq）、动作分派与回执 |
| `popup.html/js` | 只读展示连接状态、配对短码、最近命令；不做授权动作 |
| `../src/native-host/host.js` | Native Messaging 宿主（Chrome 原生 stdio 模式），转发+校验，不执行业务 |
| `../src/native-host/register.cjs` | 生成 host manifest、`run-host.bat`、HKCU 注册表注册；`--unregister` 撤销 |

## 验证加载步骤（本机自用，开发者模式）

1. `node desktop/src/native-host/register.cjs`（生成/复用扩展 ID、写注册表）
2. Chrome → `chrome://extensions` → 开发者模式 → "加载已解压的扩展程序" → 选择 `desktop/chrome-extension/`
3. 启动 OPS 桌面桥诊断模式：`OPS_DESKTOP_BRIDGE_DIAG=1`（见 `desktop/src/browser-bridge.ts`）
4. 扩展 popup 显示短码 → 在 OPS 诊断窗核对短码并点击"确认配对"（5 分钟有效）
5. 通过诊断窗派发登记动作验证闭环

## 安全边界（W02 范围）

- 配对绑定：宿主实例 ID（`~/.ops-browser-bridge/host-state.json`）+ 扩展实例 ID（`chrome.storage.local`）+ OPS 桥会话；短码只供人工核对，不是认证凭据。
- 信封：`v=1`、类型白名单、配对后 HMAC-SHA256（`seq.type.payload`）+ seq 单调防重放、`deadline_at`、`request_id`。
- 已知限制（如实记录，W04/W05 收敛）：`host_permissions: <all_urls>` 用于验证任意获准站点注入，正式版按站点范围收敛；`session_key` 经本机回环传递并以明文存于宿主与扩展本地（正式版评估 HKDF 挑战派生）；未实现 OPS 服务端租约（W04/W06）。
- 与平台专用采集（docs/20/21）完全隔离：不读取、不接管平台 profile，不复用采集令牌。
