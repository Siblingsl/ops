package app

import (
	"os"
	"regexp"
	"testing"
)

// DEV-CU P0-6：契约常量单测（Go 侧），锁定版本字符串并与 TS 侧常量逐字一致。
func TestComputerContractVersion(t *testing.T) {
	const want = "ops-computer/1"
	if ContractVersion != want {
		t.Fatalf("ContractVersion = %q, want %q", ContractVersion, want)
	}
	if ContractVersionErrorCode != "computer_invalid_args" {
		t.Fatalf("ContractVersionErrorCode = %q", ContractVersionErrorCode)
	}
	b, err := os.ReadFile("../../../desktop/src/ipc/computer-contract.ts")
	if err != nil {
		t.Fatalf("读取 TS 契约常量失败: %v", err)
	}
	m := regexp.MustCompile(`CONTRACT_VERSION\s*=\s*'([^']+)'`).FindStringSubmatch(string(b))
	if len(m) < 2 || m[1] != want {
		t.Fatalf("TS CONTRACT_VERSION 与 Go 侧不一致: %v", m)
	}
}
