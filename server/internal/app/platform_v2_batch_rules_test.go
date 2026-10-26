package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// 批次白名单与 control 校验这一组纯函数决定「客户端发上来的这一批到底能不能进库」，
// 此前在 `*_test.go` 里对 `platformV2StageAllowed`/`platformV2BatchLimits`/
// `platformV2ResultRowCount`/`validatePlatformV2Control`/`isPlatformV2RowValidation`
// 五个函数名全部 0 命中。
//
// 它们判错的后果与崩溃不同：要么把该收的结果判成 409 让 run 卡住（十七点四十五
// 那类"终批被拒、只能等租约过期"），要么把不该收的结果放进去。

// TestPlatformV2StageAllowedMatrix 阶段与结果类型的白名单。
//
// 这是「冻结阶段」的唯一守门人：放行多了会让客户端在 profile 阶段写作品，
// 放行少了会让合法批次被判 409 platform_result_conflict。
func TestPlatformV2StageAllowedMatrix(t *testing.T) {
	allTypes := []string{"account_snapshot", "work_catalog", "work_content", "metrics", "control"}
	// 允许的组合：值是该阶段允许的全部结果类型。
	allowed := map[string][]string{
		"account_sync/profile":    {"account_snapshot", "control"},
		"account_sync/catalog":    {"work_catalog", "metrics", "control"},
		"account_sync/content":    {"work_content", "control"},
		"account_sync/metrics":    {"metrics", "control"},
		"metrics_refresh/metrics": {"metrics", "control"},
	}

	check := func(kind, stage string) {
		key := kind + "/" + stage
		want, hasStage := allowed[key]
		for _, resultType := range allTypes {
			expect := false
			for _, w := range want {
				if w == resultType {
					expect = true
					break
				}
			}
			if got := platformV2StageAllowed(kind, stage, resultType); got != expect {
				t.Fatalf("%s 阶段收 %s 应为 %v，实际 %v", key, resultType, expect, got)
			}
		}
		_ = hasStage
	}

	for _, stage := range []string{"profile", "catalog", "content", "metrics"} {
		check("account_sync", stage)
	}
	check("metrics_refresh", "metrics")

	// metrics_refresh 只有 metrics 一个阶段，其它阶段一律拒绝。
	for _, stage := range []string{"profile", "catalog", "content", ""} {
		for _, resultType := range allTypes {
			if platformV2StageAllowed("metrics_refresh", stage, resultType) {
				t.Fatalf("metrics_refresh 不应允许阶段 %q 的结果 %s", stage, resultType)
			}
		}
	}
	// 未知 kind 与未知 stage 一律拒绝：宁可 409 也不能把结果写进不认识的阶段。
	for _, tc := range []struct{ kind, stage string }{
		{"collect", "metrics"},
		{"account_sync", "unknown"},
		{"account_sync", ""},
		{"", "metrics"},
	} {
		for _, resultType := range allTypes {
			if platformV2StageAllowed(tc.kind, tc.stage, resultType) {
				t.Fatalf("kind=%q stage=%q 不应允许 %s", tc.kind, tc.stage, resultType)
			}
		}
	}
	// 未知结果类型永远拒绝。
	if platformV2StageAllowed("account_sync", "catalog", "unknown_type") {
		t.Fatal("未知结果类型必须被拒")
	}
}

// TestPlatformV2BatchLimitsPerType 每种结果类型的字节上限与行数上限。
//
// 行数上限直接决定「客户端一批塞 26 条目录会不会被拒」；control 的行数上限是 0，
// 若写成 1 会让空行数的终批被误判超限。
func TestPlatformV2BatchLimitsPerType(t *testing.T) {
	cases := []struct {
		resultType string
		maxBytes   int
		maxRows    int
	}{
		{"account_snapshot", platformV2AccountBatchMax, 1},
		{"work_catalog", platformV2AccountBatchMax, platformV2AccountBatchRows},
		{"work_content", platformV2ContentBatchMax, platformV2ContentBatchRows},
		{"metrics", platformV2MetricBatchMax, platformV2MetricBatchRows},
		{"control", platformV2AccountBatchMax, 0},
	}
	for _, tc := range cases {
		gotBytes, gotRows := platformV2BatchLimits(tc.resultType)
		if gotBytes != tc.maxBytes || gotRows != tc.maxRows {
			t.Fatalf("%s 上限应为 (%d,%d)，实际 (%d,%d)", tc.resultType, tc.maxBytes, tc.maxRows, gotBytes, gotRows)
		}
	}
	// 未登记的类型回 (0,0)：调用方靠这个判「result_type 不受支持」。
	for _, resultType := range []string{"", "unknown", "ACCOUNT_SNAPSHOT", "account-snapshot"} {
		if maxBytes, maxRows := platformV2BatchLimits(resultType); maxBytes != 0 || maxRows != 0 {
			t.Fatalf("未登记类型 %q 应回 (0,0)，实际 (%d,%d)", resultType, maxBytes, maxRows)
		}
	}
	// 内容批次必须比目录批次大：正文带 HTML，塞不下会让整批 413。
	if platformV2ContentBatchMax <= platformV2AccountBatchMax {
		t.Fatal("work_content 的字节上限必须大于目录批次")
	}
}

// TestPlatformV2ResultRowCountByType 各类型从 data 里数出来的行数。
//
// 行数被拿去累加 `budget_result_rows` 并与 `platformRunMaxRows` 比较，
// 数错会让 run 提前被判超限，或者让超大批次漏过。
func TestPlatformV2ResultRowCountByType(t *testing.T) {
	cases := []struct {
		name       string
		resultType string
		raw        string
		want       int
		wantErr    bool
	}{
		{"快照恒为 1 行", "account_snapshot", `{"identity_external_account_key":"xhs_user_id:x","observed_at":"2026-10-26T00:00:00Z"}`, 1, false},
		{"目录按 items 计数", "work_catalog", `{"items":[{},{},{}]}`, 3, false},
		{"目录空数组算 0 行", "work_catalog", `{"items":[]}`, 0, false},
		{"正文按 items 计数", "work_content", `{"items":[{},{}]}`, 2, false},
		{"指标按 observations 计数", "metrics", `{"observations":[{}]}`, 1, false},
		{"终批恒为 0 行", "control", `{"state":"complete","observed_at":"2026-10-26T00:00:00Z"}`, 0, false},
		{"未登记类型报错", "unknown", `{}`, 0, true},
		{"空 data 报错", "work_catalog", ``, 0, true},
		{"null data 报错", "work_catalog", `null`, 0, true},
		{"未知字段报错（DisallowUnknownFields）", "work_catalog", `{"items":[],"extra":1}`, 0, true},
		{"两个 JSON 值报错", "control", `{"state":"complete"} {"state":"complete"}`, 0, true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := platformV2ResultRowCount(tc.resultType, json.RawMessage(tc.raw))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("%s 应报错，实际返回 %d 行", tc.resultType, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("%s 不应报错：%v", tc.resultType, err)
			}
			if got != tc.want {
				t.Fatalf("%s 行数应为 %d，实际 %d", tc.resultType, tc.want, got)
			}
		})
	}
}

// TestValidatePlatformV2ControlRejects 终批控制体的取值边界。
//
// control 决定操作终态：state 写错会让操作卡在 queued；reason 不在白名单会让
// 终批被 422（十七点四十五那类"整批被拒、run 只能等租约过期"）。
func TestValidatePlatformV2ControlRejects(t *testing.T) {
	now := time.Now()
	past := now.Add(-time.Minute)
	future := now.Add(48 * time.Hour)
	intPtr := func(v int) *int { return &v }
	strPtr := func(v string) *string { return &v }

	valid := []struct {
		name string
		data platformV2ControlResult
	}{
		{"complete 不带原因", platformV2ControlResult{State: "complete", ObservedAt: past}},
		{"partial 带白名单原因", platformV2ControlResult{State: "partial", Reason: "page_budget", ObservedAt: past}},
		{"unsupported 带原因", platformV2ControlResult{State: "unsupported", Reason: "content_capability_unverified", ObservedAt: past}},
		{"denied 带原因", platformV2ControlResult{State: "denied", Reason: "access_denied", ObservedAt: past}},
		{"unknown 带原因", platformV2ControlResult{State: "unknown", Reason: "network_unavailable", ObservedAt: past}},
		{"complete 带总数与分区", platformV2ControlResult{State: "complete", TotalCount: intPtr(39), Partition: "notes", Consistency: "best_effort", ObservedAt: past}},
		{"partial 带续读页", platformV2ControlResult{State: "partial", Reason: "page_budget", NextPage: intPtr(3), ObservedAt: past}},
		{"observed_at 为零值也接受", platformV2ControlResult{State: "complete"}},
	}
	for _, tc := range valid {
		if err := validatePlatformV2Control(tc.data); err != nil {
			t.Fatalf("%s 应通过校验，实际 %v", tc.name, err)
		}
	}

	invalid := []struct {
		name string
		data platformV2ControlResult
		want string
	}{
		{"state 未登记", platformV2ControlResult{State: "done", Reason: "page_budget"}, "control.state 无效"},
		{"state 为空", platformV2ControlResult{State: ""}, "control.state 无效"},
		{"非 complete 缺原因", platformV2ControlResult{State: "partial"}, "control.reason 不在固定错误目录中"},
		{"非 complete 原因不在白名单", platformV2ControlResult{State: "partial", Reason: "page_repeated"}, "control.reason 不在固定错误目录中"},
		{"total_count 为负", platformV2ControlResult{State: "complete", TotalCount: intPtr(-1)}, "control.total_count 超出范围"},
		{"total_count 超上限", platformV2ControlResult{State: "complete", TotalCount: intPtr(1_000_000_001)}, "control.total_count 超出范围"},
		{"next_page 为 0", platformV2ControlResult{State: "partial", Reason: "page_budget", NextPage: intPtr(0)}, "control.next_page 超出范围"},
		{"next_page 超上限", platformV2ControlResult{State: "partial", Reason: "page_budget", NextPage: intPtr(1_000_001)}, "control.next_page 超出范围"},
		// validPlatformExternalID 只查「非空、≤512 字节、合法 UTF-8、无首尾空白、无 NUL」，
		// 不查平台格式：所以只能用超长/带空白的值触发，而不是"看着不像 ID"。
		{"last_external_id 超长", platformV2ControlResult{State: "partial", Reason: "page_budget", LastExternalID: strPtr(strings.Repeat("a", 513))}, "control.last_external_id 无效"},
		{"last_external_id 带首尾空白", platformV2ControlResult{State: "partial", Reason: "page_budget", LastExternalID: strPtr(" 6a7c6caf0000000000503366 ")}, "control.last_external_id 无效"},
		{"last_external_id 含 NUL", platformV2ControlResult{State: "partial", Reason: "page_budget", LastExternalID: strPtr("6a7c6caf\x00")}, "control.last_external_id 无效"},
		{"partition 未登记", platformV2ControlResult{State: "partial", Reason: "page_budget", Partition: "videos"}, "control.partition 无效"},
		{"consistency 未登记", platformV2ControlResult{State: "partial", Reason: "page_budget", Consistency: "eventual"}, "control.consistency 无效"},
		{"complete 带续读页", platformV2ControlResult{State: "complete", NextPage: intPtr(2)}, "complete control 不能携带续读页"},
		{"observed_at 是未来", platformV2ControlResult{State: "complete", ObservedAt: future}, "control.observed_at 不能是未来时间"},
	}
	for _, tc := range invalid {
		err := validatePlatformV2Control(tc.data)
		if err == nil {
			t.Fatalf("%s 应被拒，实际通过", tc.name)
		}
		api, ok := err.(*APIError)
		if !ok {
			t.Fatalf("%s 应返回 APIError，实际 %T", tc.name, err)
		}
		if api.Status != http.StatusUnprocessableEntity {
			t.Fatalf("%s 应为 422，实际 %d", tc.name, api.Status)
		}
		if api.Message != tc.want {
			t.Fatalf("%s 文案应为 %q，实际 %q", tc.name, tc.want, api.Message)
		}
	}
}

// TestIsPlatformV2RowValidationOnlyAccepts422 行级隔离只对 422 生效。
//
// 判宽了会把 409（主体不一致、授权变化）当成"这一行有问题"吞掉，让真正的
// 冲突变成静默跳过；判窄了会让一行坏数据回滚整批。
func TestIsPlatformV2RowValidationOnlyAccepts422(t *testing.T) {
	if !isPlatformV2RowValidation(validation("字段无效")) {
		t.Fatal("422 应被判为行级校验错误")
	}
	for _, status := range []int{http.StatusBadRequest, http.StatusConflict, http.StatusForbidden, http.StatusInternalServerError} {
		if isPlatformV2RowValidation(apiErr(status, "x", "y")) {
			t.Fatalf("%d 不应被判为行级校验错误", status)
		}
	}
	if isPlatformV2RowValidation(nil) {
		t.Fatal("nil 不是行级校验错误")
	}
	if isPlatformV2RowValidation(validation("a").With(map[string]any{"k": "v"})) != true {
		t.Fatal("带 detail 的 422 仍是行级校验错误")
	}
	// 包装过的 422 也要认：调用链上常常再包一层上下文。
	if !isPlatformV2RowValidation(errWrap(validation("字段无效"))) {
		t.Fatal("包装后的 422 仍应被识别")
	}
}

// errWrap 模拟调用链上包一层错误。
type wrappedError struct{ inner error }

func (w wrappedError) Error() string { return "wrapped: " + w.inner.Error() }
func (w wrappedError) Unwrap() error { return w.inner }

func errWrap(err error) error { return wrappedError{inner: err} }

// TestValidatePlatformV2ControlReasonVocabulary 白名单里的原因必须都能过，白名单外的必须被拒。
//
// 这条防的是"改白名单时漏改一边"：`platformSafeReasons` 与 `validatePlatformV2Control`
// 共用同一张表，但客户端的 `v2ControlReason` 映射出来的是有限几个词。
func TestValidatePlatformV2ControlReasonVocabulary(t *testing.T) {
	for reason := range platformSafeReasons {
		data := platformV2ControlResult{State: "partial", Reason: reason}
		if err := validatePlatformV2Control(data); err != nil {
			t.Fatalf("白名单原因 %q 应通过，实际 %v", reason, err)
		}
	}
	// 客户端历史上真的发过、但不在白名单里的词：必须被拒（这是十七点四十五的现场）。
	for _, reason := range []string{"page_repeated", "collect_failed", "profile_capability_unknown"} {
		if _, ok := platformSafeReasons[reason]; ok {
			t.Fatalf("%q 不应在白名单里（若确实要支持，需要同时改测试与文档）", reason)
		}
		if err := validatePlatformV2Control(platformV2ControlResult{State: "partial", Reason: reason}); err == nil {
			t.Fatalf("白名单外的原因 %q 应被拒", reason)
		}
	}
	// 原因必须非空且非空白：空串已经在上面覆盖，这里确认纯空白也不被当成合法词。
	if err := validatePlatformV2Control(platformV2ControlResult{State: "partial", Reason: "   "}); err == nil {
		t.Fatal("纯空白原因应被拒")
	} else if api, ok := err.(*APIError); ok && !strings.Contains(api.Message, "control.reason") {
		t.Fatalf("文案应指向 control.reason，实际 %q", api.Message)
	}
}
