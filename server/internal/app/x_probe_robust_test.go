package app

// 自动鲁棒性探测：从 chi 路由表枚举全部端点，逐个发非法输入，要求永不出现 5xx 或 panic。
// 只在显式 `go test -run TestXProbeRobustness ./internal/app` 时执行，避免影响常规用例的固定夹具。
// 设计约束：
//   - GET 一律可发（无副作用），覆盖随机 UUID、非法 UUID、全零 UUID 与极端查询参数。
//   - 带路径参数的写请求只用随机 UUID，必然命中 404，不会真改数据。
//   - 无路径参数的写请求只发畸形 JSON，在 decode 阶段失败，不进入业务逻辑。

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type probeHit struct {
	method  string
	path    string
	variant string
	status  int
	body    string
}

func (e *testEnv) probeCall(method, path, body string) (int, string) {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	resp := e.request(method, path, rdr, "application/json")
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return resp.StatusCode, string(b)
}

var probeParamRe = regexp.MustCompile(`\{[^}]+\}`)

func probePath(pattern, idValue string) string {
	return probeParamRe.ReplaceAllStringFunc(pattern, func(m string) string {
		name := strings.ToLower(strings.Trim(m, "{}"))
		switch {
		case strings.Contains(name, "token"):
			return "probe-token-" + uuid.NewString()
		case strings.Contains(name, "key"),
			strings.Contains(name, "platform"),
			strings.Contains(name, "type"),
			strings.Contains(name, "task"):
			return "probe-value"
		default:
			return idValue
		}
	})
}

func probeAbbrev(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

func TestXProbeRobustness(t *testing.T) {
	// 手动探针：默认跳过。整包跑时不启动 339 条路由 × 多变体的探测（含会阻塞的流式端点）。
	// 运行：$env:OPS_XPROBE='1'; go test ./internal/app -run TestXProbeRobustness -count=1 -v
	if os.Getenv("OPS_XPROBE") != "1" {
		t.Skip("set OPS_XPROBE=1 to run the robustness probe")
	}
	srv, isRoutes := env.srv.Router().(chi.Routes)
	if !isRoutes {
		t.Fatal("router 不支持 chi.Routes 遍历")
	}
	type route struct{ method, pattern string }
	var routes []route
	if err := chi.Walk(srv, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes = append(routes, route{method, pattern})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].pattern == routes[j].pattern {
			return routes[i].method < routes[j].method
		}
		return routes[i].pattern < routes[j].pattern
	})
	t.Logf("路由总数 %d", len(routes))

	var hits []probeHit
	record := func(h probeHit) {
		hits = append(hits, h)
		if h.status >= 500 {
			t.Errorf("5xx：%s %s [%s] => %d %s", h.method, h.path, h.variant, h.status, probeAbbrev(h.body))
		}
	}

	// 无路径参数且会真实改变会话/工作区状态的端点，探测期间完全跳过。
	dangerous := map[string]bool{
		"/api/v1/auth/logout": true, "/api/v1/auth/reauth": true, "/api/v1/auth/setup": true,
		"/api/v1/auth/register": true, "/api/v1/auth/login": true, "/api/v1/auth/password": true,
		"/api/v1/workspaces/current/leave": true, "/api/v1/workspaces/current/transfer": true,
		"/api/v1/workspaces/join": true, "/api/v1/demo": true,
	}

	for _, rt := range routes {
		if dangerous[rt.pattern] {
			continue
		}
		// 流式端点（SSE）会一直占住连接，探测必须跳过，否则整包跑到 10 分钟 panic。
		if strings.Contains(rt.pattern, "stream") {
			continue
		}
		if deadline, ok := t.Deadline(); ok && time.Now().After(deadline.Add(-20*time.Second)) {
			t.Logf("探测接近截止时间，提前结束（已探 %d 条路由）", len(hits))
			break
		}
		switch rt.method {
		case http.MethodGet, http.MethodHead:
			for _, idv := range []string{uuid.NewString(), "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
				p := probePath(rt.pattern, idv)
				st, b := env.probeCall(http.MethodGet, p, "")
				record(probeHit{http.MethodGet, p, "id=" + idv, st, b})
			}
			for _, q := range []string{"?limit=-1", "?limit=100000", "?offset=-5", "?page=0", "?days=-30", "?before_seq=-1", "?limit=abc", "?q=%00"} {
				p := probePath(rt.pattern, uuid.NewString()) + q
				st, b := env.probeCall(http.MethodGet, p, "")
				record(probeHit{http.MethodGet, p, "query", st, b})
			}
		default:
			if !strings.Contains(rt.pattern, "{") {
				// 无参数写端点：畸形 JSON 在 decode 阶段失败，不产生副作用。
				for _, bad := range []string{"{", `{"__probe":`, "not json"} {
					st, b := env.probeCall(rt.method, rt.pattern, bad)
					record(probeHit{rt.method, rt.pattern, "badjson", st, b})
				}
				continue
			}
			p := probePath(rt.pattern, uuid.NewString())
			for _, bad := range []string{"{", "null", "[]", `{"__probe":true}`} {
				st, b := env.probeCall(rt.method, p, bad)
				record(probeHit{rt.method, p, "body=" + bad, st, b})
			}
		}
	}

	byStatus := map[int]int{}
	for _, h := range hits {
		byStatus[h.status]++
	}
	keys := make([]int, 0, len(byStatus))
	for k := range byStatus {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	t.Logf("探测请求 %d 次，状态分布：", len(hits))
	for _, k := range keys {
		t.Logf("  %d => %d", k, byStatus[k])
	}

	var b strings.Builder
	fivexx := 0
	for _, h := range hits {
		if h.status >= 500 {
			fivexx++
			fmt.Fprintf(&b, "%s %s [%s] => %d %s\n", h.method, h.path, h.variant, h.status, probeAbbrev(h.body))
		}
	}
	if fivexx > 0 {
		t.Logf("FIVEX_COUNT=%d\nFIVEX_LIST_BEGIN\n%sFIVEX_LIST_END", fivexx, b.String())
	} else {
		t.Logf("FIVEX_COUNT=0")
	}

	// 把明细写成 JSON 便于外部汇总
	raw, _ := json.Marshal(struct {
		Routes int        `json:"routes"`
		Total  int        `json:"total"`
		Hits   []probeHit `json:"hits"`
	}{len(routes), len(hits), hits})
	t.Logf("PROBE_JSON_LEN=%d", len(raw))
}
