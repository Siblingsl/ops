package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// TL-02：工具事件业务化投影——domain/object_refs/summary 形状；不泄露 path/params。
func TestTL02ToolObjectRefs(t *testing.T) {
	t.Run("单对象：id+title 提取并带域", func(t *testing.T) {
		content := `{"id":"w-123","title":"城市更新观察","word_count":1200}`
		refs := agentToolObjectRefs(content, "works")
		if len(refs) != 1 {
			t.Fatalf("期望 1 个对象引用，得到 %d：%v", len(refs), refs)
		}
		if refs[0].ID != "w-123" || refs[0].Label != "城市更新观察" || refs[0].Domain != "works" {
			t.Fatalf("引用字段不符：%+v", refs[0])
		}
	})
	t.Run("列表：titles 前 3 个带 id 与名称的对象", func(t *testing.T) {
		content := `{"titles":[{"id":"a","text":"甲"},{"id":"b","text":"乙"},{"id":"c","text":"丙"},{"id":"d","text":"丁"}]}`
		refs := agentToolObjectRefs(content, "writing")
		if len(refs) != 3 {
			t.Fatalf("期望最多 3 个，得到 %d", len(refs))
		}
		if refs[0].Label != "甲" || refs[2].ID != "c" {
			t.Fatalf("提取顺序不符：%+v", refs)
		}
	})
	t.Run("无 id 或无名称的对象不返回", func(t *testing.T) {
		if refs := agentToolObjectRefs(`{"items":[{"id":"a"},{"text":"乙"},{"title":"只有名"},{"name":"无名无id"}]}`, "works"); refs != nil {
			t.Fatalf("无 id/名称对象不应产生引用：%+v", refs)
		}
	})
	t.Run("非 JSON 或纯文本结果不返回", func(t *testing.T) {
		if refs := agentToolObjectRefs("已完成，共 2 处修改", "works"); refs != nil {
			t.Fatalf("纯文本不应产生引用：%+v", refs)
		}
		if refs := agentToolObjectRefs(`{"error":{"code":"x"}}`, "works"); refs != nil {
			t.Fatalf("错误对象不应产生引用：%+v", refs)
		}
	})
	t.Run("引用不含 path/params/密钥形状字段", func(t *testing.T) {
		content := `{"id":"w-1","title":"某作品","path":"/works/w-1","params":{"secret":"token"},"request_id":"r1"}`
		raw, _ := json.Marshal(agentToolObjectRefs(content, "works"))
		for _, banned := range []string{"path", "params", "secret", "request_id"} {
			if strings.Contains(string(raw), banned) {
				t.Fatalf("引用泄露 %s：%s", banned, raw)
			}
		}
	})
	t.Run("历史投影 agentToolCallsOf 带域与 object_refs", func(t *testing.T) {
		calls := []byte(`[{"id":"call-1","name":"works__get"}]`)
		results := map[string]string{"call-1": `{"id":"w-9","title":"回填投影"}`}
		view := agentToolCallsOf(calls, results)
		if len(view) != 1 {
			t.Fatalf("期望 1 行，得到 %d", len(view))
		}
		if view[0].Domain != "works" {
			t.Fatalf("domain 未回填：%+v", view[0])
		}
		if len(view[0].ObjectRefs) != 1 || view[0].ObjectRefs[0].Label != "回填投影" {
			t.Fatalf("object_refs 未投影：%+v", view[0].ObjectRefs)
		}
	})
	t.Run("超长 label 截断到 64 码点", func(t *testing.T) {
		long := strings.Repeat("长", 100)
		refs := agentToolObjectRefs(`{"id":"a","title":"`+long+`"}`, "works")
		if len(refs) != 1 || len([]rune(refs[0].Label)) != 64 {
			t.Fatalf("label 未截断：%d", len([]rune(refs[0].Label)))
		}
	})
}
