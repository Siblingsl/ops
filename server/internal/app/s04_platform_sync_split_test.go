package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-S04 片1：编排函数应收口为调用抽出的校验/写入；体积不得回到巨石。
func TestS04SubmitPlatformOrchestratorsStayThin(t *testing.T) {
	for _, tc := range []struct {
		file string
		fn   string
		max  int
		must []string
	}{
		{
			file: "platform_sync_v2_results.go",
			fn:   "func (s *Server) submitPlatformV2ResultBatchTx",
			max:  120,
			must: []string{"validatePlatformV2ResultBatchShape", "applyPlatformV2ResultDataTx"},
		},
		{
			file: "platform_sync.go",
			fn:   "func (s *Server) submitPlatformResults",
			max:  200,
			must: []string{"submitPlatformV2ResultBatchTx", "submitPlatformV1ResultBatchTx"},
		},
	} {
		src, err := os.ReadFile(filepath.Join(".", tc.file))
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		body := string(src)
		start := strings.Index(body, tc.fn)
		if start < 0 {
			t.Fatalf("%s 缺少 %s", tc.file, tc.fn)
		}
		rest := body[start:]
		depth, end := 0, -1
		for i, r := range rest {
			switch r {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					end = i
					break
				}
			}
			if end >= 0 {
				break
			}
		}
		if end < 0 {
			t.Fatalf("%s 无法闭合 %s", tc.file, tc.fn)
		}
		fnBody := rest[:end+1]
		lines := strings.Count(fnBody, "\n") + 1
		if lines > tc.max {
			t.Fatalf("%s %s 仍有 %d 行，上限 %d", tc.file, tc.fn, lines, tc.max)
		}
		for _, needle := range tc.must {
			if !strings.Contains(fnBody, needle) {
				t.Fatalf("%s %s 未调用 %s", tc.file, tc.fn, needle)
			}
		}
	}
}

func TestS04ValidatePlatformV2ResultBatchShapeRejectsV1Mix(t *testing.T) {
	write := platformV2WriteContext{OperationID: uuid.New(), RawBytes: 16}
	err := validatePlatformV2ResultBatchShape(platformResultBatch{
		ProtocolVersion: 2,
		ResultType:      "metrics",
		Data:            []byte(`{"observations":[]}`),
		RunStatus:       platformRunStatusSuccess,
		Observations:    []platformResultRow{{}},
	}, write)
	if err == nil {
		t.Fatal("混用 v1 observations 应拒绝")
	}
}
