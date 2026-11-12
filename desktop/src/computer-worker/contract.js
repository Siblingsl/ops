'use strict';
// DEV-CU P2-4：worker 侧契约版本常量。
// 必须与 desktop/src/ipc/computer-contract.ts 的 CONTRACT_VERSION 一致，
// 单测会跨文件比对两处字面量 + 服务端常量，任一处漂移即红。

const CONTRACT_VERSION = 'ops-computer/1';

/**
 * 旧 `automation_id` 定位分支保留一个发布周期（§P2-4 回退与完成判据）。
 * 版本升到 ops-computer/2 时自动关闭，避免「删了才发现还有旧调用」。
 */
function legacyAutomationIdAllowed(version = CONTRACT_VERSION) {
  return version === 'ops-computer/1';
}

module.exports = { CONTRACT_VERSION, legacyAutomationIdAllowed };
