package app

// DEV-CU P0-6（docs/36 §5）：§4 数据契约版本冻结，D-188，2026-11-12。
// 本文件只声明契约常量，不含执行逻辑；G0 人工批准前不得据此写实现代码
// （docs/34 CF-DESK-02「无契约不写码」）。变更须同步 docs/90 D-188 与 docs/06 §13.1/§13.2。

// ContractVersion 是 §4 全部契约的唯一版本号；须写入所有命令 payload 与回执 result。
const ContractVersion = "ops-computer/1"

// ContractVersionErrorCode 是不认识的契约版本返回的统一错误码（422）。
const ContractVersionErrorCode = "computer_invalid_args"
