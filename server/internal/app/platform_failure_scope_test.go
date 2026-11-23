package app

import (
	"testing"
)

// 41 §3 B-03.6：验证码 / 平台拒绝页只按连接 + 人处理，不能打开版本级熔断。
// 版本级熔断（openAdapterBreaker）只在 platform_schema_changed 时进入；一次风控
// 如果把整版适配器停掉，会把同版本所有连接一起拖下水，且恢复要靠发版。
func TestBrowserChallengeFailureScopeNeverTripsAdapterBreaker(t *testing.T) {
	cases := []struct {
		code  string
		scope runFailureScope
	}{
		{"platform_challenge_required", runFailureAvailability},
		{"platform_blocked", runFailureBlocked},
		{"platform_schema_changed", runFailureBreaker},
		{"platform_login_required", runFailureAvailability},
		{"platform_account_restricted", runFailurePause},
		{"something_unknown", runFailureNone},
	}
	for _, tc := range cases {
		got := classifyRunFailure(tc.code)
		if got != tc.scope {
			t.Fatalf("classifyRunFailure(%q) = %v, want %v", tc.code, got, tc.scope)
		}
		if tc.code != "platform_schema_changed" && got == runFailureBreaker {
			t.Fatalf("%q 不得进入版本级熔断", tc.code)
		}
	}
	// 新错误码必须在服务端的固定目录里，否则终批会被 422 拒绝。
	if !platformResultErrorCodes["platform_blocked"] {
		t.Fatal("platform_blocked 必须登记在 platformResultErrorCodes")
	}
	if failureAvailability("platform_blocked") != "restricted" {
		t.Fatalf("platform_blocked availability = %q, want restricted", failureAvailability("platform_blocked"))
	}
}
