package app

import (
	"encoding/json"
	"strings"
	"testing"

	"ops/internal/ai"
)

// TL-07（38 文档）：审计与脱敏——工具事件、错误、浏览器证据不含 token/cookie/手机号。
func TestTL07Redaction(t *testing.T) {
	t.Run("cookie/session/authorization 键整体脱敏", func(t *testing.T) {
		raw := []byte(`{"cookie":"SID=abc123","Set-Cookie":"sess=xyz","session_id":"s-9","authorization":"Bearer xxx","title":"正常字段"}`)
		out := string(agentRedactJSONBytes(raw, nil))
		for _, banned := range []string{"SID=abc123", "sess=xyz", `"s-9"`, "Bearer xxx"} {
			if strings.Contains(out, banned) {
				t.Fatalf("登录态字段未脱敏，输出含 %s：%s", banned, out)
			}
		}
		if !strings.Contains(out, "正常字段") {
			t.Fatalf("正常字段被误伤：%s", out)
		}
	})
	t.Run("手机号命中疑似敏感检测", func(t *testing.T) {
		if !agentContainsSecret("联系电话 13812345678", nil) {
			t.Fatal("手机号规则未命中")
		}
		// 普通数字（订单号片段）不误伤：13 位编号不以 1[3-9] 开头的手机段形态出现。
		if agentContainsSecret("编号 20261116 共 13 位", nil) {
			t.Fatal("普通长数字被误判为手机号")
		}
	})
	t.Run("tool.ended 事件不含 cookie/手机号", func(t *testing.T) {
		rec := agentToolRecord{
			Raw:     []byte(`{"cookie":"SID=leak","phone":"13998765432","title":"作品甲"}`),
			Summary: "读取 cookie SID=leak 与手机号 13998765432",
		}
		var call ai.ToolCall
		call.ID = "call-tl07"
		call.Function.Name = "works__get"
		redacted := agentRedactJSONBytes(rec.Raw, nil)
		event := agentToolEvent{CallID: call.ID, Name: truncate(agentRedactText(call.Function.Name, nil), 100),
			Status: "done", Summary: truncate(agentRedactText(rec.Summary, nil), 120),
			ObjectRefs: agentToolObjectRefs(string(redacted), "works")}
		blob, _ := json.Marshal(event)
		out := string(blob)
		if strings.Contains(out, "SID=leak") || strings.Contains(out, "13998765432") {
			t.Fatalf("事件泄漏敏感值：%s", out)
		}
	})
	t.Run("浏览器证据隔离标记覆盖 cookie/authorization", func(t *testing.T) {
		if browserEvidenceRedactionState("set-cookie: SID=1") != "quarantined" {
			t.Fatal("cookie 未触发隔离")
		}
		if browserEvidenceRedactionState("authorization: Bearer abc") != "quarantined" {
			t.Fatal("authorization 未触发隔离")
		}
		if browserEvidenceRedactionState("页面标题：城市更新观察") != "clean" {
			t.Fatal("正常标题被误隔离")
		}
	})
}
