// DEV-CU P0-6（docs/36 §5）：§4 数据契约版本冻结，D-188，2026-11-12。
// 本文件只声明契约常量，不含任何执行逻辑；G0 人工批准前不得据此写实现代码
// （docs/34 CF-DESK-02「无契约不写码」）。变更须同步 docs/90 D-188 与 docs/06 §13.1/§13.2。

/** §4 全部契约的唯一版本号；须写入所有命令 payload 与回执 result。 */
export const CONTRACT_VERSION = 'ops-computer/1' as const;

/** 不认识的契约版本返回 422 `computer_invalid_args`，不降级兼容。 */
export const CONTRACT_VERSION_ERROR_CODE = 'computer_invalid_args' as const;

/** 字段兼容规则（docs/36 P0-6 步骤 3）。 */
export const CONTRACT_COMPAT_POLICY = Object.freeze({
  additiveFieldsOnly: true,
  noSemanticChange: true,
  removalRequiresVersionBump: true,
  removalKeepsReadCompatibilityForOneRelease: true,
} as const);
